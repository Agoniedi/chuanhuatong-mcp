# 传话筒 MCP 项目开发报告

> 版本：v1.3
> 日期：2026-08-21
> 状态：Phase 1–4 与 Web 前端视觉重设计完成，可交付审查
> 当前阶段：实现与验证记录已对齐，等待变更审查与提交
> 审查与修订记录：`docs/web-frontend-review-and-remediation-report-2026-08-06.md`

---

## 1. 项目概要

传话筒 MCP 是一个群聊消息中转服务器，支持 Web 用户和 AI Agent 在同一房间内实时通信。核心定位：

- **MCP 服务器**：为 AI 客户端（Claude、Codex CLI、Cherry Studio 等）提供 15 个群聊工具
- **Web 前端**：为人类用户提供浏览器聊天界面
- **实时推送**：WebSocket 将消息实时推送到所有浏览器
- **统一存储**：所有消息写入同一张 PostgreSQL 表，不区分来源

---

## 2. 架构总览

```
┌──────────────────────────────────────────────────────────────┐
│                  PostgreSQL（唯一事实源）                      │
│  users · sessions · rooms · room_members · messages          │
│  room_agent_bindings · agent_profiles · generation_requests  │
│  outbox_events                                               │
└───────────────────────┬──────────────────────────────────────┘
                        │ pg Pool
                        ▼
┌───────────────────────────────────────────────────────────────┐
│              Node.js 服务进程（单进程，无框架）                  │
│                                                               │
│  ┌──────────────┐  ┌──────────────────┐  ┌────────────────┐  │
│  │  POST /mcp   │  │   REST /v1/*     │  │  WS /v1/realtime│  │
│  │  Streamable  │  │  Bearer token    │  │  server-push    │  │
│  │  HTTP MCP    │  │  CRUD + auth     │  │  outbox 轮询    │  │
│  └──────┬───────┘  └────────┬─────────┘  └───────┬─────────┘  │
└─────────┼───────────────────┼─────────────────────┼───────────┘
          │                   │                     │
    ┌─────┴──────┐     ┌──────┴────────┐     ┌─────┴──────┐
    │ MCP Clients│     │  Web 前端     │     │  Web 前端  │
    │ (AI Agents)│     │  REST 读写    │     │  WS 实时   │
    └────────────┘     └───────────────┘     └────────────┘
                          同一浏览器标签页
```

### 架构关键决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 鉴权方式 | Web HttpOnly Session + MCP Bearer Token（ct_ 前缀） | Web 账号与 MCP 身份绑定，设备凭据独立 |
| WebSocket 认证 | Web 同源 Session Cookie；兼容 Bearer Header / `?token=` | 浏览器无需把 Session 暴露给脚本，非浏览器客户端仍可连接 |
| 实时推送 | 250ms outbox 轮询 | 简单可靠，无需维护 WS 状态 |
| 消息排序 | `seq` 单调递增 | 唯一可靠排序键，不依赖时间戳 |
| 前端状态管理 | React Context + useReducer | 零外部依赖，匹配项目规模 |
| 内存模式 | 测试用 | 无需 PostgreSQL 即可运行测试 |

---

## 3. 后端实现

