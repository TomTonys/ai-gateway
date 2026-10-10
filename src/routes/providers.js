'use strict';

const express = require('express');
const { ProviderRepo, ModelRepo } = require('../db');

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
  res.json({ message: 'Model deleted' });
});

module.exports = router;
