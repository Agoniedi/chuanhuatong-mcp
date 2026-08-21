# 传话筒 MCP · Web 前端 + 多客户端架构技术开发文档

> 版本：v1.2
> 日期：2026-08-21
> 状态：架构基线与当前实现对照（前端视觉重设计已完成）
> 前置文档：`docs/auto-poll-design.md`、`docs/discussion-mode-design.md`、`docs/implementation-roadmap.md`

---

## 1. 现状核对

阅读仓库代码后，对照产品目标的能力盘点：

| 能力 | 现状 | 说明 |
|------|------|------|
| 单一 PostgreSQL 事实源 | ✅ 已有 | `messages` 表含 `seq`、`sender`、`content` |
| REST 读/写房间消息 | ✅ 已有 | `GET/POST /v1/rooms/:id/messages` |
| WebSocket `message.created` 推送 | ✅ 已有 | outbox_events 表 250ms 轮询，含 Agent 消息 |
| 邀请码发放 + 接受 | ✅ 已有 | REST + MCP 双路 |
| Agent 自动响应基础设施 | ✅ 已有 | generation_requests + lease 全流程 |
| **Web 用户注册 / 鉴权** | ✅ 已有 | `POST /v1/auth/register` + HttpOnly Cookie Session |
| **`GET /v1/me`** | ✅ 已有 | 返回当前用户与资料版本 |
| **邀请预览（加入前看房间名）** | ✅ 已有 | `GET /v1/invites/preview` |
| **前端代码** | ✅ 已有 | `frontend/` 为 Vite + React + TypeScript 应用 |

**当前结论**：Phase 1–4 已完成，当前开发重点是部署、公开分发前的安全加固和页面级 E2E 覆盖。

---

## 2. 总体架构

### 2.1 系统架构图

```
┌────────────────────────────────────────────────────────────┐
│                 PostgreSQL（唯一事实源）                     │
│  users · sessions · rooms · room_members · messages        │
│  room_agent_bindings · generation_requests · outbox_events │
└───────────────────────┬────────────────────────────────────┘
                        │ pg Pool
                        ▼
┌────────────────────────────────────────────────────────────┐
│            Node.js 服务进程（src/server.mjs）               │
│                                                            │
│  ┌─────────────┐  ┌──────────────────┐  ┌──────────────┐  │
│  │  POST /mcp  │  │   REST /v1/*     │  │ WS           │  │
│  │ Streamable  │  │ Bearer token     │  │ /v1/realtime │  │
│  │ HTTP MCP    │  │ CRUD + auth      │  │ server-push  │  │
│  └──────┬──────┘  └────────┬─────────┘  └──────┬───────┘  │
└─────────┼──────────────────┼────────────────────┼─────────┘
          │                  │                    │
  ┌───────┴──────┐   ┌───────┴────────┐   ┌──────┴───────┐
  │  MCP Clients │   │  Web 前端      │   │  Web 前端    │
  │  (AI Agents) │   │  REST：初始    │   │  WS：实时    │
  │              │   │  加载 + 写入   │   │  推送接收    │
  │ Codex CLI    │   └───────┬────────┘   └──────┬───────┘
  │ Claude       │           └──────────┬─────────┘
  │ Chatbox 等   │              同一浏览器标签页
  └──────────────┘
```

### 2.2 消息写入数据流

```
Web 用户发消息：
  浏览器 → POST /v1/rooms/:id/messages
         → INSERT messages (seq 单调递增)
         → INSERT outbox_events
         → outbox poll 250ms → message.created → 所有成员浏览器

MCP Agent 发消息：
  AI 客户端 → POST /mcp → group_send_message / group_publish_agent_reply
            → INSERT messages（同一张表）
            → INSERT outbox_events
            → outbox poll 250ms → message.created → 所有成员浏览器
```

两条路径写入同一张 `messages` 表，浏览器通过同一 WebSocket 连接收到两者推送。**不存在两套聊天记录。**

---

## 3. 各层职责边界

| 层 | 职责 | 不做什么 |
|----|------|---------|
| **MCP `POST /mcp`** | AI Agent 工具调用（建房、发消息、激活 Agent、长轮询） | 不面向浏览器，不走浏览器 CORS 流程 |
| **REST `/v1/*`** | 所有 CRUD、鉴权、分页初始加载 | 不做实时推送，不维护长连接 |
| **WebSocket `/v1/realtime`** | 服务器单向推送新消息事件 | 不处理客户端消息，不作为写入通道 |
| **Web 前端** | 用 REST 读取/写入，用 WS 接收推送 | 不调用 `/mcp`，不直接操作数据库 |