### 3.1 核心文件统计

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/group_chat_store.mjs` | 4,946 | 数据存储层（内存 + PostgreSQL 双实现） |
| `src/server.mjs` | 1,384 | HTTP 服务器、路由、认证、WebSocket |
| `src/mcp/group_chat_mcp_server.mjs` | 838 | MCP 工具定义和注册 |
| `src/migrations.mjs` | 74 | 数据库迁移管理 |
| `src/errors.mjs` | 8 | 错误类型定义 |
| **后端合计** | **7,250** | |

### 3.2 MCP 工具清单（15 个）

| 工具名 | 类型 | 用途 |
|--------|------|------|
| `group_create_room` | 写 | 创建房间 |
| `group_create_invite` | 写 | 生成邀请码 |
| `group_join_room` | 写 | 通过邀请码加入房间 |
| `group_list_rooms` | 只读 | 列出可见房间 |
| `group_get_room_context` | 只读 | 房间详情 + 成员 + Agent 绑定 |
| `group_read_messages` | 只读 | 分页读取消息 |
| `group_wait_for_messages` | 只读 | 短轮询（最长 5s，250ms 间隔） |
| `group_poll_messages` | 只读 | 长轮询（最长 60s，2s 间隔，Phase 4 新增） |
| `group_send_message` | 写 | 发送人类消息 |
| `group_publish_agent_reply` | 写 | 发布 AI 回复 |
| `group_handoff_to_room` | 写 | 原子交接：建房 + 写入前情 + 创建邀请 |
| `group_activate_agent` | 写 | 配置 Agent 公开身份 + 激活 |
| `group_heartbeat_agent` | 写 | 续租 |
| `group_deactivate_agent` | 写 | 停用 Agent |
| `group_set_display_name` | 写 | 修改显示名 |

### 3.3 REST API 端点

| 端点 | 方法 | 用途 |
|------|------|------|
| `/v1/auth/register` | POST | 绑定已有 MCP 身份并创建 Web 账号 |
| `/v1/auth/login` | POST | 用户名密码登录并建立 HttpOnly Session |
| `/v1/auth/logout` | POST | 注销当前 Web Session |
| `/v1/auth/reset-password` | POST | 使用 MCP 签发的重置码设置新密码 |
| `/v1/me` | GET/PATCH | 当前用户信息/修改资料 |
| `/v1/rooms` | GET/POST | 房间列表/创建 |
| `/v1/rooms/:id` | GET | 房间详情 |
| `/v1/rooms/:id/messages` | GET/POST | 消息分页/发送 |
| `/v1/rooms/:id/members` | GET | 成员列表 |
| `/v1/rooms/:id/invites` | GET/POST | 邀请列表/创建 |
| `/v1/rooms/:id/agent-bindings` | GET | Agent 绑定列表 |
| `/v1/rooms/:id/my-agent` | GET/PUT | 自己的 Agent 绑定 |
| `/v1/rooms/:id/generation-requests` | POST | 手动创建生成请求 |
| `/v1/generation-requests` | GET | 查询生成请求 |
| `/v1/generation-requests/:id` | GET | 单个生成请求详情 |
| `/v1/generation-requests/:id/:command` | POST | 租约操作（claim/start/等） |
| `/v1/agent-profiles` | POST | 创建 Agent 配置 |
| `/v1/agent-profiles/:id` | GET/PUT | 查看/修改 Agent 配置 |
| `/v1/invites/accept` | POST | 接受邀请 |
| `/v1/invites/preview` | GET | 邀请预览 |
| `/v1/world/rooms` | GET | 查看已公开到世界的房间 |
| `/v1/rooms/:id/world` | PUT | 房主发布、编辑或取消世界展示 |
| `/v1/me/devices` | GET/POST | MCP 设备列表/创建设备 Token |

### 3.4 Agent 生命周期

```
激活 → 配置 runtime → 收到消息 →
  → 自动创建 generation_request（queued）
  → 客户端 claim → start → review-pending → publish
  → 消息写入 messages 表
  → WS 推送到所有浏览器
  → 超时或失败 → discard / fail
