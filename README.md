# AI API Gateway

一个开箱即用的 AI API 网关，支持：

- **多供应商管理**：添加任意 OpenAI 兼容 API 供应商（OpenAI / DeepSeek / Ollama / vLLM / 自建等）
- **多模型管理**：每个供应商下可挂多个模型
- **模型融合 + 自动故障转移**：把多个供应商模型"融合"成一个对外虚拟模型，请求失败时自动按优先级/顺序切换到下一个成员，全失败才返回错误
- **Web 控制台**：浏览器里可视化完成上述所有添加/编辑/成员配置操作
- **OpenAI 兼容接口**：对下游暴露 `/v1/chat/completions` 与 `/v1/models`，客户端只需改 `base_url` 即可接入
- **请求日志 + 统计**：记录每次调用的命中模型、耗时、成败，仪表盘展示

## 技术栈

- Node.js + Express
- 纯 JS JSON 文件持久化（`data/gateway.json`），零原生依赖，任意 Node 版本可直接运行
- 前端：Vue 3 + Element Plus（CDN，无构建步骤）

## 快速开始

```bash
cd ai_gateway
npm install
npm start
```

启动后：

| 用途 | 地址 |
|---|---|
| Web 控制台 | http://localhost:3100 |
| 聊天接口（OpenAI 兼容） | `POST http://localhost:3100/v1/chat/completions` |
| 模型列表 | `GET http://localhost:3100/v1/models` |
| 健康检查 | `GET http://localhost:3100/health` |

环境变量 `PORT` 可改端口。

## 使用流程

1. **添加供应商**：控制台 → 供应商 → 填写名称、Base URL、API Key。
   - OpenAI：`https://api.openai.com`
   - DeepSeek：`https://api.deepseek.com`
   - 本地 Ollama：`http://127.0.0.1:11434`
2. **添加模型**：控制台 → 模型 → 选择供应商、填供应商侧真实模型名（如 `gpt-4o`、`deepseek-chat`）。
3. **创建融合模型**：控制台 → 融合模型 → 起一个对外虚拟名（如 `my-gpt`），选择重试模式：
   - **按优先级**：`priority` 数字越小越先调用
   - **按顺序**：按成员添加先后顺序调用
4. **配置成员**：给融合模型添加若干模型成员，设置优先级、可单独启用/停用。
5. **调用**：下游客户端把 base_url 指向本网关，`model` 填融合模型名即可。

## 故障转移行为

对 `POST /v1/chat/completions`：

1. 解析请求里的 `model` 字段 → 定位对应融合模型
2. 过滤出「启用 + 模型 active + 供应商 active」的成员，按重试模式排序
3. 依次尝试每个成员：
   - 成功 → 直接透传响应（支持流式/非流式），结束
   - 失败且可重试（5xx / 429 / 网络异常）→ 记录日志，尝试下一个成员
   - 失败且不可重试（400/401/403 等客户端错误）→ 直接返回该错误，不再尝试后续
4. 全部失败 → 返回 `502`，聚合所有成员的错误详情

成功/失败均写入 `request_logs`，仪表盘与侧边栏统计可见。

## API 参考（控制台后端）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/providers` | 供应商列表 / 创建 |
| GET/PUT/DELETE | `/api/providers/:id` | 供应商 查/改/删 |
| GET/POST | `/api/models` | 模型列表（可按 `provider_id` 过滤）/ 创建 |
| GET/PUT/DELETE | `/api/models/:id` | 模型 查/改/删 |
| GET/POST | `/api/custom-models` | 融合模型列表 / 创建 |
| GET/PUT/DELETE | `/api/custom-models/:id` | 融合模型 查/改/删 |
| GET/POST | `/api/custom-models/:id/members` | 成员列表 / 添加成员 |
| PUT/DELETE | `/api/custom-models/:id/members/:memberId` | 改优先级与启用状态 / 移除成员 |
| GET | `/api/logs?limit=N` | 请求日志 |
| GET | `/api/stats` | 请求统计 |

## 项目结构

```
ai_gateway/
├── server.js                  # 入口：Express + 静态 + 路由挂载
├── src/
│   ├── db.js                  # 持久化层（JSON 文件）+ 各 Repository
│   ├── gateway.js             # 故障转移核心逻辑
│   ├── providers/openai.js    # OpenAI 兼容调用适配器
│   └── routes/
│       ├── providers.js       # 供应商/模型 CRUD
│       ├── customModels.js    # 融合模型/成员 CRUD
│       └── gateway.js         # /v1/* 代理 + 日志/统计
├── public/
│   └── index.html             # Web 控制台（Vue3 + Element Plus）
└── data/
    └── gateway.json           # 运行时数据（自动创建）
```

## 说明 / 限制

- 鉴权：网关目前不校验 `Authorization`，生产环境建议在前面套一层鉴权中间件或反代。
- 数据：JSON 文件适合中小规模配置；若需高并发写入可替换 `src/db.js` 为 SQLite/Postgres（接口已隔离，仅需改这一层）。
- 超时：上游单次请求 120s 超时（`src/providers/openai.js` 可调）。
