# Web 前端及配套后端审查与修订报告

> 审查日期：2026-08-06
> 审查对象：`docs/web-frontend-architecture.md`、`docs/development-report.md` 及对应实现
> 修订范围：P1、P2 问题及移动端联调阻断
> 当前状态：P1、P2 与移动端 UUID 兼容问题已修复；仍有测试与部署残余风险

## 1. 结论摘要

本次审查覆盖 Web 注册、邀请深链接、REST 写操作幂等、WebSocket 开发代理、消息分页与断线补偿、Agent 可见性、交接文档真实性，以及安卓局域网浏览器兼容性。

初次审查共确认 8 项需要修复的问题：4 项 P1、4 项 P2。修订后：

- 4 项 P1 已完成修复，并通过邀请深链接、跨页消息加载和 WebSocket 断线补偿 E2E 验证。
- 4 项 P2 已完成修复，并补充注册幂等、注册限流、`GET /v1/me`、邀请预览和 PostgreSQL 幂等路径测试。
- 移动端实测发现的 `crypto.randomUUID()` 兼容性阻断已修复，所有前端请求 ID 改用 `crypto.getRandomValues()` 生成的 UUID v4；等待两台安卓复测。
- 当前可执行的 Node.js 测试共 62 项：56 通过、0 失败、6 跳过。
- 6 个跳过项依赖 `TEST_DATABASE_URL`，因此不能据此认定 PostgreSQL 真实环境已经验证通过。
- 前端构建通过；lint 仅保留一个既有 Fast Refresh 警告；构建仍有两个既有无效动态导入警告。
- 未新增数据库迁移、生产依赖或公开 API 路径。

在本次审查范围内，没有遗留的未修复 P1/P2。剩余事项集中在真实 PostgreSQL 验证、前端自动化测试、生产部署和 Phase 5 身份安全能力。

## 2. 审查基线与方法

### 2.1 审查输入

- 架构设计：`docs/web-frontend-architecture.md`
- 开发交接：`docs/development-report.md`
- 后端路由：`src/server.mjs`
- 内存与 PostgreSQL 存储：`src/group_chat_store.mjs`
- REST/MCP 测试：`test/server.test.mjs`、`test/postgres_store.test.mjs`、`test/mcp/group_chat_mcp.test.mjs`
- 前端实现：`frontend/src/`、`frontend/vite.config.ts`
- 运行与部署说明：`.env.example`、`README.md`、`AGENTS.md`、`Dockerfile`

### 2.2 审查方法

1. 将架构文档和开发报告声明逐项映射到实际路由、存储方法和前端调用。
2. 检查写操作要求的 `Idempotency-Key`、`Operation-Id` 与前端实际请求头是否一致。
3. 检查邀请深链接在未登录、注册成功和已登录三种状态下的路由闭环。
4. 检查 REST 初始加载、WebSocket 推送和断线重连之间的消息游标、排序与去重。
5. 对注册限流执行伪造 `X-Forwarded-For` 的专项验证。
6. 对 AgentBinding 的前后端枚举和展示逻辑进行契约对照。
7. 核对测试数量、测试覆盖、静态托管、Docker Compose 和启动命令等文档声明。
8. 修复后运行定向测试、完整测试、语法检查、前端构建、lint 和浏览器 E2E。

### 2.3 严重程度定义

| 级别 | 定义 |
|------|------|
| P1 | 阻断主要用户流程，或可能造成消息缺失、状态不一致等直接数据正确性问题 |
| P2 | 可被稳定触发的安全边界、幂等、契约或交接准确性问题，但不立即破坏全部核心流程 |
| P3 | 当前契约下可接受，但发布、扩容或长期维护前应处理的测试、运维和产品风险 |

## 3. 发现与修订总表

