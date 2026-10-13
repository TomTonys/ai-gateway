'use strict';

const { CustomModelRepo, LogRepo } = require('./db');
const fs = require('fs');
const path = require('path');
const { callProvider, normalizeUsage } = require('./providers/openai');

/**
 * 网关核心：融合模型请求调度
 *
 * 流程:
 *  1. 根据请求中的 model 名找到对应的融合模型
 *  2. 拿到成员列表（按 priority 排序），过滤掉 disabled / inactive 的成员
 *  3. 依次尝试每个成员：
 *     - 如果请求成功 -> 直接流式/非流式透传响应，结束
 *     - 如果请求失败且可重试 -> 记录日志，尝试下一个成员
 *     - 如果请求失败但不可重试（如 400 参数错误）-> 直接返回错误，不尝试后续成员
 *  4. 所有成员都失败 -> 返回 502 聚合错误
 */

/**
 * 日志里请求体/响应体的单字段体积上限（字符数）。
 * 超出则截断并标记，避免超长对话把数据库撑爆。
 * 100KB 足以覆盖绝大多数排查场景（含 base64 图片的请求会明显更大，
 * 因此图片请求通常会被截断——这符合预期，排查时看结构与参数即可）。
 */
const BODY_LIMIT = 100 * 1024;

/** 按上限截断文本，并返回是否发生截断 */
function truncateBody(text, limit = BODY_LIMIT) {
  if (typeof text !== 'string') return { text: '', truncated: false };
  if (text.length <= limit) return { text, truncated: false };
  return {
    text: text.slice(0, limit) + `\n\n...[已截断，原始长度 ${text.length} 字符，上限 ${limit}]`,
    truncated: true,
  };
}

/**
 * 请求快照：记录请求的特征指纹（不记录完整内容，避免隐私/体积），
 * 用于事后排查"是哪个请求特征触发了 400"。
 */
function buildRequestSnapshot(parsed) {
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  let imageCount = 0;
  let contentArrayCount = 0;
  let emptyContentCount = 0;
  for (const m of messages) {
    const c = m && m.content;
    if (Array.isArray(c)) {
      contentArrayCount++;
      for (const part of c) {
        if (part && part.type === 'image_url') imageCount++;
      }
      if (c.length === 0) emptyContentCount++;
    } else if (typeof c === 'string' && c.length === 0) {
      emptyContentCount++;
    }
  }
  return {
    stream: parsed.stream === true,
    msg_count: messages.length,
    image_count: imageCount,
    content_array_count: contentArrayCount,
    empty_content_count: emptyContentCount,
    // 客户端传的额外参数（常见"不认识"的参数是 400 的主要来源）
    extra_params: Object.keys(parsed).filter(k =>
      !['model', 'messages', 'stream'].includes(k)),
  };
}

/**
 * 补齐 tool 消息：OpenAI 兼容 API 要求 assistant.tool_calls 之后必须紧跟
 * role:'tool' 的结果消息，缺了会触发 400 "inference request is invalid"。
 * 此函数就地修复 parsed.messages（不改变原对象引用外的结构，仅插入缺失的 tool 消息）。
 *
 * 规则：遍历消息，若 assistant 消息带 tool_calls，且其后紧跟的消息
 * 不是覆盖到这些 tool_call id 的 role:'tool' 消息，则在其后插入占位
 * tool 消息（content 为 "(missing tool result)"）。
 * @returns {number} 插入的 tool 消息条数
 */
/**
 * 归一化角色名：部分服务端（如 Sensenova/glm-5.2）不认识 OpenAI 新版的
 * 'developer' 角色，收到即 400 "inference request is invalid"。
 * 统一降级为 'system'（语义等价：开发者级系统指令）。
 * @returns {number} 转换条数
 */
function normalizeRoles(messages) {
  if (!Array.isArray(messages)) return 0;
  let converted = 0;
  for (const m of messages) {
    if (m && m.role === 'developer') {
      m.role = 'system';
      converted++;
    }
  }
  return converted;
}

function patchToolMessages(messages) {
  if (!Array.isArray(messages)) return 0;
  let inserted = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0) continue;

    // 收集该 assistant 消息里每个 tool_call 的 id
    const need = new Set(m.tool_calls.map(tc => tc && tc.id).filter(Boolean));
    if (need.size === 0) continue;

    // 向后看：连续的 role:'tool' 消息覆盖了哪些 id
    let j = i + 1;
    const covered = new Set();
    while (j < messages.length) {
      const nm = messages[j];
      if (!nm || nm.role !== 'tool') break;
      if (nm.tool_call_id) covered.add(nm.tool_call_id);
      j++;
    }

    // 缺失的 tool_call id → 在 i+1 位置（原 tool 消息之前）插入占位 tool 消息
    const missing = [...need].filter(id => !covered.has(id));
    if (missing.length > 0) {
      const placeholders = missing.map(id => ({
        role: 'tool',
        tool_call_id: id,
        content: '(missing tool result)',
      }));
      messages.splice(i + 1, 0, ...placeholders);
      inserted += missing.length;
      i += placeholders.length; // 跳过刚插入的，继续向后扫描
    }
  }
  return inserted;
}

