# 传话筒 MCP 功能改动交叉审查报告

> 日期：2026-08-18
> 用途：供独立审查本轮聊天 Web 功能、消息撤回、房间删除、外观设置和“世界”页面相关改动。
> 当前状态：代码已实现并通过内存模式及前端验证；工作区尚未提交或推送 Git。

## 1. 审查范围

本报告对应以下用户需求：

1. Web 聊天界面发送消息。
2. 长按消息气泡显示“撤回”，消息发送后 5 分钟内可撤回本人和本人 AI 的消息。
3. 房主删除房间。
4. 发送图标颜色和透明度跟随自己的气泡设置。
5. 新增“世界”页面，房主可以公开展示自己的房间；访客可以查看房间详情并复制邀请码。

工作区还包含这些需求之前的认证、邀请、Agent 可见性、长轮询等改动。本报告只把它们作为现有上下文，不将其重新归因于本轮“世界”功能。

## 2. 需求到实现的映射

| 需求 | 主要实现 | 验收结果 |
| --- | --- | --- |
| 发送消息 | `SendBar`、`sendMessage()`、`POST /v1/rooms/:roomId/messages` | Enter 发送，Shift+Enter 换行，成功后消息进入列表 |
| 长按撤回 | `MessageItem` 500ms 长按、移动取消、右键和键盘菜单 | 仅本人可撤回；前端菜单显示“撤回” |
| 五分钟窗口 | 服务端 `MESSAGE_RECALL_WINDOW_MS` + 创建时间校验 | 超时返回 `recall_window_expired` |
| 本人 AI 消息 | 服务端按 `message.sender.userId` 判断发送者归属 | 房主可撤回其 AI 消息，其他成员不能撤回 |
| 实时撤回 | `message.recalled` WebSocket 事件 + `REPLACE_MESSAGE` | 所有在线成员同步显示“消息已撤回” |
| 删除房间 | 房主专属 `DELETE /v1/rooms/:roomId` | 二次确认；删除后返回房间列表 |
| 删除实时同步 | `room.deleted` WebSocket 事件 | 其他客户端移除房间并离开房间页 |
| 气泡颜色/透明度 | CSS `--bubble-self-top`、`--bubble-opacity` | 发送图标使用同一颜色和透明度 |
| 世界列表 | `WorldPage`、`GET /v1/world/rooms` | 卡片显示房间名、房主名、简介摘要 |
| 世界详情 | 卡片弹窗 | 显示卡片信息、简介、邀请码、有效期、剩余次数和复制按钮 |
| 世界发布管理 | `PUT /v1/rooms/:roomId/world` | 仅房主可发布、编辑简介、取消分享 |

## 3. 后端改动

### 3.1 HTTP 路由和 Web 权限

主要文件：[`src/server.mjs`](../src/server.mjs)

- 新增 `GET /v1/world/rooms`，要求已认证用户，返回当前有效的世界房间。
- 新增 `GET /v1/world/rooms/:roomId`，仅在房间仍公开且邀请码有效时返回邀请码详情。
- 新增 `PUT /v1/rooms/:roomId/world`，请求体为 `{ published, summary }`，要求 `Operation-Id`。
- 新增 `POST /v1/rooms/:roomId/messages/:messageId/recall`。
- 原有 `DELETE /v1/rooms/:roomId` 保留并接入 Web 房主删除流程。
- `isAllowedWebMutation()` 明确允许 Web 会话发送消息、撤回、删除房间和世界发布；非允许的 Web 状态变更仍返回 `web_read_only`。

### 3.2 Memory/PostgreSQL 双存储

主要文件：[`src/group_chat_store.mjs`](../src/group_chat_store.mjs)

两种存储均实现同一组行为：

- `recallMessage()`：
  - 先验证房间成员关系。
  - 以 `message.sender.userId === userId` 判断是否为本人消息，因此本人发布的 Agent 消息也可撤回。
  - 服务端按 `createdAt + 5 分钟` 判断窗口，不能由客户端传入截止时间。
  - 撤回后设置 `recalledAt`，清空消息内容并清除回复指向；重复调用返回已撤回消息。
  - 写入 `message.recalled` outbox 事件，唤醒 WebSocket 推送。