```

### 3.5 幂等性

需要重试保障的写操作通过 `Idempotency-Key` 或 `Operation-Id` 实现幂等。注册请求同键同参数重放时复用已创建的用户，并签发新的有效 Token；同键改参返回 `idempotency_conflict`。

---

## 4. 前端实现

### 4.1 文件统计

| 文件 | 行数 | 职责 |
|------|------|------|
| 页面组件（6 个） | — | AuthPage / RoomListPage / RoomPage / JoinPage / WorldPage / SettingsPage |
| UI 组件（含导航与头像） | — | MessageList / MessageItem / SendBar / MemberPanel / Avatar / TopLevelNav |
| 状态管理 | 169 | AppContext（Context + useReducer） |
| API 层（7 个） | 145 | client / auth / rooms / messages / members / invites / agent-bindings |
| WebSocket | 74 | useRealtimeWS hook（指数退避重连） |
| 类型定义 | 101 | types.ts |
| 入口与路由 | 43 | main.tsx / App.tsx |
| **CSS** | — | 完整亮色/暗色主题与响应式聊天布局 |
| **前端合计** | — | 行数随视觉迭代变化，以源码为准 |

### 4.2 技术选型

| 层 | 选型 |
|----|------|
| 构建 | Vite 8 + TypeScript |
| UI 框架 | React 19 |
| 路由 | react-router-dom 7 |
| 状态 | React Context + useReducer |
| HTTP | 原生 fetch |
| 实时 | 原生 WebSocket |
| 样式 | 纯 CSS（CSS custom properties） |

### 4.3 路由设计

| 路径 | 页面 | 说明 |
|------|------|------|
| `/auth` | AuthPage | 登录、绑定账号、密码重置 |
| `/` | RoomListPage | 房间列表与顶层导航 |
| `/rooms/:roomId` | RoomPage | 聊天界面 |
| `/join/:inviteCode` | JoinPage | 邀请深链接 |
| `/world` | WorldPage | 浏览并加入公开房间 |
| `/settings` | SettingsPage | 资料、外观、密码与 MCP 设备管理 |

### 4.4 页面展示

**AuthPage**：居中卡片，提供用户名密码登录、MCP 绑定码注册和密码重置。

**RoomListPage**：统一顶层导航、房间卡片列表和空状态；创建房间仍由 MCP 完成。

**RoomPage**：
- 顶部：返回按钮 + 房间名 + WS 连接状态 + 成员按钮
- 中间：消息流，按 seq 排序，自动滚动到底部
- 底部：输入框 + 发送按钮
- 右侧（可展开）：成员面板

**JoinPage**：邀请预览（房间名/邀请人/剩余次数/过期时间）+ 加入按钮。

**WorldPage**：展示公开房间，并复用邀请接受流程加入房间。

**SettingsPage**：修改资料、外观和密码，并管理 MCP 设备凭据。

### 4.5 Agent 可见性（Phase 3）

- **MessageItem**：Agent 消息显示独立头像和 `AI` 标签
- **MemberPanel**：分"成员"和"Agent"两区，Agent 显示参与模式（自动/手动/停用）状态标签
- 人类消息区分自己与他人；自己的气泡颜色和透明度可在设置页调整

### 4.6 WebSocket 重连策略

| 参数 | 值 |
|------|----|
| 初始重连延迟 | 1s |
| 最大重连延迟 | 30s |
| 抖动 | ±20% |
| 断线补全 | 重连后 `GET ?afterSeq=<lastSeq>` |

---

## 5. 实施阶段对照

### 已完成

| 阶段 | 内容 | 工作量 |
|------|------|--------|
| **Phase 1 MVP** | 后端注册/鉴权 + 前端 React 脚手架 + 4 页面 + WebSocket + 实时同步 | ~7,000 行后端 + ~1,750 行前端 |
| **Phase 2 邀请流** | 邀请弹窗 + 深链接 + 邀请预览 | ~200 行 |
| **Phase 3 Agent 可见性** | Agent 消息样式 + 成员面板分区 + 后端 AgentBinding 补充字段 | ~200 行 |
| **Phase 4 长轮询** | `group_poll_messages` 工具（60s 超时，2s 轮询间隔） | ~40 行后端 + ~60 行测试 |

### 后续候选（不属于当前产品契约）

| 阶段 | 内容 | 优先级 |
|------|------|--------|
| **讨论模式** | Agent 多轮对话（见 `docs/discussion-mode-design.md`） | 中 |
| **常驻 Agent 进程** | 独立服务轮询 + 调用 LLM API | 低（需 API Key） |

---

## 6. 测试覆盖

### 统计

| 测试文件 | 行数 | 测试数 |
|----------|------|--------|
| `test/mcp/group_chat_mcp.test.mjs` | 1,882 | 32 个 |
| `test/server.test.mjs` | 1,773 | 25 个 |
| `test/postgres_store.test.mjs` | 1,340 | 8 个（默认跳过其中 7 个数据库集成用例） |
| `test/admin_credentials.test.mjs` | 220 | 7 个 |
| `test/web_identity.test.mjs` | 207 | 1 个 |
| **合计** | — | 后端 73 项全部通过（含 7 项 PostgreSQL）；前端单测 13 项通过；Playwright E2E 1 项通过 |

### 覆盖范围

| 类别 | 覆盖 |
|------|------|
| MCP 工具 | 全部 15 个工具的正向/异常路径 |
| REST API | 核心端点的正向与异常路径；包含注册、`/v1/me` 和邀请预览 |
| 鉴权 | 无效 Token、过期 Token、无 Token |
| 幂等性 | 写操作避免重复副作用；注册重放复用用户并签发新 Token |
| 速率限制 | 超过限制返回 429 |
| WebSocket | 认证、广播、断连 |
| Agent 租约 | 激活、心跳、转移、停用、超时 |
| 邀请码 | 创建、预览、接受、撤销、过期、次数耗尽 |
| 参数校验 | 类型、范围、必填字段 |
| 权限 | 非成员访问 403、非 owner 修改 403 |

### 测试模式

默认测试无需 PostgreSQL；本次使用 Compose 独立 PostgreSQL 17 容器设置 `TEST_DATABASE_URL`，7 个数据库集成用例已全部执行并通过。生产形态容器还完成了迁移、同源 SPA 首页/路由回退，以及创建房间、写读消息、删除房间烟测。

---

## 7. 关键设计决策

### D1：Web 账号与 MCP 身份绑定

- MCP 先签发一次性绑定码，Web 使用用户名和密码完成绑定
- Web 登录使用同源 HttpOnly Cookie Session；MCP 设备继续使用独立 Bearer Token

### D2：前后端部署现状

- 当前开发环境由 Vite 单独托管前端，并代理 REST 与 WebSocket 到 `localhost:18787`
- 服务端已支持将 `frontend/dist/` 同源托管，并为 SPA 路由回退到 `index.html`
- 根目录 `compose.yaml` 已验证 PostgreSQL 17、迁移和生产形态同源服务

### D3：WebSocket 认证

- 浏览器通过同源 HttpOnly Session Cookie 认证，无需在前端脚本中读取 Token
- 服务器端同时兼容 Bearer Header 和 query 参数，供其他客户端使用

### D4：全局单 WS 连接

- 一个 WebSocket 连接覆盖所有房间
- 服务器在 outbox poll 时自动将新成员加入推送列表

### D5：前端不调用 MCP 端点

- MCP 是 AI 客户端的专用通道
- 前端只使用 REST `/v1/*` 和 WebSocket

---

## 8. 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DATABASE_URL` | — | PostgreSQL 连接串 |
| `PUBLIC_REGISTRATION` | `0` | 开启 Web 自助注册 |
| `TRUST_PROXY` | `0` | 设为 `1` 后才信任代理提供的 `X-Forwarded-For` |
| `MCP_ALLOWED_ORIGINS` | — | MCP 跨域来源 |
| `CORS_ALLOW_ORIGIN` | `*` | REST API 跨域来源 |
| `PORT` | `18787` | 服务端口 |
| `SERVER_HOST` | `127.0.0.1` | 监听地址 |

---

## 9. 启动方式

```powershell
# 开发模式（内存存储 + 开发认证 + Web 注册）
$env:PUBLIC_REGISTRATION = '1'
npm.cmd run start:memory

# 生产模式（PostgreSQL）
$env:DATABASE_URL = 'postgres://...'
npm.cmd run start

# 前端开发
Set-Location frontend
npm.cmd run dev

# 运行测试
npm.cmd test

# 前端构建
npm.cmd run build --prefix frontend
```

---

## 10. Git 历史

```
4e6cc69 Allow agent-triggered group replies (2026-08-04)
dfdfb14 Add display names and harden group chat (2026-08-04)
a77188d Add conversation handoff rooms (2026-08-04)
a250199 Add credential administration CLI (2026-07-31)
61c93fd Initial release of Chuanhuatong MCP server (2026-07-31)
```

---

## 11. 遗留问题 / 待改进

### 技术债务
- 内存模式（`InMemoryGroupChatStore`）与 PG 模式（`PostgresGroupChatStore`）代码重复，约 80% 相似
- 前端已有 Vitest + Testing Library 覆盖状态 reducer、WebSocket hook、消息列表和顶层导航；仍缺少完整页面级 E2E 覆盖

### 安全
- 无审计日志
- MCP 设备 Token 支持逐设备撤销，但没有自动轮换
- 无消息编辑；本人消息支持 5 分钟内撤回，房主支持删除房间
- Web 账号绑定要求 MCP 签发的一次性绑定码，并受 IP 限流；反向代理部署需显式配置 `TRUST_PROXY=1`

### 功能
- 无 Agent "生成中"状态指示（前端轮询或 WS 推送）
- 无消息搜索
- 无文件/图片上传
- Web 已读位置通过独立 `web_read_seq` 维护
- 无用户在线状态

---

*本报告由 Claude Code 辅助生成，适用于 AI 审查。*