| 编号 | 严重度 | 问题 | 修订状态 | 主要验证 |
|------|--------|------|----------|----------|
| P1-1 | P1 | 邀请接受请求缺少 `Operation-Id` | 已修复 | 邀请深链接 E2E |
| P1-2 | P1 | 注册成功或已登录访问 `/auth` 时丢失邀请回跳地址 | 已修复 | 邀请链接到加入房间 E2E |
| P1-3 | P1 | Vite 未代理 WebSocket Upgrade | 已修复 | 开发环境 WS 连接与重连 E2E |
| P1-4 | P1 | 消息只加载单页，REST/WS 游标不统一，重连补偿可能漏消息 | 已修复 | 205 条跨页加载；断线后补齐到 208 条 |
| P2-1 | P2 | 注册限流无条件信任 `X-Forwarded-For`，可伪造绕过 | 已修复 | 第 11 次请求默认返回 429；可信代理为显式开关 |
| P2-2 | P2 | 注册不支持幂等，响应丢失后 Token 与已创建身份无法恢复 | 已修复 | 同键复用用户并签发新 Token；改参返回 409 |
| P2-3 | P2 | Agent 前端枚举与后端契约不一致，`off` 被显示为“手动” | 已修复 | TypeScript 构建通过；三态映射完成 |
| P2-4 | P2 | 开发报告高估测试和部署完成度，部分命令与状态码错误 | 已修复 | 文档与代码、测试输出、仓库文件重新核对 |
| MOB-1 | P1（移动端） | 局域网 HTTP 下 `crypto.randomUUID` 不可用，注册流程在发请求前失败 | 代码已修复，待安卓复测 | UUID v4 生成器 10,000 次唯一性与构建验证 |

## 4. P1 详细审查与修订

### 4.1 P1-1：邀请接受请求缺少 Operation-Id

**原始问题**

后端 `POST /v1/invites/accept` 将 `Operation-Id` 作为写操作幂等键，但前端 `acceptInvite` 只发送请求体，没有发送该请求头。

**影响**

- 用户在邀请预览页点击加入时，请求会被后端按缺少必填幂等键拒绝。
- Phase 2 的主要用户路径“预览邀请并加入房间”无法闭环。
- 开发报告中的邀请 E2E 完成声明与实际前端调用不一致。

**修订**

- `frontend/src/api/client.ts`：`apiRequest` 增加 `operationId` 选项并写入 `Operation-Id` 请求头。
- `frontend/src/api/invites.ts`：接受邀请时生成 UUID 并作为 `Operation-Id` 发送。

**验证**

Playwright E2E 已完成“打开邀请链接 -> 注册 -> 返回邀请页 -> 接受邀请 -> 进入房间”，接受请求不再因缺少请求头失败。

### 4.2 P1-2：邀请深链接在认证流程中丢失

**原始问题**

未登录用户从 `/join/:inviteCode` 被引导到 `/auth?redirect=...`，但注册成功后固定跳转 `/`；已经持有 Token 的用户访问带 `redirect` 的 `/auth` 时也固定跳转 `/`。

**影响**

- 新用户注册后离开邀请流程，需要重新打开原邀请链接。
- 在认证状态变化或重复打开链接时，路由行为不一致。
- 邀请深链接不能作为稳定、可分享的用户入口。

**修订**

- `frontend/src/App.tsx`：已登录用户访问 `/auth` 时读取 `redirect` 并跳转到目标地址。
- `frontend/src/pages/AuthPage.tsx`：注册并加载当前用户成功后，读取同一 `redirect` 参数返回邀请页。

**验证**

邀请深链接 E2E 已确认注册完成后浏览器回到原 `/join/:inviteCode`，随后可正常加入房间。

### 4.3 P1-3：Vite 开发代理未处理 WebSocket

**原始问题**

Vite 只为 `/v1` 配置了普通 HTTP 代理，没有启用 WebSocket Upgrade 转发。浏览器在 `5173` 开发地址发起 `/v1/realtime` 连接时，无法建立到 `18787` 后端的实时连接。

**影响**

- REST 功能可用，但开发环境实时消息不可用，容易被误判为后端 WebSocket 故障。
- 消息只能依赖页面加载或刷新恢复，无法满足实时聊天验收条件。

**修订**

- `frontend/vite.config.ts`：在 `/v1` 代理上增加 `ws: true`。

**验证**

浏览器 E2E 已确认开发地址可以建立 WebSocket、接收消息并在主动断开后自动重连。

### 4.4 P1-4：消息分页、去重与重连游标不完整

**原始问题**