**前端永远不直接调用 MCP 端点。MCP 是 AI 客户端的专用通道。**

---

## 4. 新增 API 规范

### 4.1 `POST /v1/auth/register`（已实现）

Web 用户使用已有 MCP 身份签发的一次性绑定码创建账号，并建立同源 HttpOnly Cookie Session。

**请求**

```http
POST /v1/auth/register
Content-Type: application/json

{
  "username": "zhangsan",
  "displayName": "张三",
  "password": "...",
  "passwordConfirmation": "...",
  "bindingCode": "XXXX-XXXX"
}
```

**响应 201**

```json
{
  "userId": "usr_...",
  "displayName": "张三",
  "handle": "@zhangsan"
}
```

**实现要点**

- 校验 MCP 签发的一次性绑定码、用户名、密码和显示名
- 注册成功后通过 `Set-Cookie` 建立 Web Session
- 后续 REST 请求使用同源 Cookie；MCP 设备仍使用 Bearer Token

**安全说明**：密码重置码由 MCP 身份签发，Web Session 使用 HttpOnly Cookie。

---

### 4.2 `GET /v1/me`（Phase 1 必须）

**请求**

```http
GET /v1/me
Cookie: chuanhuatong_web=...
```

**响应 200**

```json
{
  "userId": "usr_...",
  "handle": "@usr_xxxx",
  "displayName": "张三",
  "profileRevision": 1
}
```

---

### 4.3 `GET /v1/invites/preview`（Phase 2 可选）

在接受邀请前预览房间信息，避免盲接。

**请求**

```http
GET /v1/invites/preview?token=<inviteToken>
Authorization: Bearer <token>
```

**响应 200**

```json
{
  "roomTitle": "方案讨论",
  "inviterDisplayName": "李四",
  "expiresAt": "2026-08-11T15:00:00Z",
  "remainingUses": 3
}
```

**响应 404**：邀请码不存在或已过期/耗尽。

**说明**：Phase 1 可跳过，直接让用户输入邀请码后调用 `POST /v1/invites/accept`，失败时显示错误信息。

---

### 4.4 现有端点（前端可直接复用，无需改动）

| 端点 | 前端用途 |
|------|---------|
| `GET /v1/rooms` | 房间列表 |
| `POST /v1/rooms` | 创建房间 |
| `GET /v1/rooms/:id` | 房间详情 |
| `GET /v1/rooms/:id/messages?afterSeq=N&limit=N` | 历史消息分页 |
| `POST /v1/rooms/:id/messages` | 发送消息 |
| `GET /v1/rooms/:id/members` | 成员列表 |
| `GET /v1/rooms/:id/invites` | 邀请列表 |
| `POST /v1/rooms/:id/invites` | 创建邀请 |
| `POST /v1/invites/accept` | 接受邀请（Body: `{ inviteToken }`）|
| `GET /v1/rooms/:id/agent-bindings` | 查看房间 Agent（Phase 3）|

---

## 5. WebSocket 协议规范

### 5.1 连接

```
WebSocket /v1/realtime
Cookie: chuanhuatong_web=...
```

连接成功后服务器立即推送 `connection.ready`：

```json
{
  "protocolVersion": 1,
  "eventId": "evt_...",
  "type": "connection.ready",
  "occurredAt": "2026-08-04T15:10:00Z",
  "payload": {}
}
```

### 5.2 `message.created` 事件

用户所在任意房间有新消息（包括 Agent 消息）时触发，无需区分来源：

```json
{
  "protocolVersion": 1,
  "eventId": "evt_...",
  "type": "message.created",
  "occurredAt": "2026-08-04T15:10:05Z",
  "roomId": "room_...",
  "payload": {
    "id": "msg_...",
    "roomId": "room_...",
    "seq": 42,
    "senderType": "human",
    "senderDisplayName": "张三",
    "senderId": "usr_...",
    "content": {
      "schemaVersion": 1,
      "type": "text",
      "text": "接口改好了吗？"
    },
    "mentions": [],
    "replyToMessageId": null,
    "createdAt": "2026-08-04T15:10:05Z"
  }
}
```

