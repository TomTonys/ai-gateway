'use strict';

/**
 * OpenAI 兼容适配器
 * 负责向供应商发起实际的 chat completion 请求，
 * 支持 streaming 与 non-streaming 两种模式。
 */

/**
 * 判断一个 HTTP 响应是否应被视为"可重试错误"。
 * 4xx 通常是客户端参数错误，不应重试；但有例外：
 *   - 400 + "invalid image"/"unsupported"/"modality"/"multimodal" 等 → 模型不支持该输入格式，应重试到下一个模型
 *   - 400 + "inference request is invalid" / "invalid request" → 可能是请求格式不被当前模型接受，也应重试
 *   - 401/403 认证失败 → 不重试（该供应商的 key 有问题）
 *   - 404 模型不存在 → 不重试
 *   - 413 请求体过大 → 不重试
 * 5xx、429、网络错误应当重试到下一个模型。
 * @param {number} status HTTP 状态码
 * @param {string|null} err 网络层错误消息
 * @param {string|null} body 错误响应体（含具体错误信息，用于判断 400 是否可重试）
 */
function isRetryableError(status, err, body) {
  if (err) return true;                       // 网络层异常
  if (status >= 500) return true;             // 服务端错误
  if (status === 429) return true;            // 限流

  // 4xx 判断：部分 400 错误意味着"这个模型不支持这种输入"，应重试到下一个模型
  if (status === 400 && body) {
    const lower = body.toLowerCase();
    const retryablePatterns = [
      'invalid image', 'unsupported', 'modality', 'multimodal',
      'invalid image_url', 'not supported', 'image',
      'inference request is invalid', 'invalid request',
      'does not support', 'unsupported model',
    ];
    if (retryablePatterns.some(p => lower.includes(p))) return true;
  }

  // 401/403/404/413 等 → 不重试
  if (status >= 400 && status < 500) return false;
  return false;
}

/**
 * 构造请求 URL。
 *
 * base_url 的语义是「填到版本号为止的完整前缀」，由各供应商自己决定，例如：
 *   https://open.bigmodel.cn/api/paas/v4   （智谱，版本含在地址里）
 *   https://token.sensenova.cn/v1           （Sensenova）
 *   https://api.openai.com                  （OpenAI，不带版本号）
 * 网关只在 base_url 后拼端点，不猜测、不改写版本号——上游升到 v5/v6 时，
 * 只需改供应商配置里的 base_url，无需动代码。
 *
 * @param {string} base_url 供应商前缀
 * @param {string} method 请求方式：'chat' → /chat/completions；'responses' → /responses
 */
function buildUrl(base_url, method) {
  const base = (base_url || '').trim().replace(/\/+$/, '');
  return method === 'responses' ? base + '/responses' : base + '/chat/completions';
}

/** 兼容旧调用（providers.js / healthcheck.js 等历史引用） */
const buildChatUrl = (base_url) => buildUrl(base_url, 'chat');

/**
 * 把 chat/completions 风格的请求体转成 Responses API 风格。
 *
 * 网关对外仍是 /v1/chat/completions 协议；仅当某模型选择 responses 请求方式时，
 * 网关内部把请求体转成 Responses 格式发给上游，响应再透传回客户端（上游返回的是
 * Responses 结构，OpenAI 官方客户端可直接使用，网关自身不做二次翻译——
 * 网关的 chat 协议与上游协议由"请求方式"配置解耦）。
 *
 * 转换规则：
 *   - messages[].content（string 或 [{type:'text'/'image_url'}]）→ input
 *   - system 消息提升到 instructions
 *   - max_tokens → max_output_tokens（部分兼容实现两个都认，双写）
 *   - 其余参数（temperature、top_p、response_format 等）原样透传
 */
function toResponsesPayload(payload, model_name) {
  const p = { ...payload };
  p.model = model_name;

  if (Array.isArray(p.messages)) {
    let instructions;
    const items = [];
    for (const msg of p.messages) {
      const role = msg.role;
      const content = msg.content;
      if (role === 'system') {
        const text = typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.map(c => (typeof c === 'string' ? c : (c && (c.text !== undefined ? c.text : c.input_text)) || '')).join('')
            : String(content ?? '');
        instructions = instructions ? `${instructions}\n${text}` : text;
        continue;
      }
      if (typeof content === 'string') {
        items.push({ type: 'message', role, content });
        continue;
      }
      if (Array.isArray(content)) {
        const parts = [];
        for (const c of content) {
          if (c === null || c === undefined) continue;
          if (typeof c === 'string') {
            parts.push({ type: 'input_text', text: c });
          } else if (c.type === 'text' && c.text !== undefined) {
            parts.push({ type: 'input_text', text: c.text });
          } else if (c.type === 'image_url') {
            const url = (c.image_url && c.image_url.url) || c.url || '';
            if (url) {
              const part = { type: 'input_image', image_url: url };
              if (c.image_url && c.image_url.detail) part.detail = c.image_url.detail;
              if (c.filename) part.filename = c.filename;
              parts.push(part);
            }
          }
        }
        items.push({ type: 'message', role, content: parts });
        continue;
      }
      items.push({ type: 'message', role, content: String(content ?? '') });
    }
    p.input = items;
    delete p.messages;
    if (instructions) p.instructions = instructions;
  } else if (p.input === undefined) {
    p.input = [];
  }

  if (p.max_tokens !== undefined) {
    p.max_output_tokens = p.max_output_tokens ?? p.max_tokens;
    // 双写：部分兼容实现只认 max_tokens
    // （max_output_tokens 已设置，max_tokens 保留原值）
  }
  for (const k of Object.keys(p)) if (p[k] === null) delete p[k];
  return p;
}