消息同步同时依赖 REST 初始加载和 WebSocket 增量推送，但原实现存在以下组合问题：

- 初始加载只请求一页，历史消息超过单页上限时会静默截断。
- REST 合并与 WebSocket 追加没有统一推进房间的最后序号。
- REST 与 WS 返回重叠消息时，合并行为可能产生重复或顺序不稳定。
- 重连补偿缺少可靠的“从非连接状态进入 open”边沿判断，可能漏拉或重复触发。

**影响**

- 房间超过一页历史后，用户看不到全部可见消息。
- 断线期间产生的消息可能在重连后缺失。
- REST 和 WS 竞态可能导致重复消息、游标落后或展示顺序错误。

**修订**

- `frontend/src/store/AppContext.tsx`：
  - REST 与 WS 消息统一按 `message.id` 合并去重。
  - 合并后按 `seq` 升序排序。
  - `MERGE_MESSAGES` 与 `APPEND_MESSAGE` 都推进 `lastSeqs[roomId]`。
  - `loadMessages` 以每页 200 条循环请求，直到 `hasMore=false`。
- `frontend/src/pages/RoomPage.tsx`：
  - 使用 `wasConnectedRef` 判断连接状态边沿。
  - 仅在连接从非 `open` 进入 `open` 时，从当前 `lastSeq` 补拉缺失消息。

**验证**

- 预置 205 条消息后打开房间，前端最终显示完整 205 条，证明跨页加载有效。
- 主动断开 WebSocket，在断线期间新增 3 条消息；自动重连后消息数从 205 补齐到 208。
- REST 初始结果与 WS 推送重叠时，页面未出现重复消息。

## 5. P2 详细审查与修订

### 5.1 P2-1：注册限流信任任意 X-Forwarded-For

**原始问题**

注册路由无条件将 `X-Forwarded-For` 最左侧值作为客户端 IP。直连服务的请求方可以自行设置该头，每次更换值即可绕过“每 IP 每小时 10 次”的限流。

**复现证据**

- 不带伪造头时，同一来源第 11 次注册返回 429。
- 每次注册伪造不同 `X-Forwarded-For` 时，连续 11 次请求全部返回 201。

**影响**

- 公开注册的主要滥用限制可以被低成本绕过。
- 攻击者可批量创建账户，并持续增加 `users`、`sessions` 和幂等记录。

**修订**

- `src/server.mjs`：默认使用 `request.socket.remoteAddress` 作为注册限流键。
- 仅在 `TRUST_PROXY=1` 时读取 `X-Forwarded-For`。
- `.env.example`、`README.md`、`AGENTS.md` 和开发报告补充 `TRUST_PROXY=0` 默认值与使用条件。

**配置边界**

`TRUST_PROXY=1` 只能在可信反向代理覆盖客户端传入 `X-Forwarded-For` 的部署中启用。直连服务或代理只追加、不清理该头时应保持默认关闭。

**验证**

- 默认配置下连续发送不同伪造地址，第 11 次注册返回 429。
- 显式 `trustProxy: true` 的测试服务器可以按不同代理地址分别计数。

### 5.2 P2-2：注册响应丢失后无法恢复身份

**原始问题**

`POST /v1/auth/register` 原来不要求幂等键。服务端成功创建用户与 Token 后，如果响应在网络中丢失，客户端再次提交相同显示名只会得到昵称冲突；由于 Token 即身份且没有找回机制，该用户身份永久不可访问。

**设计取舍**

注册幂等需要跨进程和重启保持，因此没有采用仅进程内缓存。现有 `idempotency_records.principal_id` 没有用户外键，可以用固定的公开注册主体复用，无需增加数据库迁移。

为保持 `sessions` 只保存 Token 哈希，幂等记录不保存明文 Bearer Token。重放语义定义为：

- 同一 `Idempotency-Key`、同一请求参数：不重复创建用户，为原用户签发一个新的有效 Token。
- 同一 `Idempotency-Key`、不同请求参数：返回 409 `idempotency_conflict`。
- 缺少 `Idempotency-Key`：返回 400 `invalid_request`。

这保证“用户创建”只发生一次，但首次响应和重放响应中的 Token 不相同。