### 5.3 前端 WebSocket 客户端策略

| 关注点 | 策略 |
|--------|------|
| **重连** | 指数退避，初始 1s，最大 30s，抖动 ±20% |
| **消息去重** | 按 `payload.id` 去重（WS 推送与 REST 初始加载可能重叠）|
| **顺序排列** | 按 `payload.seq` 升序（房间内单调递增 bigint，唯一可靠排序键）|
| **加入新房间后** | 无需重连；服务器在下次 outbox poll 时自动将新成员加入推送列表 |
| **断线补全** | 重连后调用 `GET /v1/rooms/:id/messages?afterSeq=<lastSeq>` 补全缺失消息 |
| **全局单连接** | 一个 WS 连接覆盖所有房间，不按房间建立多连接 |

---

## 6. MCP 工具完整清单（现有，无需改动）

| 工具名 | 类型 | 用途 |
|--------|------|------|
| `group_create_room` | 写 | 建房 |
| `group_create_invite` | 写 | 生成邀请码 |
| `group_join_room` | 写 | 用邀请码加入房间 |
| `group_list_rooms` | 只读 | 列出可见房间 |
| `group_get_room_context` | 只读 | 房间详情 + 成员 + Agent |
| `group_read_messages` | 只读 | 分页读取消息（单次，无等待）|
| `group_wait_for_messages` | 只读 | 短轮询，最长 5s |
| `group_handoff_to_room` | 写 | 原子交接：建房 + 写入前情 + 创建邀请 |
| `group_activate_agent` | 写 | 配置 Agent 公开身份 + 激活 |
| `group_heartbeat_agent` | 写 | 续租 |
| `group_deactivate_agent` | 写 | 停用 |
| `group_publish_agent_reply` | 写 | 发布 AI 回复（主要发布工具）|
| `group_set_display_name` | 写 | 修改用户显示名 |

**Phase 4 已实现（来自 `docs/auto-poll-design.md`）：**

| 工具名 | 用途 |
|--------|------|
| `group_poll_messages` | 长轮询，最长 60s，2s 间隔，适合发消息后等待回复 |

---

## 7. 前端技术选型

### 7.1 推荐：Vite + React + TypeScript

**理由：**

1. **状态复杂度匹配**：房间切换、历史分页、WS 实时追加、断线补全——这些状态交织，纯 Vanilla JS 在 300 行后会失控；React 的组件模型恰好匹配聊天 UI。
2. **零运行时额外依赖**：Vite 只在构建时需要，产物是静态 HTML/CSS/JS，可部署到任何位置。
3. **类型安全**：TypeScript 与后端严格 Zod Schema 一一对应，可直接共享类型定义，减少边界 Bug。
4. **开发体验**：`vite.config.ts` 配置 proxy 后本地开发直接代理到 `localhost:18787`，无需处理 CORS。
5. **后端无侵入**：`frontend/` 是独立目录，构建产物 `frontend/dist/` 既可由后端同源托管（3 行静态文件路由），也可单独部署（`CORS_ALLOW_ORIGIN` 已配置）。

### 7.2 核心依赖（仅生产运行时）

| 包 | 版本 | 用途 |
|----|------|------|
| `react` + `react-dom` | 19.x | UI 框架 |
| `react-router-dom` | 7.x | 客户端路由 |

其余功能使用原生 API：`fetch` 替代 Axios，原生 `WebSocket` 替代 socket.io，React Context + useReducer 替代 Redux/Zustand。

### 7.3 开发工具

| 包 | 用途 |
|----|------|
| `vite` + `@vitejs/plugin-react` | 构建与开发服务器 |
| `typescript` | 类型检查 |

---

## 8. 前端模块设计

### 8.1 目录结构