- `deleteRoom()`：
  - 仅房主可执行。
  - PostgreSQL 先显式删除消息和生成请求，再删除房间；房间成员、邀请、Agent 绑定、Web 已读状态等其余直接关联数据依赖数据库外键 `ON DELETE CASCADE`。
  - 通过 `room.deleted` 事件通知在线客户端。

- `updateWorldRoom()`：
  - 仅房主可执行。
  - 发布时复用有效邀请码，否则生成新的世界邀请码。
  - 默认有效期 30 天、最多 100 次使用。
  - 取消分享时撤销邀请码并从世界列表移除。

### 3.3 数据库迁移

- [`migrations/008_message_recall.sql`](../migrations/008_message_recall.sql)：为 `messages` 增加 `recalled_at`。
- [`migrations/009_world_rooms.sql`](../migrations/009_world_rooms.sql)：为 `rooms` 增加：
  - `world_published`
  - `world_summary`
  - `world_invite_id`
  - `world_invite_token`
  - `world_published_at`
  - 简介长度不超过 300 字符的约束
- [`migrations/010_world_invite_fk.sql`](../migrations/010_world_invite_fk.sql)：为 `rooms.world_invite_id` 增加指向 `room_invites(id)` 的 `ON DELETE SET NULL` 外键，避免悬空关联。
- [`src/migrations.mjs`](../src/migrations.mjs) 显式注册 008、009 两个迁移。

世界邀请码的哈希仍写入 `room_invites.token_hash`，同时在 `rooms.world_invite_token` 保留可展示的明文邀请码，以支持世界详情页复制功能。这是本轮需要重点审查的存储取舍。

## 4. 前端改动

### 4.1 聊天页

主要文件：

- [`frontend/src/components/SendBar.tsx`](../frontend/src/components/SendBar.tsx)
- [`frontend/src/components/MessageItem.tsx`](../frontend/src/components/MessageItem.tsx)
- [`frontend/src/components/MessageList.tsx`](../frontend/src/components/MessageList.tsx)
- [`frontend/src/pages/RoomPage.tsx`](../frontend/src/pages/RoomPage.tsx)
- [`frontend/src/store/reducer.ts`](../frontend/src/store/reducer.ts)

行为要点：

- 发送按钮在空文本或发送中禁用；发送使用客户端消息 ID 作为幂等键。
- 消息气泡长按 500ms 后显示菜单，移动超过 8px 会取消长按，避免滚动误触。
- 桌面端同时支持右键和键盘 ContextMenu/Shift+F10。
- 菜单只在消息仍处于 5 分钟窗口且发送者为当前用户时出现。
- 撤回后显示灰色斜体“消息已撤回”，回复摘要也不再展示原文。
- `REPLACE_MESSAGE` 处理撤回推送；`REMOVE_ROOM` 清理本地房间、消息和游标状态。

### 4.2 “世界”页面

主要文件：

- [`frontend/src/pages/WorldPage.tsx`](../frontend/src/pages/WorldPage.tsx)
- [`frontend/src/api/rooms.ts`](../frontend/src/api/rooms.ts)
- [`frontend/src/App.tsx`](../frontend/src/App.tsx)
- [`frontend/src/pages/RoomListPage.tsx`](../frontend/src/pages/RoomListPage.tsx)
- [`frontend/src/types.ts`](../frontend/src/types.ts)

页面路径为 `/world`，由房间列表页“世界”按钮进入。页面包含：

- 正在分享的房间卡片、加载骨架、空状态和手动刷新。
- 房间详情弹窗：房间名、房主、简介、邀请码、剩余次数、有效期、复制按钮。
- 列表接口只返回卡片摘要；点击卡片后再请求 `GET /v1/world/rooms/:roomId` 获取邀请码详情，避免一次列表请求批量暴露所有邀请码。
- 我的房间管理区：分享到世界、编辑展示信息、取消分享。
- Escape 键、点击遮罩和关闭按钮均可关闭弹窗。
- 移动端切换为单列卡片和纵向管理操作。