由于同键重放可以为原用户签发新 Token，注册幂等键在注册完成前具有身份恢复能力。调用方必须使用不可预测的高熵值并避免记录或泄露该请求头；内置前端使用 `crypto.getRandomValues()` 生成 UUID v4。公开部署时，反向代理也不应记录 `Idempotency-Key`。

**修订**

- `src/server.mjs`：注册路由读取并校验 `Idempotency-Key`，计算请求指纹。
- `src/group_chat_store.mjs`：MemoryStore 和 PostgresStore 都复用现有幂等记录。
- PostgreSQL 实现通过事务和 advisory transaction lock 串行化同键并发注册。
- `frontend/src/api/auth.ts`：注册 API 发送 `Idempotency-Key`。
- `frontend/src/pages/AuthPage.tsx`：同一显示名的失败重试复用同一个 UUID；显示名变化后生成新键。

**验证**

- 缺少注册幂等键返回 400。
- 同键同参数两次注册均返回 201，`userId` 相同，Token 不同且重放 Token 可调用 `GET /v1/me`。
- 同键改参返回 409 `idempotency_conflict`。
- PostgreSQL 并发重放测试已经加入 `test/postgres_store.test.mjs`，但本机未设置 `TEST_DATABASE_URL`，该路径本次未实际执行。

### 5.3 P2-3：AgentBinding 前后端枚举不一致

**原始问题**

后端公开契约为：

- `participationMode`: `off | manual | automatic`
- `publishMode`: `reviewRequired | automatic`

前端类型却声明为：

- `participationMode`: `manual | automatic`
- `publishMode`: `silent | visible`

成员面板用二元判断显示状态，因此后端返回 `off` 时会错误显示为“手动”。

**影响**

- 用户无法区分已停用 Agent 和手动参与 Agent。
- TypeScript 类型不能约束真实 API 数据，后续使用 `publishMode` 时可能产生错误分支。

**修订**

- `frontend/src/types.ts`：枚举改为与后端一致。
- `frontend/src/components/MemberPanel.tsx`：增加自动、手动、停用三态映射。
- `frontend/src/index.css`：增加 `status-off` 的亮色与暗色样式。

**验证**

前端 TypeScript 与 Vite 构建通过，三种参与状态都有确定的类型、文案和样式。

### 5.4 P2-4：开发报告与仓库实际状态不一致

**原始问题**

审查发现多处交接信息会误导接手者：

1. 开发报告声明 REST 所有端点已有测试，但注册、`GET /v1/me` 和邀请预览当时没有自动化用例。
2. 开发报告声明 `frontend/dist/` 已由后端同源托管，但 `src/server.mjs` 对非 API 路径仍返回 404，`Dockerfile` 也不复制前端产物。
3. 文档提供 `docker compose up --build`，但仓库不存在 `docker-compose.yml`。
4. 前端联调启动命令没有设置 `PUBLIC_REGISTRATION=1`，注册页默认会得到 404。
5. 架构文档写一次性邀请码第二次接受返回 404，而实际 REST 契约和测试为 409。
6. Agent 可见性和 `group_poll_messages` 已实现，但交接文档仍将 Phase 3、Phase 4 列为待完成。
7. 测试数量、文件行数和跳过项说明已经过期。

**影响**

- 接手者会使用不可执行的启动命令或寻找不存在的部署文件。
- 未完成能力可能被误认为已经可发布，已完成功能又可能被重复实现。
- 状态码、幂等语义和测试结论无法作为可靠验收依据。

**修订**

- `docs/development-report.md`：更新版本、幂等语义、测试覆盖、测试统计、部署现状、启动命令和环境变量。
- `docs/web-frontend-architecture.md`：将一次性邀请码第二次接受修正为 409；区分已完成后端测试和待配置前端测试；将静态托管明确标注为候选方案。
- `AGENTS.md`：更新 Phase 3/4 状态、测试结果、前端联调命令和环境变量。
- `README.md`：移除不存在的 Docker Compose 运行说明，改为已有 PostgreSQL/内存启动方式，并补充公开注册与代理信任配置。

**验证**

