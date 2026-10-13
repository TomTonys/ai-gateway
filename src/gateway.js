'use strict';

const { CustomModelRepo, LogRepo } = require('./db');
const { callProvider, readJsonUsage, normalizeStreamUsage } = require('./providers/openai');

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

async function handleChatCompletion(req, res) {
  const requestBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  const parsed = JSON.parse(requestBody || '{}');
  const requestedModel = parsed.model;
  const stream = parsed.stream === true;
  const snapshot = buildRequestSnapshot(parsed);

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

  for (let i = 0; i < members.length; i++) {
    const member = members[i];
    const memberStart = Date.now();

    const result = await callProvider(member, { body: requestBody, stream });

    const duration = Date.now() - memberStart;

    if (result.ok) {
      // 成功 —— 记录日志并透传响应
      LogRepo.create({
        custom_model: requestedModel,
        target_model: member.model_name,
        provider_name: member.provider_name,
        status_code: result.status,
        success: true,
        duration_ms: duration,
        error_message: '',
        request_snapshot: snapshot,
      });

      if (stream && result.res) {
        // 流式透传 + 边转发边解析 usage（最后一个 chunk 携带 usage，stream_options.include_usage=true）
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Gateway-Provider', member.provider_name);
        res.setHeader('X-Gateway-Model', member.model_name);
        res.status(result.status);

        const usage = await pumpStreamWithUsage(result.res, res);
        LogRecordUsage({ requestedModel, member, duration, usage });
        return;
      } else if (result.res) {
        // 非流式透传
        const json = await result.res.json();
        res.setHeader('X-Gateway-Provider', member.provider_name);
        res.setHeader('X-Gateway-Model', member.model_name);
        res.status(result.status).json(json);
        LogRecordUsage({ requestedModel, member, duration, usage: result.usage });
        return;
      }
    }

    // 失败
    errors.push(result.error);

    LogRepo.create({
      custom_model: requestedModel,
      target_model: member.model_name,
      provider_name: member.provider_name,
      status_code: result.status || 0,
      success: false,
      duration_ms: duration,
      error_message: result.error || '',
      request_snapshot: snapshot,
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
 * 透传 SSE 流的同时，从 chunk 中捕获 usage。
 * 很多 OpenAI 兼容服务端（含 stream_options.include_usage=true 的响应）
 * 会在最后一个 data: chunk 里附带 usage 字段。这里把 usage 与已写入的
 * 透传 buffer 解耦：先读完整个流、一边 res.write 一边解析，结束后把
 * 捕获到的 usage 返回给调用方。
 */
async function pumpStreamWithUsage(res, target) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let usage = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      target.write(Buffer.from(value));
      buf += decoder.decode(value, { stream: true });
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
  // 与 Responses API 事件流（input_tokens/output_tokens，在 response.completed
  // 或带 usage 的 data 事件里）两种字段命名
  if (usage) {
    const details = usage.prompt_tokens_details || usage.input_tokens_details || {};
    const prompt_tokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
    const completion_tokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
    return {
      prompt_tokens,
      completion_tokens,
      total_tokens: usage.total_tokens || prompt_tokens + completion_tokens,
      cached_tokens: details.cached_tokens || usage.cached_tokens || 0,
    };
  }
  return null;
}

/**
 * 把 usage 写入日志（仅成功请求才会调用）
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

module.exports = { handleChatCompletion };