async function handleChatCompletion(req, res) {
  let requestBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  const parsed = JSON.parse(requestBody || '{}');
  const requestedModel = parsed.model;
  const stream = parsed.stream === true;
  const snapshot = buildRequestSnapshot(parsed);

  // 归一化角色名 + 补齐缺失的 tool 结果消息（让请求对严格校验的服务端合规）
  const roleConverted = normalizeRoles(parsed.messages);
  const toolPatched = patchToolMessages(parsed.messages);
  if (roleConverted > 0 || toolPatched > 0) {
    // 修复后更新请求体（下游成员将收到归一化后的 messages）
    requestBody = JSON.stringify(parsed);
    if (roleConverted > 0) snapshot.role_converted = roleConverted;
    if (toolPatched > 0) snapshot.tool_patched = toolPatched;
  }

  // 查找融合模型
  const customModel = CustomModelRepo.getByName(requestedModel);
  if (!customModel) {
    return res.status(404).json({
      error: {
        message: `Model "${requestedModel}" not found. Please configure it as a custom/fusion model first.`,
        type: 'model_not_found',
        code: 'model_not_found',
      }
    });
  }

  // 获取可用成员（过滤掉 disabled 和非 active 的模型/供应商）
  const allMembers = CustomModelRepo.getMembers(customModel.id);
  const members = allMembers.filter(m =>
    m.enabled === 1 &&
    m.model_status === 'active' &&
    m.provider_status === 'active'
  );

  if (members.length === 0) {
    return res.status(503).json({
      error: {
        message: `Custom model "${requestedModel}" has no available members. All members are disabled or inactive.`,
        type: 'no_available_models',
        code: 'no_available_models',
      }
    });
  }

  const errors = [];
  const startTime = Date.now();
  // 临时排查钩子：400 失败时把网关实际发给上游的请求体（脱敏 api_key 头之外）
  // 落到 .aigateway_400dump_NNN.json，便于对上游错误精确 diff。排查完可删。
  let dumpSeq = 0;

  for (let i = 0; i < members.length; i++) {
    const member = members[i];
    const memberStart = Date.now();

    const result = await callProvider(member, { body: requestBody, stream });

    const duration = Date.now() - memberStart;

    // 记录"实际发给该上游的请求体"（callProvider 已完成 model 替换 /
    // Responses 格式转换 / null 清洗，展示它才是排查问题的真实依据）
    const sentBody = truncateBody(
      result.sent ? JSON.stringify(result.sent, null, 2) : requestBody
    ).text;

    if (result.ok) {
      if (stream && result.res) {
        // 流式透传 + 边转发边解析 usage（最后一个 chunk 携带 usage，stream_options.include_usage=true）
        // 先建日志拿到 id，透传结束后再回填响应体与 usage
        const log = LogRepo.create({
          custom_model: requestedModel,
          target_model: member.model_name,
          provider_name: member.provider_name,
          status_code: result.status,
          success: true,
          duration_ms: duration,
          error_message: '',
          request_snapshot: snapshot,
          request_body: sentBody,
          response_body: '',
        });

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Gateway-Provider', member.provider_name);
        res.setHeader('X-Gateway-Model', member.model_name);
        res.status(result.status);

        const { usage, streamText } = await pumpStreamWithUsage(result.res, res);
        const truncated = truncateBody(streamText);
        LogRepo.updateResponseBody(log.id, truncated.text);
        LogRecordUsage({ usage });
        return;
      } else {
        // 非流式透传：result.rawText 是上游原始响应文本
        const rawText = result.rawText || '';
        LogRepo.create({
          custom_model: requestedModel,
          target_model: member.model_name,
          provider_name: member.provider_name,
          status_code: result.status,
          success: true,
          duration_ms: duration,
          error_message: '',
          usage: result.usage,
          request_snapshot: snapshot,
          request_body: sentBody,
          response_body: truncateBody(prettyJson(rawText)).text,
        });

        res.setHeader('X-Gateway-Provider', member.provider_name);
        res.setHeader('X-Gateway-Model', member.model_name);
        res.status(result.status);
        // 原样透传上游响应（保持 Content-Type/编码不变）
        res.type(result.headers?.get?.('content-type') || 'application/json').send(rawText);
        return;
      }
    }

    // 失败
    errors.push(result.error);

    // 临时排查钩子：4xx 时 dump 实际发送的请求体（不含敏感头）
    if ((result.status || 0) >= 400 && (result.status || 0) < 500) {
      dumpSeq++;
      const dumpPath = `.aigateway_400dump_${String(dumpSeq).padStart(3, '0')}.json`;
      try {
        const dump = JSON.parse(requestBody || '{}');
        // 脱敏：去掉可能敏感的内容，保留结构与参数名
        delete dump.api_key;
        delete dump.Authorization;
        fs.writeFileSync(dumpPath, JSON.stringify({
          sent_at: new Date().toISOString(),
          target: `${member.provider_name}/${member.model_name}`,
          status: result.status,
          error: result.error,
          body: dump,
        }, null, 2));
        console.log(`[Gateway] 4xx dump -> ${dumpPath}`);
      } catch (e) {
        console.error('[Gateway] dump 失败:', e.message);
      }
    }

    LogRepo.create({
      custom_model: requestedModel,
      target_model: member.model_name,
      provider_name: member.provider_name,
      status_code: result.status || 0,
      success: false,
      duration_ms: duration,
      error_message: result.error || '',
      request_snapshot: snapshot,
      request_body: sentBody,
      response_body: truncateBody(prettyJson(result.rawText || '')).text,
    });

    // 不可重试的错误（如 400 参数错误）—— 直接返回，不尝试后续成员
    if (result.retryable === false) {
      return res.status(result.status || 500).json({
        error: {
          message: result.error,
          type: 'non_retryable_error',
          code: 'non_retryable',
          provider: member.provider_name,
          model: member.model_name,
        }
      });
    }

    // 可重试 —— 继续尝试下一个成员
    console.log(`[Gateway] ${requestedModel} -> ${member.provider_name}/${member.model_name} failed (${result.error}), retrying next member... (${i + 1}/${members.length})`);
  }

  // 所有成员都失败
  const totalDuration = Date.now() - startTime;
  console.error(`[Gateway] All ${members.length} members failed for "${requestedModel}" in ${totalDuration}ms`);

  res.status(502).json({
    error: {
      message: `All upstream models failed for "${requestedModel}". Tried ${members.length} model(s).`,
      type: 'all_upstream_failed',
      code: 'all_upstream_failed',
      details: errors,
      attempted_models: members.map(m => `${m.provider_name}/${m.model_name}`),
    }
  });
}