```
frontend/
├── index.html
├── vite.config.ts          # proxy: /v1 → http://localhost:18787
├── tsconfig.json
├── package.json
└── src/
    ├── main.tsx
    ├── App.tsx             # 路由根，未登录重定向 /auth
    ├── types.ts            # 共享类型（Message, Room, User）
    ├── api/
    │   ├── client.ts       # fetch 封装（same-origin credentials，统一错误处理）
    │   ├── auth.ts         # login(), register(), resetPassword(), me()
    │   ├── rooms.ts        # listRooms(), getRoom(), createRoom()
    │   ├── messages.ts     # listMessages(), sendMessage()
    │   └── invites.ts      # createInvite(), acceptInvite(), previewInvite()
    ├── ws/
    │   └── useRealtimeWS.ts  # WebSocket hook：连接/重连/事件分发
    ├── store/
    │   └── AppContext.tsx   # 全局状态：token, me, rooms, messages map
    ├── pages/
    │   ├── AuthPage.tsx    # 登录、绑定账号、密码重置
    │   ├── RoomListPage.tsx  # 房间列表 + 加入/创建入口
    │   ├── RoomPage.tsx    # 消息流 + 发送框 + 成员侧栏
    │   └── JoinPage.tsx    # /join/:inviteCode 深链接处理
    └── components/
        ├── MessageList.tsx
        ├── MessageItem.tsx   # human/agent 样式区分
        ├── SendBar.tsx
        ├── MemberPanel.tsx
        └── InviteModal.tsx
```

### 8.2 路由设计

| 路径 | 页面 | 说明 |
|------|------|------|
| `/` | `RoomListPage` | 未登录时重定向到 `/auth` |
| `/auth` | `AuthPage` | 登录、绑定账号、密码重置 |
| `/rooms/:roomId` | `RoomPage` | 房间消息视图 |
| `/join/:inviteCode` | `JoinPage` | 邀请深链接，成功后跳转到房间 |

### 8.3 状态管理

使用 React Context + useReducer，不引入外部状态库：

```typescript
// AppContext 全局状态结构
interface AppState {
  session: 'unknown' | 'authenticated' | 'anonymous';
  me: User | null;
  rooms: Room[];
  messages: Record<string, Message[]>;          // roomId → 按 seq 排序的消息列表
  wsStatus: 'connecting' | 'open' | 'reconnecting' | 'closed';
}
```

**消息追加（防重复）：**

```typescript
// reducer 处理 APPEND_MESSAGE action
case 'APPEND_MESSAGE': {
  const roomMsgs = state.messages[action.roomId] ?? [];
  const exists = roomMsgs.some(m => m.id === action.message.id);
  if (exists) return state;
  const updated = [...roomMsgs, action.message]
    .sort((a, b) => Number(a.seq) - Number(b.seq));
  return { ...state, messages: { ...state.messages, [action.roomId]: updated } };
}
```

### 8.4 初始加载 + 实时同步流程

```
进入房间：
  1. GET /v1/rooms/:id/messages?afterSeq=0&limit=50 → 加载历史
  2. 记录 lastSeq = messages[last].seq
  3. 全局 WS 已连接，自动接收该房间的 message.created 事件
  4. 收到推送 → dispatch APPEND_MESSAGE（按 id 去重）

断线重连：
  1. WS close → 指数退避重连
  2. 重连成功 → GET /v1/rooms/:id/messages?afterSeq=<lastSeq> 补全缺失

发消息（幂等）：
  1. 生成 clientMessageId，存 sessionStorage
  2. POST /v1/rooms/:id/messages（含 Idempotency-Key: clientMessageId）
  3. 网络失败 → 用同一 clientMessageId 重试，服务器按 (roomId, clientMessageId) 去重
```

---

## 9. 多客户端兼容矩阵

### 9.1 接入矩阵

| 客户端 | 原生 MCP 传输 | 接入方式 | 状态 |
|--------|-------------|---------|------|
| Claude Web (claude.ai) | Streamable HTTP | 直连 `POST /mcp` | ✅ 确认支持 |
| Cherry Studio | Streamable HTTP | 直连 `POST /mcp` | ✅ 确认支持 |
| Chatbox | Streamable HTTP | 直连 `POST /mcp` | ✅ 确认支持 |
| Kelivo | 待确认 | 直连（如支持 HTTP）| ⚠️ 待测试 |
| Operit | 待确认 | 直连（如支持 HTTP）| ⚠️ 待测试 |
| Codex CLI | stdio | mcp-remote 代理 | ✅ 通用适配层 |
| Claude Desktop | stdio | mcp-remote 代理 | ✅ 通用适配层 |
| 任意 stdio MCP 客户端 | stdio | mcp-remote 代理 | ✅ 通用适配层 |

### 9.2 stdio 客户端适配方案

服务端**无需任何改动**，使用官方 `@modelcontextprotocol/mcp-remote` 适配器：