/**
 * 向单个供应商模型发起请求。
 * @returns {Promise<{ok:boolean, status:number, body:ReadableStream|Buffer, json:object|null, error:string|null}>}
 */
async function callProvider(member, { body, stream }) {
  const { base_url, api_key, model_name, provider_name } = member;
  const method = member.request_method === 'responses' ? 'responses' : 'chat';
  const url = buildUrl(base_url, method);

  // 替换请求体中的 model 为供应商侧真实模型名
  const payload = JSON.parse(body || '{}');

  if (method === 'responses') {
    // Responses API：网关对外是 chat/completions 协议，这里把请求体转成
    // Responses 格式（messages→input，system→instructions，max_tokens→max_output_tokens）。
    // 响应不二次翻译——上游返回 Responses 结构，OpenAI 官方客户端可直接消费。
    const rp = toResponsesPayload(payload, model_name);
    rp.stream = stream;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300000); // 5 分钟超时
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${api_key}`,
        },
        body: JSON.stringify(rp),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) {
        const text = await res.text();
        return {
          ok: false,
          status: res.status,
          headers: res.headers,
          error: `Provider [${provider_name}/${model_name}] returned ${res.status}: ${text.substring(0, 500)}`,
          retryable: isRetryableError(res.status, null, text),
        };
      }
      // 非流式直接取 usage（Responses 结构：usage.input_tokens/output_tokens）
      // 流式由上层边读边解析 response.completed 事件里的 usage
      const usage = stream ? null : await readJsonUsage(res);
      return { ok: true, status: res.status, headers: res.headers, res, usage };
    } catch (err) {
      clearTimeout(timeout);
      return {
        ok: false,
        status: 0,
        error: `Provider [${provider_name}/${model_name}] network error: ${err.message}`,
        retryable: true,
      };
    }
  }

  // ===== chat/completions 路径 =====
  payload.model = model_name;
  if (stream) payload.stream = true;

  // 防御性清洗：部分 OpenAI 兼容服务端（如 token.sensenova.cn）对请求体校验严格，
  // 遇到空 messages、多余的 assistant/tool 轮次等会直接 400，因此发出前做一次规范化：
  //   1. 仅在 messages 缺失/空数组时兜底一条 user 消息；
  //      绝不整体替换非空 messages —— 多模态请求里 content 是数组
  //      （[{type:'text',...},{type:'image_url',image_url:{url:'data:image/...;base64,...'}}]），
  //      任何改写都会破坏图片附件，导致上游报 "content must be string or array"。
  //   2. 去掉 messages 之外的未知字段中值为 null 的项，避免 null 参数触发校验失败
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    payload.messages = [{ role: 'user', content: '' }];
  }
  for (const k of Object.keys(payload)) {
    if (payload[k] === null) delete payload[k];
  }

  // 请求体清洗：补全 stream_options，让流式最后一个 chunk 也能带 usage
  if (stream) payload.stream_options = { ...(payload.stream_options || {}), include_usage: true };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300000); // 5 分钟超时

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${api_key}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const text = await res.text();
      return {
        ok: false,
        status: res.status,
        headers: res.headers,
        error: `Provider [${provider_name}/${model_name}] returned ${res.status}: ${text.substring(0, 500)}`,
        retryable: isRetryableError(res.status, null, text),
      };
    }

    // 非流式：直接读 JSON 拿到 usage（prompt/completion/cached）
    // 流式：保持 res 原样透传；usage 由上层在转发时边读边解析（见 gateway.js）
    const usage = stream ? null : await readJsonUsage(res);
    return {
      ok: true,
      status: res.status,
      headers: res.headers,
      res,
      usage,
    };
  } catch (err) {
    clearTimeout(timeout);
    return {
      ok: false,
      status: 0,
      error: `Provider [${provider_name}/${model_name}] network error: ${err.message}`,
      retryable: true,
    };
  }
}

/**
 * 从非流式 JSON 响应里提取 usage。
 * 不同供应商 usage 字段略有差异，这里做归一化，缺省补 0。
 * @returns {{prompt_tokens:number, completion_tokens:number, total_tokens:number, prompt_tokens_details?:object, cached_tokens:number}|null}
 */
async function readJsonUsage(res) {
  try {
    const json = await res.clone().json();
    const u = json.usage;
    if (!u) return null;
    // chat/completions 风格：prompt_tokens/completion_tokens；Responses 风格：input_tokens/output_tokens
    const details = u.prompt_tokens_details || u.input_tokens_details || {};
    const prompt_tokens = u.prompt_tokens ?? u.input_tokens ?? 0;
    const completion_tokens = u.completion_tokens ?? u.output_tokens ?? 0;
    return {
      prompt_tokens,
      completion_tokens,
      total_tokens: u.total_tokens || prompt_tokens + completion_tokens,
      cached_tokens: details.cached_tokens || u.cached_tokens || 0,
    };
  } catch {
    return null;
  }
}

module.exports = { callProvider, isRetryableError, readJsonUsage, buildUrl, buildChatUrl, toResponsesPayload };
