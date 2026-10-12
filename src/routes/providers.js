'use strict';

const express = require('express');
const { ProviderRepo, ModelRepo, TestResultRepo } = require('../db');

const router = express.Router();

// ============================================================
//  Providers (供应商)
// ============================================================

// 列表
router.get('/api/providers', (req, res) => {
  res.json({ data: ProviderRepo.list() });
});

// 单条
router.get('/api/providers/:id', (req, res) => {
  const item = ProviderRepo.get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Provider not found' });
  res.json({ data: item });
});

// 创建
router.post('/api/providers', (req, res) => {
  const { name, base_url, api_key, api_type, remark } = req.body;
  if (!name || !base_url) {
    return res.status(400).json({ error: 'name and base_url are required' });
  }
  try {
    ProviderRepo.create({ name, base_url, api_key, api_type, remark });
    res.status(201).json({ message: 'Provider created' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 更新
router.put('/api/providers/:id', (req, res) => {
  const ok = ProviderRepo.update(req.params.id, req.body);
  if (!ok) return res.status(404).json({ error: 'Provider not found' });
  res.json({ message: 'Provider updated' });
});

// 删除
router.delete('/api/providers/:id', (req, res) => {
  const ok = ProviderRepo.delete(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Provider not found' });
  res.json({ message: 'Provider deleted' });
});

// ============================================================
//  Models (供应商下的模型)
// ============================================================

// 列表 — 可按 provider_id 过滤
router.get('/api/models', (req, res) => {
  const providerId = req.query.provider_id;
  const list = ModelRepo.list(providerId);
  res.json({ data: list });
});

// 查询所有测试结果（必须在 /:id 之前声明，否则 "test-results" 会被当成 id）
router.get('/api/models/test-results', (req, res) => {
  res.json({ data: TestResultRepo.all() });
});

// 单条
router.get('/api/models/:id', (req, res) => {
  const item = ModelRepo.get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Model not found' });
  res.json({ data: item });
});

// 创建
router.post('/api/models', (req, res) => {
  const { provider_id, model_name, display_name, remark } = req.body;
  if (!provider_id || !model_name) {
    return res.status(400).json({ error: 'provider_id and model_name are required' });
  }
  try {
    ModelRepo.create({ provider_id, model_name, display_name, remark });
    res.status(201).json({ message: 'Model created' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 更新
router.put('/api/models/:id', (req, res) => {
  const ok = ModelRepo.update(req.params.id, req.body);
  if (!ok) return res.status(404).json({ error: 'Model not found' });
  res.json({ message: 'Model updated' });
});

// 删除
router.delete('/api/models/:id', (req, res) => {
  const ok = ModelRepo.delete(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Model not found' });
  TestResultRepo.remove(req.params.id);
  res.json({ message: 'Model deleted' });
});

// ============================================================
//  Model Connectivity Test (模型连通性测试)
// ============================================================

/**
 * 对单个模型做连通性测试：
 * 发一个极小的 chat completion 请求（不流式），记录耗时与结果。
 * - 成功：ok=true, duration_ms=实际耗时, status=上游HTTP码
 * - 失败：ok=false, status=上游HTTP码或0(网络错误), error=可读原因
 * - 超时：10s 内没响应即视为超时
 */
async function testOneModel(modelId) {
  const m = ModelRepo.get(modelId);
  if (!m) return { model_id: Number(modelId), ok: false, error: 'model not found', duration_ms: 0, status: 0 };
  const provider = m; // ModelRepo.get 已带出 base_url/api_key

  const { buildChatUrl } = require('../providers/openai');
  const url = buildChatUrl(provider.base_url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000); // 10s 超时
  const start = Date.now();

  let result;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.api_key || ''}`,
      },
      body: JSON.stringify({
        model: provider.model_name,
        // 多模态兼容：content 用 OpenAI 规定的数组形式，纯文本模型也接受；
        // 单元素字符串 content 会被部分严格服务端拒（"content must be array"）。
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        max_tokens: 1,
        stream: false,
      }),
      signal: controller.signal,
    });
    const duration_ms = Date.now() - start;
    if (res.ok) {
      await res.arrayBuffer(); // 读完释放
      result = { model_id: m.id, ok: true, duration_ms, status: res.status, error: '' };
    } else {
      const text = (await res.text()).substring(0, 200);
      result = { model_id: m.id, ok: false, duration_ms, status: res.status, error: `HTTP ${res.status}: ${text}` };
    }
  } catch (err) {
    const duration_ms = Date.now() - start;
    const timedOut = err.name === 'AbortError';
    result = {
      model_id: m.id,
      ok: false,
      duration_ms,
      status: 0,
      error: timedOut ? `timeout after 10000ms` : `network error: ${err.message}`,
    };
  } finally {
    clearTimeout(timer);
  }

  TestResultRepo.set(result.model_id, result);
  return result;
}

// 单模型测试
router.post('/api/models/:id/test', async (req, res) => {
  const result = await testOneModel(req.params.id);
  res.json({ data: result });
});

// 测试所有模型（顺序执行，避免并发把上游打挂）
router.post('/api/models/test-all', async (req, res) => {
  const all = ModelRepo.list();
  const results = [];
  for (const m of all) {
    results.push(await testOneModel(m.id));
  }
  res.json({ data: results });
});

module.exports = router;