```json
// mcp_config.json（Codex CLI / Claude Desktop）
{
  "mcpServers": {
    "chuanhuatong": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/mcp-remote@latest",
        "https://your-server.example.com/mcp",
        "--header",
        "Authorization:Bearer YOUR_TOKEN"
      ]
    }
  }
}
```

该适配器在本地启动 stdio 进程，将 MCP JSON-RPC 转发到远端 HTTPS 端点，用户体验等同"本地 MCP Server"。

### 9.3 能力边界（明确限制）

| 能力 | 结论 |
|------|------|
| 房间消息在所有客户端共享 | ✅ 所有客户端读写同一张 `messages` 表 |
| 客户端本地会话历史 | ❌ 不共享，属于各客户端私有，不传输到服务器 |
| 服务器主动推送消息给 MCP 客户端 | ❌ 不可能，标准 MCP 是客户端主动发起调用 |
| 网页实时显示 Agent 消息 | ✅ 通过 WS `message.created`，与 Agent 使用什么传输无关 |
| 服务器自动唤醒 Codex/Claude Desktop 响应新消息 | ❌ 不可能，客户端未主动发起时服务器无法注入 |

---

## 10. Agent 自动唤醒：可选方案与风险

> ⚠️ 本节描述的能力**不属于通用 MCP 基础协议**，不能对所有客户端承诺支持。网页消息实时显示（第 5 节）与自动唤醒 Agent 是两个独立问题，不要混为一谈。

### 10.1 后端已有基础设施

```
1. 人类消息进入 room
2. 服务器（binding.participation_mode = 'automatic'）
   → 自动创建 generation_request（status: queued）
3. Agent 进程轮询 GET /v1/generation-requests?status=queued
4. Agent claim → start → publish
   → INSERT messages（同一张表）
   → WS 推送到所有浏览器
```

### 10.2 三种自动唤醒方案对比

| 方案 | 描述 | 前提 | 可靠性 |
|------|------|------|--------|
| **A. 客户端长轮询**（推荐文档化）| AI 在一次长回合内循环调用 `group_poll_messages`（60s）等待回复 | 用户主动指令 AI "监听房间" | ✅ 可靠，但需用户手动启动每次会话 |
| **B. 常驻 Agent 进程** | 独立脚本持续轮询 generation_requests，调用模型 API，发布回复 | 服务器上有独立进程 + 模型 API Key | ✅ 可靠，但脱离 MCP Client 边界 |
| **C. WS 通知唤醒** | 客户端建立 WS 连接监听 `message.created`，收到后触发 Agent 流程 | 客户端支持 WS 常驻后台 | ⚠️ 极少数客户端支持 |

### 10.3 实施建议

- **Phase 1–3**：不实现自动唤醒
- **方案 A**：作为 AI 使用指南文档提供（"如何让 AI 自动等待群聊回复"）
- **方案 B**：作为独立 Adapter 工程（另立仓库），引入模型 API Key 前需另行确认安全和费用边界

---

## 11. 数据模型与消息顺序策略

### 11.1 关键字段说明

| 字段 | 用途 |
|------|------|
| `messages.id` | 全局唯一消息 ID，前端 map key 与去重 key |
| `messages.seq` | 房间内单调递增 bigint，**唯一排序依据** |
| `messages.client_message_id` | 每房间唯一，幂等键，重试时复用 |
| `messages.sender` | jsonb，含 `kind: 'human' \| 'agent'`、`displayName`，前端按此区分样式 |
| `messages.created_at` | 入库时间，仅用于显示时间戳，不用于排序 |

### 11.2 前端去重与顺序策略

```
显示顺序：按 seq 升序（不按 created_at，避免时钟偏差）

去重规则：
  - REST 初始加载：按 afterSeq 范围拉取，天然无重复
  - WS 推送：按 message.id 检查是否已存在
  - 边界情况（初始加载与 WS 推送同一条消息重叠）：
    以 message.id 为 SET key，保留已有记录，不重复插入

分页游标：使用 afterSeq（禁止用 highWaterSeq 跳页，见 implementation-roadmap.md）
```

### 11.3 发消息幂等策略

```typescript
// 发送前在 sessionStorage 存储 clientMessageId
const clientMessageId = crypto.randomUUID();
sessionStorage.setItem(`pending-${roomId}`, clientMessageId);

// 调用 API（含 Idempotency-Key 头）
await sendMessage(roomId, { clientMessageId, text });

// 成功后清除
sessionStorage.removeItem(`pending-${roomId}`);

// 网络失败时，从 sessionStorage 取出同一 ID 重试
// 服务器按 (roomId, clientMessageId) UNIQUE 去重
```