/**
 * 透传 SSE 流的同时，从 chunk 中捕获 usage，并累积完整响应文本（供日志详情）。
 * 很多 OpenAI 兼容服务端（含 stream_options.include_usage=true 的响应）
 * 会在最后一个 data: chunk 里附带 usage 字段。这里把 usage 与已写入的
 * 透传 buffer 解耦：先读完整个流、一边 res.write 一边解析，结束后把
 * 捕获到的 usage 与完整文本返回给调用方。
 *
 * @returns {Promise<{usage:object|null, streamText:string}>}
 */
async function pumpStreamWithUsage(res, target) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let usage = null;
  let streamText = '';   // 累积完整 SSE 原文（含 data: 前缀），供日志记录
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      target.write(Buffer.from(value));
      const chunkText = decoder.decode(value, { stream: true });
      streamText += chunkText;
      buf += chunkText;
      // 按 SSE 的 event 分割，逐块查找带 usage 的 data 行
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const part of parts) {
        const m = part.match(/^data:\s*(\{.*\})\s*$/m);
        if (m) {
          try {
            const j = JSON.parse(m[1]);
            // chat/completions 流：chunk 顶层带 usage
            if (j && j.usage && typeof j.usage === 'object') usage = j.usage;
            // Responses API 流：response.completed 事件里 response.usage
            if (j && j.type === 'response.completed' && j.response?.usage) usage = j.response.usage;
          } catch {}
        }
      }
    }
  } catch (e) {
    // 客户端断开等
  } finally {
    target.end();
  }
  // 归一化 usage：兼容 chat/completions（prompt_tokens/completion_tokens）
  // 与 Responses API 事件流（input_tokens/output_tokens）两种字段命名
  return { usage: normalizeUsage(usage), streamText };
}

/**
 * 把 usage 写入最近一条日志（流式场景在透传完成后回填）
 */
function LogRecordUsage({ usage }) {
  if (!usage) return;
  LogRepo.updateLastUsage({
    prompt_tokens: usage.prompt_tokens || 0,
    completion_tokens: usage.completion_tokens || 0,
    total_tokens: usage.total_tokens || 0,
    cached_tokens: usage.cached_tokens || 0,
  });
}

/** 若文本是合法 JSON 则美化缩进，否则原样返回（便于日志详情里阅读） */
function prettyJson(text) {
  if (!text) return '';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

module.exports = { handleChatCompletion };
