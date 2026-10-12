'use strict';

const express = require('express');
const { CustomModelRepo } = require('../db');

const router = express.Router();

/**
 * 网关级健康检查。
 *
 * 与 /health（进程存活）不同：/health 只看进程活着；/api/healthcheck
 * 还探测网关能否真正工作——取所有 active 融合模型里"主模型"
 * （priority 数值最小的成员）做最小请求，判断至少有一条可用链路。
 * 全部主模型都失败时不阻断请求，返回 200 但 status=degraded，
 * 由调用方（监控探针）自行决策告警。
 */
router.get('/api/healthcheck', async (req, res) => {
  const customModels = CustomModelRepo.list()
    .filter(cm => cm.status === 'active')
    .map(cm => ({ cm, members: CustomModelRepo.getMembers(cm.id) }));

  const report = {
    alive: true,
    status: 'ok',
    uptime_sec: Math.round(process.uptime()),
    custom_models: customModels.length,
    primaries: [],
    checked_at: new Date().toISOString(),
  };

  for (const { cm, members } of customModels) {
    const valid = members.filter(m =>
      m.enabled === 1 &&
      m.model_status === 'active' &&
      m.provider_status === 'active' &&
      m.provider_id && m.model_id
    );
    if (valid.length === 0) {
      report.primaries.push({ custom_model: cm.name, provider: null, model: null, ok: false, error: 'no active members' });
      report.status = 'degraded';
      continue;
    }
    // 主模型：priority 数值最小；null 视为 0
    const primary = valid
      .slice()
      .sort((a, b) => (a.priority === null || a.priority === undefined ? 0 : a.priority) - (b.priority === null || b.priority === undefined ? 0 : b.priority))[0];
    const r = await runPrimaryCheck(primary, cm.name);
    report.primaries.push(r);
    if (!r.ok && report.status === 'ok') report.status = 'degraded';
  }

  // 全部主模型失败：仍返回 200（探针语义），status=degraded
  res.json(report);
});

async function runPrimaryCheck(primary, customModelName) {
  const entry = {
    custom_model: customModelName,
    provider: primary.provider_name,
    model: primary.model_name,
    ok: false,
    duration_ms: 0,
    status: 0,
    error: '',
  };

  const { buildChatUrl } = require('../providers/openai');

  const url = buildChatUrl(primary.base_url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000); // 15s 超时（首次冷启动可能较慢）
  const start = Date.now();

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${primary.api_key || ''}`,
      },
      body: JSON.stringify({
        model: primary.model_name,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        max_tokens: 1,
        stream: false,
      }),
      signal: controller.signal,
    });
    entry.duration_ms = Date.now() - start;
    entry.status = res.status;
    if (res.ok) {
      await res.arrayBuffer();
      entry.ok = true;
    } else {
      entry.error = `HTTP ${res.status}`;
    }
  } catch (err) {
    entry.duration_ms = Date.now() - start;
    entry.error = err.name === 'AbortError' ? 'timeout' : err.message;
  } finally {
    clearTimeout(timer);
  }
  return entry;
}

module.exports = router;