---

## 12. 分阶段实施计划（历史规划）

> 本节记录最初的实施顺序。Phase 1–4 已完成，当前状态请以本文第 1 节和 `docs/development-report.md` 为准。

### Phase 1：最小可用 Web 聊天（MVP）

**目标**：Web 用户可注册、查看历史消息、发消息、实时接收所有来源的新消息。

**后端改动（约 80 行）：**

| 文件 | 改动 |
|------|------|
| `src/server.mjs` | 新增 `POST /v1/auth/register`（30 行）|
| `src/server.mjs` | 新增 `GET /v1/me`（10 行）|
| `src/server.mjs` | 可选：挂载 `frontend/dist/` 静态文件（5 行）|
| `.env.example` | 新增 `PUBLIC_REGISTRATION=0`（1 行）|

**前端新建（`frontend/` 目录）：**

- 脚手架：`npm create vite@latest frontend -- --template react-ts`
- 实现页面：`AuthPage` → `RoomListPage` → `RoomPage`
- 实现 WebSocket hook（含重连、去重、断线补全）
- 实现 API client（Bearer token 注入）

**不实现（明确排除）：**
- 邀请深链接（Phase 2）
- Agent 状态展示（Phase 3）
- 自动唤醒（可选，不纳入计划）

---

### Phase 2：邀请流

**目标**：Web 用户可创建邀请链接、通过链接加入房间。

**后端改动：**
- `GET /v1/invites/preview?token=X`（约 20 行）

**前端改动：**
- `InviteModal`（生成邀请码 + 复制链接）
- `JoinPage`（`/join/:inviteCode` 深链接，调用预览 + 接受）

---

### Phase 3：Agent 可见性

**目标**：前端展示 Agent 消息样式、房间内 Agent 成员列表。

**后端改动**：无（`GET /v1/rooms/:id/agent-bindings` 已存在）

**前端改动：**
- `MessageItem`：`senderType === 'agent'` 时展示特殊头像/标签
- `MemberPanel`：区分人类成员与 Agent 成员
- 可选：Agent "生成中"状态（轮询 generation_requests 状态）

---

### Phase 4：`group_poll_messages` 工具（可选，来自 auto-poll-design.md）

**目标**：AI 发消息后自动等待群聊回复，无需用户手动触发。

**改动**：`src/mcp/group_chat_mcp_server.mjs` +约 40 行，新增工具定义与 `pollMessages` 函数（详见 `docs/auto-poll-design.md`）。

---

### Phase 5：公开分发前加固（来自 implementation-roadmap.md 阶段 5）

- OAuth 2.1、Token 撤销与轮换
- 完善审计日志与滥用防护
- 数据导出与隐私说明

---

## 13. 验收标准与测试策略

### Phase 1 验收标准

| 编号 | 验收条件 |
|------|---------|
| P1-1 | 新用户调用 `POST /v1/auth/register` 成功，返回有效 Bearer token |
| P1-2 | 用有效 token 调用 `GET /v1/me` 返回正确用户信息 |
| P1-3 | 浏览器打开 Web 前端，使用用户名和密码登录后可看到房间列表 |
| P1-4 | 在 Web 前端发送消息，可在另一个浏览器 Tab 实时看到（延迟 ≤ 1s）|
| P1-5 | MCP 客户端（Codex/Claude）发送消息，Web 前端实时显示（延迟 ≤ 1s）|
| P1-6 | Web 前端发送消息，MCP 客户端通过 `group_read_messages` 可读到 |
| P1-7 | 断网 30s 后恢复，Web 前端自动重连并补全缺失消息 |
| P1-8 | `npm test` 通过，`npm run check` 无报错 |

### Phase 2 验收标准

| 编号 | 验收条件 |
|------|---------|
| P2-1 | 房间 owner 可在 Web 创建邀请码，复制链接 |
| P2-2 | 新用户打开邀请链接，看到房间名预览，点击加入后进入房间 |
| P2-3 | `maxUses=1` 的邀请码被使用一次后，第二次接受返回 409 |

### 测试策略

