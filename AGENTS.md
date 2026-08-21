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

## 前端开发

```powershell
# 终端 1：后端（内存模式 + 开发认证）
npm.cmd run start:memory

# 终端 2：前端开发服务器
Set-Location frontend
npm.cmd run dev                # http://localhost:5173
```

前端构建产物位于 `frontend/dist/`。该目录存在时，后端会同源托管静态资源，并将
SPA 路由回退到 `index.html`。

---

## 当前实现（2026-08-21）

### 后端与认证

- Web 账号通过 MCP 签发的一次性绑定码创建，登录使用用户名、密码和同源
  HttpOnly Session。
- MCP 设备使用独立 Bearer Token；设备凭据可创建、列出和撤销。
- 浏览器前端的 WebSocket 使用同源 Session Cookie；服务端同时兼容 Bearer Header
  和 `?token=`，供非浏览器客户端使用。
- PostgreSQL 是生产模式唯一事实源；内存模式只用于测试和本地临时联调。
- `frontend/dist/` 已由后端同源托管，包含 SPA 路由回退。
- 根目录 `compose.yaml` 可启动 PostgreSQL 17 与生产形态服务。

### Web 前端

- Vite 8 + React 19 + TypeScript + react-router-dom 7。
- 6 个页面：AuthPage、RoomListPage、RoomPage、JoinPage、WorldPage、SettingsPage。
- 全局状态使用 React Context + useReducer；一个 WebSocket 连接覆盖全部房间。
- 消息按 `seq` 升序，REST 初始加载和 WS 推送按 `message.id` 去重。
- 支持亮色、暗色和系统主题，以及用户气泡颜色与透明度设置。
- 前端只调用 REST `/v1/*` 和 WebSocket，不直接调用 `/mcp`。

### 已完成阶段

- Phase 1：Web 账号、REST/WS 后端与 React 前端。
- Phase 2：邀请预览与确认加入。
- Phase 3：Agent 消息和成员可见性。
- Phase 4：最长 60 秒的 `group_poll_messages`。
- Web 前端视觉重设计：顶层导航、世界、设置、移动端布局、消息撤回与房间管理。

### 验证基线

- `npm.cmd test`：73 项，默认内存模式 66 pass、0 fail、7 skip；配置独立
  `TEST_DATABASE_URL` 后 73 pass、0 fail、0 skip。
- `npm.cmd run check`：通过。
- `npm.cmd test --prefix frontend`：5 个测试文件、13 项测试通过。
- `npm.cmd run lint --prefix frontend`：通过。
- `npm.cmd run test:e2e --prefix frontend`：Playwright E2E 通过。
- PostgreSQL 17 Compose 烟测：迁移 001-010、同源 SPA 回退、建房、消息写读和删房均通过。

### 未提交变更

工作区仍包含此前功能开发与本轮审查修订产生的未提交内容。提交前以
`git status --short` 和实际差异为准，按功能范围选择文件；不要包含来源不明的归档文件。

### Web API 摘要

| 端点 | 方法 | 认证 | 速率限制 | 请求/说明 |
|------|------|------|---------|-----------|
| `/v1/auth/register` | POST | 绑定码 | 每 IP 每小时 10 次 | 绑定已有 MCP 身份并创建 Web 账号 |
| `/v1/auth/login` | POST | 否 | 无 | 用户名密码登录并建立 HttpOnly Session |
| `/v1/auth/logout` | POST | Session | 无 | 注销当前 Web Session |
| `/v1/auth/reset-password` | POST | 重置码 | 无 | 使用 MCP 签发的重置码设置新密码 |
| `/v1/me` | GET/PATCH | Session | 无 | 获取或修改当前用户资料 |
| `/v1/invites/preview?token=X` | GET | Session | 无 | 邀请预览 |

`PUBLIC_REGISTRATION=0` 默认关闭 Web 账号绑定；`TRUST_PROXY=0` 默认不信任
`X-Forwarded-For`。只在受控反向代理后启用 `TRUST_PROXY=1`。

### 关键文件索引

| 文件 | 行数 | 说明 |
|------|------|------|
| `src/server.mjs` | ~1821 | HTTP、REST、静态托管与 WebSocket |
| `src/group_chat_store.mjs` | ~6112 | MemoryStore + PostgresStore |
| `frontend/src/store/AppContext.tsx` | ~99 | 全局状态协调 |
| `frontend/src/store/reducer.ts` | — | 状态 reducer 与消息去重 |
| `frontend/src/ws/useRealtimeWS.ts` | ~60 | WebSocket 连接管理 |
| `docs/development-report.md` | — | 当前实现与验证报告 |

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