### 4.3 外观设置

主要文件：[`frontend/src/appearance.ts`](../frontend/src/appearance.ts)、[`frontend/src/index.css`](../frontend/src/index.css)。

气泡颜色和透明度通过 CSS 变量统一应用；发送图标使用 `--bubble-self-top` 与 `--bubble-opacity` 计算后的颜色，避免图标和自己的消息气泡产生视觉不一致。

## 5. 测试与验证证据

本次已执行：

```text
npm.cmd run check                 通过
npm.cmd test                      65 pass, 0 fail, 7 skip
frontend: npm.cmd test            11 pass, 0 fail
frontend: npm.cmd run lint        通过
frontend: npm.cmd run build       通过
frontend: npm.cmd run test:e2e    1 passed
git diff --check                 无差异错误
```

后端新增/扩展测试覆盖：

- 世界发布、编辑/取消分享、邀请码接受和非房主 403。
- 消息五分钟窗口、过期撤回拒绝、Agent 消息撤回、实时撤回事件。
- Web 发送消息、删除房间和只读 Web mutation 边界。

前端 E2E 覆盖：

- 登录并加载房间。
- 发送消息。
- 长按消息并撤回。
- 移动端消息布局。
- 气泡颜色、透明度和背景设置。
- 进入世界、发布房间、查看简介和邀请码、复制入口。
- 删除房间。

## 6. 交叉审查重点与剩余风险

1. **PostgreSQL 未在本环境实测**：当前未配置 `TEST_DATABASE_URL`，7 个 PostgreSQL 测试跳过。部署前必须先运行 `npm.cmd run db:migrate`，再使用真实 PostgreSQL 测试迁移和世界功能。
2. **世界发布接口的 `Operation-Id`**：路由要求该请求头，但当前发布/取消分享逻辑没有像部分既有写操作一样保存完整重放结果；重复点击不会重复生成有效邀请码，但可能重复增加房间 revision，建议审查是否需要补齐幂等语义。
3. **删除房间不可逆**：删除操作使用浏览器确认框，没有回收站或撤销机制；这符合当前“删除房间”需求，但生产使用前应确认数据保留策略。
4. **级联删除依赖数据库迁移**：房间成员、邀请、Agent 绑定等清理依赖既有外键的 `ON DELETE CASCADE`；新迁移已补充 `world_invite_id` 外键，但仍应在真实 PostgreSQL 上执行删除回归测试。
5. **当前工作区混有其他未提交改动**：本报告不代表所有工作区文件都属于“世界”功能；提交时应按实际 diff 分组，尤其不要误提交 `chuanhuatong-admin-deploy-a250199.tar.gz` 等来源不明归档文件。

审查反馈中的 Memory/PostgreSQL 撤回结构差异已核对并修正：当前 Memory 撤回消息同样写入 `{ schemaVersion: 1, type: 'text', text: '' }`，与 PostgreSQL 一致。

## 7. 部署前检查顺序

```powershell
npm.cmd run db:migrate
cd frontend
npm.cmd run build
cd ..
npm.cmd test
```

确认通过后重启后端服务。若使用内存模式，重启会清空用户、房间、消息和世界发布数据；生产环境应使用 PostgreSQL。

## 8. 本轮文件索引

新增核心文件：

- `frontend/src/components/SendBar.tsx`
- `frontend/src/pages/WorldPage.tsx`
- `migrations/008_message_recall.sql`
- `migrations/009_world_rooms.sql`
- `migrations/010_world_invite_fk.sql`

核心修改文件：

- `src/server.mjs`
- `src/group_chat_store.mjs`
- `src/migrations.mjs`
- `frontend/src/App.tsx`
- `frontend/src/pages/RoomPage.tsx`
- `frontend/src/components/MessageItem.tsx`
- `frontend/src/store/reducer.ts`
- `frontend/src/index.css`
- `test/server.test.mjs`
- `frontend/e2e/read-only.spec.ts`
