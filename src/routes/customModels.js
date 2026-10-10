'use strict';

const express = require('express');
const { CustomModelRepo } = require('../db');

const router = express.Router();

// ============================================================
//  Custom Models (融合模型)
// ============================================================

// 列表
router.get('/api/custom-models', (req, res) => {
  res.json({ data: CustomModelRepo.list() });
});

// 单条
router.get('/api/custom-models/:id', (req, res) => {
  const item = CustomModelRepo.get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Custom model not found' });
  res.json({ data: item });
});

// 创建
router.post('/api/custom-models', (req, res) => {
  const { name, description, retry_mode } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }
  try {
    CustomModelRepo.create({ name, description, retry_mode });
    res.status(201).json({ message: 'Custom model created' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 更新
router.put('/api/custom-models/:id', (req, res) => {
  const ok = CustomModelRepo.update(req.params.id, req.body);
  if (!ok) return res.status(404).json({ error: 'Custom model not found' });
  res.json({ message: 'Custom model updated' });
});

// 删除
router.delete('/api/custom-models/:id', (req, res) => {
  const ok = CustomModelRepo.delete(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Custom model not found' });
  res.json({ message: 'Custom model deleted' });
});

// ============================================================
//  Members (融合模型成员管理)
// ============================================================

// 获取某融合模型的成员列表
router.get('/api/custom-models/:id/members', (req, res) => {
  const members = CustomModelRepo.getMembers(req.params.id);
  res.json({ data: members });
});

// 添加成员
router.post('/api/custom-models/:id/members', (req, res) => {
  const { model_id, priority } = req.body;
  if (!model_id) {
    return res.status(400).json({ error: 'model_id is required' });
  }
  try {
    CustomModelRepo.addMember({
      custom_model_id: req.params.id,
      model_id,
      priority,
    });
    res.status(201).json({ message: 'Member added' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 更新成员（优先级/启用状态）
router.put('/api/custom-models/:id/members/:memberId', (req, res) => {
  CustomModelRepo.updateMember(req.params.memberId, req.body);
  res.json({ message: 'Member updated' });
});

// 移除成员
router.delete('/api/custom-models/:id/members/:memberId', (req, res) => {
  const ok = CustomModelRepo.removeMember(req.params.memberId);
  if (!ok) return res.status(404).json({ error: 'Member not found' });
  res.json({ message: 'Member removed' });
});

module.exports = router;
