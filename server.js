'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');

// 确保数据目录存在
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const app = express();
const PORT = process.env.PORT || 3100;

// 中间件
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ type: 'application/json' })); // 允许以原始文本接收

// 静态前端文件
app.use(express.static(path.join(__dirname, 'public')));

// API 路由
app.use(require('./src/routes/providers'));
app.use(require('./src/routes/customModels'));
app.use(require('./src/routes/gateway'));

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// 404 兜底（非 API 路径返回 index.html 用于前端路由）
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/') && !req.path.startsWith('/v1/') && !req.path.startsWith('/health')) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  next();
});

// 全局错误处理
app.use((err, req, res, next) => {
  console.error('[Server Error]', err);
  res.status(500).json({ error: err.message || 'Internal Server Error' });
});

app.listen(PORT, () => {
  console.log('');
  console.log('┌──────────────────────────────────────────┐');
  console.log('│         AI Gateway Started               │');
  console.log('├──────────────────────────────────────────┤');
  console.log(`│  Console:   http://localhost:${PORT}         │`);
  console.log(`│  API:       http://localhost:${PORT}/v1/chat/completions`);
  console.log(`│  Models:    http://localhost:${PORT}/v1/models         │`);
  console.log('└──────────────────────────────────────────┘');
  console.log('');
});

module.exports = app;
