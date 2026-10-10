'use strict';

const express = require('express');
const { LogRepo } = require('../db');
const { handleChatCompletion } = require('../gateway');

const router = express.Router();

// ============================================================
//  Gateway proxy (OpenAI 兼容)
//  POST /v1/chat/completions  ——  对外暴露的统一入口
// ============================================================
router.post('/v1/chat/completions', (req, res) => {
  handleChatCompletion(req, res);
});

// 列出所有 active 的融合模型（模拟 OpenAI 的 /v1/models 接口）
router.get('/v1/models', (req, res) => {
  const { CustomModelRepo } = require('../db');
  const list = CustomModelRepo.list()
    .filter(cm => cm.status === 'active')
    .map(cm => ({
      id: cm.name,
      object: 'model',
      created: 0,
      owned_by: 'gateway',
    }));
  res.json({ object: 'list', data: list });
});

// ============================================================
//  Logs
// ============================================================
router.get('/api/logs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  // success 过滤：'1'=仅成功 / '0'=仅失败 / 缺省=全部
  const success = ('success' in req.query && req.query.success !== '') ? req.query.success : null;
  res.json({ data: LogRepo.list(limit, offset, success), total: LogRepo.count(success) });
});

router.get('/api/stats', (req, res) => {
  res.json({ data: LogRepo.stats() });
});

// Token 消耗统计（支持 ?days=7 时间窗口，0/缺省=全部）
router.get('/api/token-stats', (req, res) => {
  const days = Math.max(0, parseInt(req.query.days) || 0);
  res.json({ data: LogRepo.tokenStats(days) });
});

module.exports = router;