重新搜索文档后，不再存在“REST 所有端点已覆盖”“前端已由后端同源托管”“一次性邀请码第二次接受返回 404”或可直接运行不存在 Compose 文件的声明。

## 6. 修改文件与职责映射

### 5.5 MOB-1：移动端局域网 HTTP 不支持 crypto.randomUUID

**复现证据**

在安卓浏览器访问 `http://192.168.1.2:5173` 时，注册页显示：

```text
crypto.randomUUID is not a function
```

页面在调用后端注册接口之前就失败，因此用户无法开始注册。

**根因**

`crypto.randomUUID()` 要求更完整的 Web Crypto 安全上下文/浏览器实现。局域网 HTTP 开发地址不是 HTTPS 安全上下文，部分移动端浏览器仍提供 `crypto.getRandomValues()`，但不提供 `randomUUID()`。

**修订**

- 新增 `frontend/src/api/request-id.ts`。
- 使用 `crypto.getRandomValues(new Uint8Array(16))` 生成 RFC 4122 UUID v4。
- 替换注册、创建房间、发送消息、创建邀请、接受邀请的全部 `crypto.randomUUID()` 调用。
- 不使用 `Math.random()`，避免降低注册幂等键和消息客户端 ID 的不可预测性。

**验证**

- 源码和构建产物中不再存在 `randomUUID()` 引用。
- 生成器连续生成 10,000 个值，全部符合 UUID v4 格式且无重复。
- 前端 TypeScript/Vite 构建通过，lint 无新增错误。
- 两台安卓设备的实际注册、邀请和消息流程尚未重新执行，当前状态为“代码修复完成，设备复测待完成”。

### 6.1 P1 代码

| 文件 | 修订内容 |
|------|----------|
| `frontend/src/api/client.ts` | 支持发送 `Operation-Id` |
| `frontend/src/api/invites.ts` | 接受邀请时发送操作幂等键 |
| `frontend/src/App.tsx` | 已登录认证路由保留 `redirect` |
| `frontend/src/pages/AuthPage.tsx` | 注册后返回邀请页 |
| `frontend/vite.config.ts` | 启用 `/v1` WebSocket 代理 |
| `frontend/src/store/AppContext.tsx` | 消息分页、去重、排序和游标统一 |
| `frontend/src/pages/RoomPage.tsx` | 连接恢复时按最后序号补拉 |
| `frontend/src/api/request-id.ts` | 生成兼容局域网 HTTP 的 UUID v4 |

### 6.2 P2 代码与测试

| 文件 | 修订内容 |
|------|----------|
| `src/server.mjs` | 注册幂等键、请求指纹和可信代理开关 |
| `src/group_chat_store.mjs` | 内存与 PostgreSQL 注册幂等实现 |
| `test/server.test.mjs` | 注册、限流、`/v1/me`、邀请预览回归测试 |
| `test/postgres_store.test.mjs` | PostgreSQL 同键并发注册测试 |
| `frontend/src/api/auth.ts` | 注册请求发送幂等键 |
| `frontend/src/api/request-id.ts` | 统一生成注册、房间、消息和邀请请求 ID |
| `frontend/src/pages/AuthPage.tsx` | 网络失败重试复用注册键 |
| `frontend/src/types.ts` | 修正 AgentBinding 枚举 |
| `frontend/src/components/MemberPanel.tsx` | Agent 三态展示 |
| `frontend/src/index.css` | 停用状态样式 |
| `.env.example` | 增加 `TRUST_PROXY=0` |

### 6.3 文档

| 文件 | 修订内容 |
|------|----------|
| `docs/development-report.md` | 校正完成度、测试、幂等、部署和配置 |
| `docs/web-frontend-architecture.md` | 校正验收状态码、测试状态和静态托管状态 |
| `AGENTS.md` | 更新交接状态和本地联调命令 |
| `README.md` | 移除不存在的 Compose 流程，补充新配置 |

## 7. 验证结果

### 7.1 自动化测试

最终一次完整运行：

```text
tests 62
pass 56
fail 0
skipped 6
duration approximately 1.6s
```

跳过的 6 项全部需要 `TEST_DATABASE_URL`，包括本次补充的 PostgreSQL 注册并发幂等断言所在测试。内存存储、REST、MCP、WebSocket 和凭据管理路径均通过。

