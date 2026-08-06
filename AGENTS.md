# 传话筒 MCP（chuanhuatong-mcp）

独立的多人群聊 MCP Server：标准 MCP（Streamable HTTP `POST /mcp`）+ REST + WebSocket。
PostgreSQL 是唯一真相；服务端不调用模型、不保存 Host 私有会话历史。迁移位于
`migrations/`，并在 `src/migrations.mjs` 显式注册。

## 本地运行与验证

```powershell
npm.cmd run db:migrate                   # PostgreSQL 模式手动迁移
$env:PUBLIC_REGISTRATION='1'; npm.cmd run start:memory  # 内存模式前后端联调
npm.cmd run check                        # 语法检查
npm.cmd test                             # 内存模式测试（MCP + REST）
```

## 前端开发（2026-08-05 新增）

```bash
# 终端 1：后端（内存模式，开启 Web 注册）
$env:PUBLIC_REGISTRATION='1'; node src/server.mjs --memory --dev-auth

# 终端 2：前端开发服务器
cd frontend && npm run dev    # http://localhost:5173
```

前端构建产物：`frontend/dist/`（可通过 3 行代码挂载到后端同源托管）。

---

## 交接文档（2026-08-05）

> 以下内容是当次会话的完成情况总结，供下一位开发者/下一个会话继续工作。

### 已完成工作

#### Phase 1：Web 后端认证 + 前端 MVP（✅ 全部完成）

**后端新增（3 个文件）：**

| 文件 | 改动 |
|------|------|
| `src/server.mjs` | 新增 `POST /v1/auth/register`（含 IP 速率限制）+ `GET /v1/me`；WebSocket 支持 `?token=` 查询参数 |
| `src/group_chat_store.mjs` | MemoryStore + PostgresStore 均实现 `createUserRegistration`、`getMe` |
| `.env.example` | 新增 `PUBLIC_REGISTRATION=0`、`TRUST_PROXY=0` |

**前端新建（`frontend/` 目录，24 个源文件）：**

- Vite + React 19 + TypeScript + react-router-dom 7
- 全局状态：React Context + useReducer（`AppContext.tsx`）
- WebSocket Hook：指数退避重连（1s→30s，±20% 抖动），消息去重
- 4 个页面：AuthPage / RoomListPage / RoomPage / JoinPage
- 5 个组件：MessageList / MessageItem / SendBar / MemberPanel / InviteModal
- 完整 CSS（亮色/暗色模式）

#### Phase 2：邀请预览（✅ 全部完成）

- `GET /v1/invites/preview?token=X`：返回 `roomTitle`、`inviterDisplayName`、`expiresAt`、`remainingUses`
- 前端 JoinPage 展示预览卡片，用户确认后再加入

#### Phase 3：Agent 可见性（✅ 全部完成）

- Agent 消息样式和 `AI` 标签
- 成员面板区分人类与 Agent，并显示自动/手动/停用状态

#### Phase 4：`group_poll_messages`（✅ 全部完成）

- 已实现最长 60 秒的长轮询 MCP 工具及回归测试

#### 验证结果

- `npm test`：62 项，56 pass, 0 fail, 6 skip（跳过项需要 `TEST_DATABASE_URL`）
- 前端 `npm run build`：构建成功，TS 无错误
- 后端 E2E 测试：全流程通过（注册 → 建房 → 邀请 → 预览 → 接受 → 验证剩余次数）

---

### 未提交变更

工作区仍包含此前功能开发与本轮审查修订产生的未提交内容。提交前以
`git status --short` 和实际差异为准，按功能范围选择文件；不要包含来源不明的归档文件。

---

### 后端新增 API 清单

| 端点 | 方法 | 认证 | 速率限制 | 请求/说明 |
|------|------|------|---------|-----------|
| `/v1/auth/register` | POST | 否 | 每 IP 每小时 10 次 | 要求 `Idempotency-Key`；`{ displayName }` → `{ token, userId, displayName, handle }` |
| `/v1/me` | GET | Bearer | 无 | → `{ userId, handle, displayName, avatarResourceId, profileRevision }` |
| `/v1/invites/preview?token=X` | GET | Bearer | 无 | → `{ roomTitle, inviterDisplayName, expiresAt, remainingUses }` |

环境变量：`PUBLIC_REGISTRATION=0`（设为 1 开启 Web 注册，默认关闭）；`TRUST_PROXY=0`（设为 1 后才信任 `X-Forwarded-For`）。

---

### 待完成工作（Phase 5+）

#### Phase 5：公开分发前加固

- OAuth 2.1、Token 撤销与轮换
- 完善审计日志与滥用防护
- 数据导出与隐私说明

#### 其他待办

- **静态文件同源托管**：在 `src/server.mjs` 末尾添加 3-5 行托管 `frontend/dist/`（详见 `docs/web-frontend-architecture.md` 附录 A）
- **前端测试**：Vitest + @testing-library/react 测试 `useRealtimeWS` hook 和消息去重 reducer
- **InviteModal 优化**：统一使用 `apiRequest` 封装替代 `fetch` 直接调用

---

### 关键架构决策

1. **Token 即身份**：Web 用户 token 存 localStorage，清除即丢失账号，无找回机制
2. **WebSocket 认证**：浏览器原生 WS 不支持自定义 Header，改用 `?token=` 查询参数
3. **全局单 WS 连接**：一个 WebSocket 连接覆盖所有房间，不按房间建立多连接
4. **消息排序**：按 `seq` 升序（不按 `created_at`，避免时钟偏差）
5. **去重**：按 `message.id` 去重（WS 推送与 REST 初始加载可能重叠）
6. **前端不调用 MCP**：前端永远不直接调用 `/mcp` 端点

---

### 关键文件索引

| 文件 | 行数 | 说明 |
|------|------|------|
| `src/server.mjs` | ~1384 | HTTP 服务器，所有路由处理 |
| `src/group_chat_store.mjs` | ~4946 | 数据存储层（MemoryStore + PostgresStore） |
| `frontend/src/store/AppContext.tsx` | ~169 | 全局状态管理 |
| `frontend/src/ws/useRealtimeWS.ts` | ~74 | WebSocket 连接管理 |
| `docs/web-frontend-architecture.md` | ~760 | 完整架构设计文档 |

---

## 「拉群继续」协作交接工作流

当用户在当前会话中说「转成群聊」「拉群继续」「把前情带到群里」「把我们当前讨论转成
「…」群聊」等表达时，执行一次协作交接：

1. 用 `group_handoff_to_room` 工具一次性完成建房 + 写入前情 + 生成邀请码：
   - `title`：房间标题（如「方案讨论」）。
   - `contextSummary`：把当前会话整理成背景说明。
   - `decisions`：已确认的结论，逐条列出。
   - `openQuestions`：待讨论事项，逐条列出。
   - `inviteOptions`：可选，邀请码过期时间与使用次数；默认 7 天 / 10 次。
2. 单条消息最多 32768 字符：先精简摘要；超长则进一步拆分或缩短，不要触发服务器拒绝。
3. 工具成功后，把返回的 `inviteCode` 展示给用户，说明同事用该邀请码加入即可看到发进
   房间的前情。
4. 默认发送精简摘要；只有用户明确要求完整记录时才逐条整理原文。
5. 只有实际发送到房间的内容对加入者可见；当前会话原文不会自动对外共享。

此流程用原子工具完成，避免「房间建好但内容没发进去」的半完成态。
