# AI API Gateway

一个开箱即用的 AI API 网关，支持：

- **多供应商管理**：添加任意 OpenAI 兼容 API 供应商（OpenAI / DeepSeek / 硅基流动 / Ollama / vLLM / 自建等）
- **多模型管理**：每个供应商下可挂多个模型；模型可选 `chat` 或 `responses` 两种上游请求方式（OpenAI Responses API 自动转换）
- **多模态输入**：`/v1/chat/completions` 支持 `image_url` 图片输入（OpenAI 兼容消息格式），网关透传给支持视觉的模型
- **请求体归一化**：自动把 `role: developer` 转换为 `system`、为缺失的 `tool` 结果消息补占位，避免部分严格上游（如 SenseNova）返回 400
- **模型融合 + 自动故障转移**：把多个供应商模型"融合"成一个对外虚拟模型，请求失败时自动按优先级/顺序切换到下一个成员，全失败才返回错误
- **Web 控制台**：浏览器里可视化完成上述所有添加/编辑/成员配置操作
- **OpenAI 兼容接口**：对下游暴露 `/v1/chat/completions` 与 `/v1/models`，客户端只需改 `base_url` 即可接入
- **请求日志 + 统计**：记录每次调用的命中模型、耗时、成败、token（输入/缓存/输出）、请求特征快照（消息数/图片数/异常参数），仪表盘分页展示；支持 Token 消耗统计（按模型/供应商聚合）
- **模型连通性测试**：控制台一键测试模型可达性，结果入库展示

## 技术栈

- Node.js + Express
- SQLite 持久化（`better-sqlite3`，`data/gateway.db`，WAL 模式）；启动时自动一次性迁移旧版 `data/gateway.json`，旧 JSON 文件不再参与读写
  - 要求 Node ≥ 18（better-sqlite3 v11）
  - 原生模块按 Node ABI 分别编译：`npm install` 会自动执行 `native-build.sh`，
    产物存于 `.native/better_sqlite3-node-v<abi>.node`。这样同一份代码在多个
    不同 Node 版本的环境（如宿主机 Node 18 + 容器 Node 24）中共用时，
    各自加载自己的二进制、互不覆盖；手动重建用 `npm run native`
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
   - Base URL **只填到版本号为止**，网关会自动拼接 `/chat/completions` 或 `/responses`：
     - OpenAI：`https://api.openai.com`
     - DeepSeek：`https://api.deepseek.com`
     - 硅基流动：`https://api.siliconflow.cn/v1`
     - 本地 Ollama：`http://127.0.0.1:11434`
2. **添加模型**：控制台 → 模型 → 选择供应商、填供应商侧真实模型名（如 `gpt-4o`、`deepseek-chat`、`THUDM/GLM-4-9B-0414`），可选请求方式（默认 `chat`；上游为 OpenAI Responses API 的选 `responses`，网关自动完成请求体与 usage 字段转换）。
3. **创建融合模型**：控制台 → 融合模型 → 起一个对外虚拟名（如 `my-gpt`），选择重试模式：
   - **按优先级**：`priority` 数字越小越先调用
   - **按顺序**：按成员添加先后顺序调用
4. **配置成员**：给融合模型添加若干模型成员，设置优先级、可单独启用/停用。
5. **调用**：下游客户端把 base_url 指向本网关，`model` 填融合模型名即可（默认融合模型名为 `auto`）。

## 故障转移行为

对 `POST /v1/chat/completions`：

1. 解析请求里的 `model` 字段 → 定位对应融合模型
2. 过滤出「启用 + 模型 active + 供应商 active」的成员，按重试模式排序
3. 依次尝试每个成员：
   - 成功 → 直接透传响应（支持流式/非流式），结束
   - 失败且可重试（5xx / 429 / 网络异常）→ 记录日志，尝试下一个成员
   - 失败且不可重试（400/401/403 等客户端错误）→ 直接返回该错误，不再尝试后续
      （例外：400 且响应体含 image / unsupported / modality / "inference request is invalid" 等关键词时，视为当前成员不支持该请求形态，自动重试下一个成员）
4. 全部失败 → 返回 `502`，聚合所有成员的错误详情

成功/失败均写入请求日志（含 token 用量、请求特征快照），仪表盘与侧边栏统计可见。

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
| GET | `/api/logs?limit=N&offset=M&success=1|0` | 请求日志（分页 + 成败过滤） |
| GET | `/api/logs/stats` | 请求成功/失败统计 |
| GET | `/api/logs/token-stats?days=N` | Token 消耗统计（按模型/供应商聚合） |
| GET | `/api/models/test-results` | 模型连通性测试结果 |
| POST | `/api/models/:id/test` | 单模型连通性测试 |

## 项目结构

```
ai_gateway/
├── server.js                  # 入口：Express + 静态 + 路由挂载
├── native-build.sh            # 为本机 Node 编译 better-sqlite3（按 ABI 存放）
├── src/
│   ├── db.js                  # 持久化层（SQLite + JSON 自动迁移）+ 各 Repository
│   ├── gateway.js             # 故障转移核心逻辑
│   ├── providers/openai.js    # OpenAI 兼容调用适配器
│   └── routes/
│       ├── providers.js       # 供应商/模型 CRUD
│       ├── customModels.js    # 融合模型/成员 CRUD
│       └── gateway.js         # /v1/* 代理 + 日志/统计
├── public/
│   └── index.html             # Web 控制台（Vue3 + Element Plus）
└── data/
    ├── gateway.db             # SQLite 运行时数据库（自动创建）
    ├── gateway.db-wal/shm     # SQLite WAL 附属文件
    └── .migrated-sqlite       # 一次性 JSON→SQLite 迁移标记
```

## 说明 / 限制

- 鉴权：网关目前不校验 `Authorization`，生产环境建议在前面套一层鉴权中间件或反代。
- 数据：SQLite（WAL）单文件存储，崩溃安全；旧版 `data/gateway.json` 会在启动时自动一次性迁移进库，之后不再读写。
- 原生模块：`better-sqlite3` 需与 Node ABI 匹配（要求 Node ≥ 18）。本项目用 `.native/` 按 ABI 存放各自编译的二进制，多个 Node 版本的环境可共存；若某环境启动时提示缺少对应 ABI，在该环境执行 `npm run native` 即可。
- 超时：上游单次请求 120s 超时（`src/providers/openai.js` 可调）。
