'use strict';

/**
 * OpenAI 兼容适配器
 * 负责向供应商发起实际的 chat completion 请求，
 * 支持 streaming 与 non-streaming 两种模式。
 */

/**
 * 判断一个 HTTP 响应是否应被视为"可重试错误"。
 * 4xx（除 429 外）通常是客户端参数错误，不应重试；
 * 5xx、429、网络错误应当重试到下一个模型。
 */
function isRetryableError(status, err) {
  if (err) return true;                       // 网络层异常
  if (status >= 500) return true;             // 服务端错误
  if (status === 429) return true;            // 限流
  if (status >= 400 && status < 500) return false; // 客户端错误不重试
  return false;
}

/**
 * 向单个供应商模型发起请求。
 * @returns {Promise<{ok:boolean, status:number, body:ReadableStream|Buffer, json:object|null, error:string|null}>}
 */
async function callProvider(member, { body, stream }) {
  const { base_url, api_key, model_name, provider_name } = member;

  const url = base_url.replace(/\/+$/, '') + '/v1/chat/completions';

  // 替换请求体中的 model 为供应商侧真实模型名
  const payload = JSON.parse(body || '{}');
  payload.model = model_name;
  if (stream) payload.stream = true;

  // 防御性清洗：部分 OpenAI 兼容服务端（如 token.sensenova.cn）对请求体校验严格，
  // 遇到空 messages、多余的 assistant/tool 轮次等会直接 400，因此发出前做一次规范化：
  //   1. 保证 messages 非空（空则兜底一条 user 消息）
  //   2. 去掉 messages 之外的未知字段中值为 null 的项，避免 null 参数触发校验失败
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    payload.messages = [{ role: 'user', content: '' }];
  } else {
    payload.messages = payload.messages.filter(m => m && typeof m === 'object');
  }
  for (const k of Object.keys(payload)) {
    if (payload[k] === null) delete payload[k];
  }

  // 请求体清洗：补全 stream_options，让流式最后一个 chunk 也能带 usage
  if (stream) payload.stream_options = { ...(payload.stream_options || {}), include_usage: true };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000); // 2 分钟超时

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
        retryable: isRetryableError(res.status, null),
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
    const details = u.prompt_tokens_details || {};
    return {
      prompt_tokens: u.prompt_tokens || 0,
      completion_tokens: u.completion_tokens || 0,
      total_tokens: u.total_tokens || (u.prompt_tokens || 0) + (u.completion_tokens || 0),
      cached_tokens: details.cached_tokens || u.cached_tokens || 0,
    };
  } catch {
    return null;
  }
}

module.exports = { callProvider, isRetryableError, readJsonUsage };
