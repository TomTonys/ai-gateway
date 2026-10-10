'use strict';

const { CustomModelRepo, LogRepo } = require('./db');
const { callProvider } = require('./providers/openai');

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

async function handleChatCompletion(req, res) {
  const requestBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  const parsed = JSON.parse(requestBody || '{}');
  const requestedModel = parsed.model;
  const stream = parsed.stream === true;

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
      });

      if (stream && result.res) {
        // 流式透传
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Gateway-Provider', member.provider_name);
        res.setHeader('X-Gateway-Model', member.model_name);
        res.status(result.status);

        const reader = result.res.body.getReader();
        const pump = async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(Buffer.from(value));
            }
          } catch (e) {
            // 客户端断开等
          } finally {
            res.end();
          }
        };
        pump();
        return;
      } else if (result.res) {
        // 非流式透传
        const json = await result.res.json();
        res.setHeader('X-Gateway-Provider', member.provider_name);
        res.setHeader('X-Gateway-Model', member.model_name);
        res.status(result.status).json(json);
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

module.exports = { handleChatCompletion };