### 7.2 静态检查与构建

| 检查 | 结果 |
|------|------|
| `npm.cmd run check` | 通过 |
| `cd frontend; npm.cmd run build` | 通过，TypeScript 无错误 |
| `cd frontend; npm.cmd run lint` | 0 error；1 个既有 Fast Refresh warning |
| `git diff --check` | 通过；仅提示工作区未来可能发生 LF/CRLF 转换 |

构建仍报告两个既有 `INEFFECTIVE_DYNAMIC_IMPORT` 警告：

- `src/api/rooms.ts` 同时被静态和动态导入。
- `src/api/messages.ts` 同时被静态和动态导入。

这两个警告不影响构建产物，但动态导入不会产生预期的分包效果。

### 7.3 浏览器 E2E

| 场景 | 结果 |
|------|------|
| 邀请链接 -> 注册 -> 返回邀请 -> 加入房间 | 通过 |
| 205 条消息跨页加载 | 完整显示 205 条 |
| WS 断开期间新增 3 条，随后自动重连 | 从 205 条补齐到 208 条 |
| 前端开发服务器 | `http://127.0.0.1:5173/` 返回 200 |

浏览器 E2E 使用临时数据和临时辅助进程，验证后已清理；没有向仓库提交测试产物。

## 8. 残余风险与后续优先级

以下事项不属于本轮未修复的 P1/P2，但仍影响发布可信度。

### 8.1 P3：PostgreSQL 真实路径未执行

当前 6 个 PostgreSQL 集成用例因缺少 `TEST_DATABASE_URL` 跳过。注册并发幂等依赖 advisory transaction lock，虽然代码和测试用例已完成，但仍需在隔离测试数据库实际运行。

**发布前要求**：设置专用 `TEST_DATABASE_URL`，执行完整 `npm.cmd test`，确认 62 项全部执行且通过。

### 8.2 P3：前端缺少自动化单元测试

当前没有 Vitest 与 Testing Library 配置。消息去重、跨页循环、连接边沿判断和注册键复用主要依靠浏览器 E2E 与 TypeScript 构建验证。

**建议优先覆盖**：

- reducer 对重复 ID、乱序 `seq` 和空页的处理。
- `loadMessages` 多页终止条件。
- WebSocket 从 `reconnecting` 到 `open` 的补拉行为。
- 同一显示名失败重试复用注册幂等键。

### 8.3 P3：生产部署尚未完成

- 后端没有挂载 `frontend/dist/`。
- `Dockerfile` 不构建或复制前端产物。
- 仓库没有 Docker Compose manifest。
- 当前可用方式仍是 Vite 开发服务器与后端分开运行。

在完成这些工作前，不应将项目描述为“已支持后端同源部署”。

### 8.4 P3：身份与公开注册仍是临时产品模型

- Token 即身份，清除 localStorage 后没有恢复流程。
- 公开注册没有密码、邮箱验证、Token 轮换或撤销入口。
- 注册幂等键在重放窗口内具有身份恢复能力，需要按敏感请求头处理。
- 注册限流位于单进程内存，当前符合单实例运行约束；多实例部署时不能形成全局限流。
- `idempotency_records` 当前没有清理机制，长期运行会持续增长。

这些事项应在公开分发前的 Phase 5 中统一处理，不应通过零散兼容逻辑提前扩展当前 MVP。

### 8.5 运行状态说明

审查期间已有一个后端开发进程占用 `127.0.0.1:18787`。为避免中断用户进程，本次没有强制重启；该进程需要在下次正常重启后才会加载最新后端修订。前端开发服务器 `127.0.0.1:5173` 当前可访问。

## 9. 最终判定

当前实现已经消除本次审查确认的主要流程阻断、消息一致性问题、注册限流绕过、注册身份丢失风险和 Agent 契约错误。开发与交接文档也已恢复到与代码一致的状态。

在当前“单实例、内部或临时使用、前后端开发服务器分离”的产品边界内，可以继续进行功能验收。进入公开部署前，必须完成真实 PostgreSQL 全量测试、前端自动化测试和 Phase 5 身份安全与部署工作。