| 类型 | 工具 | 范围 |
|------|------|------|
| 后端单元/集成测试 | 现有 `npm test`（内存模式）| 已覆盖 `POST /v1/auth/register`、`GET /v1/me`、邀请预览与注册限流 |
| 前端组件测试 | Vitest + @testing-library/react | 已覆盖 `useRealtimeWS`、消息列表、状态 reducer、顶层导航；页面级 E2E 仍需扩展 |
| 浏览器 E2E | Playwright | 登录、聊天、撤回、移动端布局、设置、世界发布和删除房间 |
| 压力测试（可选）| `wrk` / `k6` | `GET /v1/rooms/:id/messages` 分页性能 |

---

## 14. 历史产品决策记录

以下决策记录最初的实现取舍，当前不再是阻塞项。

### D1：Web 用户身份持久化方式（已落地）

**历史问题**：早期方案曾考虑把 Token 直接存入 `localStorage`，当前已不再采用。

**当前实现**：采用用户名 + 密码和同源 HttpOnly Cookie Session；MCP 设备仍使用独立 Bearer Token。

---

### D2：前端部署方式（已落地）

**当前实现**：开发时由 Vite 托管，生产构建由 `src/server.mjs` 同源托管并支持 SPA 回退。

| 选项 | 实现 | 适合场景 |
|------|------|---------|
| **A. 后端同源托管（推荐）** | 在 `src/server.mjs` 加 3 行静态文件路由 | 单机部署，最简单 |
| B. 独立部署（Nginx/Vercel）| 不改后端，配置 CORS（已就绪）| 前后端分离部署 |

---

### D3：谁创建第一个邀请（历史问题）

**历史问题**：Phase 1 中，Web 新用户注册后没有任何房间，无法自助加入。谁给他们第一个邀请？

| 选项 | 说明 |
|------|------|
| A. 管理员通过 admin CLI 创建邀请码，发给用户 | 现有能力，不需改动 |
| B. Web 注册后自动进入默认公共房间 | 需新增"公共房间"概念，改动大 |
| **C. 先创建房间，再邀请（推荐）**| Web 用户注册后可直接创建房间并邀请他人，闭环自洽 |

---

### D4：消息历史可见范围

**问题**：Web 用户创建房间时，历史消息对新加入者是否可见？

当前数据库已有 `history_visibility: 'after_join' | 'from_start'`。

- `after_join`（当前默认）：加入后才能看到此后的消息
- `from_start`：加入后可看到房间全部历史（`group_handoff_to_room` 已使用此模式）

**建议**：Web 创建房间时提供一个开关，默认 `after_join`。

---

### D5：是否实现 group_poll_messages（已落地）

**历史问题**：`docs/auto-poll-design.md` 设计的 60s 长轮询工具是否纳入交付范围。

该工具已在 Phase 4 实现并有回归测试。

---

## 附录 A：静态文件同源托管（已实现）

`src/server.mjs` 已在所有 `/v1/*` 和 `/mcp` 路由之后调用 `serveFrontend()`：

- 生产构建存在时，静态资源按 MIME 类型返回；
- 不存在的前端路径回退到 `index.html`，支持 SPA 路由；
- 服务端测试覆盖同源首页和 SPA 路由。

历史候选伪代码如下，仅作记录：

```javascript
// 伪代码，适配现有路由风格
import { createReadStream, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const FRONTEND_DIST = new URL('../frontend/dist', import.meta.url).pathname;
const MIME = { '.html':'text/html', '.js':'application/javascript',
               '.css':'text/css', '.json':'application/json', '.svg':'image/svg+xml' };

// fallback handler（放在所有路由最后）
if (!url.startsWith('/v1/') && !url.startsWith('/mcp')) {
  const file = existsSync(join(FRONTEND_DIST, url)) ? url : '/index.html';
  const ext = extname(file) || '.html';
  res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
  createReadStream(join(FRONTEND_DIST, file)).pipe(res);
}
```

---

## 附录 B：stdio 客户端完整配置参考

```json
{
  "mcpServers": {
    "chuanhuatong": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/mcp-remote@latest",
        "https://your-server.example.com/mcp",
        "--header",
        "Authorization:Bearer YOUR_TOKEN_HERE"
      ]
    }
  }
}
```

Token 通过 `scripts/admin_credentials.mjs` 生成：

```bash
node scripts/admin_credentials.mjs create --label "codex-用户A"
# 输出 JSON 文件，含 authorizationHeader: "Bearer ct_..."
```
