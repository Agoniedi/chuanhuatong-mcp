# 改动技术报告：`group_handoff_to_room`「拉群继续」协作交接

> 日期：2026-08-03
> 用途：供其他 agent 对本轮改动做独立审查
> 审查重点：原子性、幂等、历史可见性语义变化、Postgres 未实测、zod 默认值坑

## 1. 背景与目标

用户希望在「个人先和 AI 把问题梳理清楚 → 拉个群把前情交给团队」这一协作断点上提供
一键交接。改造前 MCP 已能通过三步组合实现（`group_create_room` → `group_send_message`
→ `group_create_invite`），但**非原子**：可能房间建好、内容却没发进去，留下半完成态。

本轮目标（用户已确认的三个决策）：
1. **新增原子 MCP 工具** `group_handoff_to_room`——单数据库事务内完成「建房 + 写入交接
   消息 + 创建邀请码」，杜绝半完成态。
2. **结构化交接包**——参数为 `clientRequestId, title, contextSummary, decisions,
   openQuestions, inviteOptions`。
3. **仓库内 AGENTS.md**——写入「拉群继续」触发词工作流，AI 识别后自动执行。

不变边界：Server 不调用模型、不保存 Host 私有会话历史；交接消息由 Host AI 生成后作为
参数传入，发送者派生自 Bearer 身份（显示为当前用户）。

## 2. 设计决策与取舍

### 2.1 原子工具 vs. 靠 AI 组合三步
选原子工具。三步组合非原子，存在「房间创建成功但消息发送失败」的中间态；原子工具在
单事务内完成全部写入，失败整体回滚。代价是新增 store 复合方法（Memory + Postgres 各一）。

### 2.2 结构化交接包 vs. 单一 contextSummary 字符串
选结构化。`contextSummary`=背景、`decisions`=已确认结论、`openQuestions`=待讨论事项，
服务端组装成一条带章节的消息，契约稳定、必含各部分。单一字符串形式简单但服务端不强制
结构。

### 2.3 种子消息可见性（涉及既有隐私语义，专门向用户确认）
- **冲突**：现有 `acceptInvite` 设 `joinedSeq = last_seq + 1`，加入者看不到加入前消息；
  且 `rooms.history_visibility` 只有 `'after_join'` 一种取值（`001_initial.sql` 的 CHECK
  约束），`test/server.test.mjs:361` 显式断言「加入者看不到入群前历史」。
- **决策**：迁移 006 将 `history_visibility` 扩展为 `'after_join' | 'from_start'`，**仅交接
  房间**置 `from_start`；这类房间邀请加入者 `joinedSeq = 1`，从种子消息起可见。普通
  房间保持严格 after-join 隐私，现有行为与测试不受影响。

### 2.4 zod 嵌套默认值与幂等规范化
`inviteOptions` 使用 `.optional()`；handler 先物化 7 天 / 10 次的有效默认值，再用规范化后
的参数计算请求指纹并执行操作。省略选项与显式传入默认值因此属于同一个幂等请求。

## 3. 改动清单（文件级）

| 文件 | 改动 |
| --- | --- |
| `src/group_chat_store.mjs` | 新增模块级 `assembleHandoffMessage`；Memory 与 Postgres 各加 `handoffToRoom`；两处 `acceptInvite` 按 `historyVisibility` 条件化；交接消息 ID 使用固定长度哈希派生 |
| `src/mcp/group_chat_mcp_server.mjs` | 新增 `handoffInputSchema` / `handoffOutputSchema`；注册 `group_handoff_to_room` 工具 |
| `migrations/006_room_share_history_on_join.sql` | 扩展 `history_visibility` CHECK，允许 `from_start` |
| `src/migrations.mjs` | 迁移数组注册 `006_room_share_history_on_join`（该文件是显式数组，非自动发现） |
| `test/mcp/group_chat_mcp.test.mjs` | 两处精确工具数断言 12→13（line ~236、~331）；`writeTools` 列表加新工具；新增 3 个测试 |
| `test/postgres_store.test.mjs` | 新增 1 个 handoff 测试（受 `TEST_DATABASE_URL` 门控） |
| `README.md` | 工具清单加一行 + 一段行为说明 |
| `docs/implementation-roadmap.md` | 三处 12→13；新增「交接」契约块；状态行更新 |
| `AGENTS.md` | 新增（仓库根）：项目说明 + 「拉群继续」工作流 |

## 4. 工具契约

### 4.1 输入（zod strict，`additionalProperties: false`）
```text
group_handoff_to_room(
  clientRequestId: string(1..128),
  title:            string(1..120，非空 refine),
  contextSummary:   string(1..32768),
  decisions:        string(1..2000)[]  max 50, 默认 []
  openQuestions:    string(1..2000)[]  max 50, 默认 []
  inviteOptions:    { expiresInSeconds: int(60..2592000) 默认 7 天,
                      maxUses: int(1..100) 默认 10 }  可选
)
```
注意：`decisions`/`openQuestions` 单项 + `contextSummary` 合计可能超过 32768，**总长校验
在 store 的 `assembleHandoffMessage` 中执行**（抛 `HttpError 400 invalid_request`），zod
层只逐字段校验。

### 4.2 输出
```text
{ room:    roomSchema,      // ownerUserId=调用者，lastSeq=1
  message: messageSchema,   // senderType=human，senderDisplayName=调用者，seq=1
  invite:  inviteSchema     // inviteCode 为明文 token（22 位 base64url），DB 只存哈希
}
```
`inviteToken` 明文仅存在于响应与幂等重放记录中（与 `group_create_invite` 行为一致）。

### 4.3 错误码
- `idempotency_conflict`（409）：同一 `clientRequestId` 换参重放。
- `invalid_request`（400）：组装后文本超 32768。

### 4.4 幂等
单一 `key` = `clientRequestId`，单一 operation `'handoffToRoom'`，整个交接包原子且可重放；
邀请码选项先规范化再计算指纹；Postgres 侧经 `_replay`（`pg_advisory_xact_lock`）串行化。

## 5. store 实现要点

### 5.1 `assembleHandoffMessage`（模块级，两 store 共用）
```js
sections = [`# 背景\n${contextSummary}`]
  + (decisions.length ? `# 已确认结论\n- ${d.join('\n- ')}` : '')
  + (openQuestions.length ? `# 待讨论事项\n- ${q.join('\n- ')}` : '')
text = sections.join('\n\n');   // 空章节省略；总长 > 32768 抛错
```

### 5.2 Memory `handoffToRoom`
复用现有 `_replay`/`_saveReplay`/`roomSnapshot`/`inviteSummary`/`hash`/`newId`，组合
`createRoom` + `createHumanMessage` + `createInvite` 的既有构造逻辑。消息
`clientMessageId = handoff_${sha256(key)}`（派生、稳定且不超过 128 字符）。房间
`historyVisibility: 'from_start'`。push `message.created` 到 outbox。

### 5.3 Postgres `handoffToRoom`
整体包在 `this._transaction(...)` 内，复用 `_replay`/`_saveReplay`/`_room`/`_membership`
辅助函数。依次：
1. `INSERT rooms(... history_visibility='from_start' ...)` + `INSERT room_members(owner)`
   （房间 INSERT 直接带 `last_seq=1`，无需事后 UPDATE）。
2. `INSERT messages(seq=1, client_message_id=handoff_${sha256(key)})` + `INSERT outbox_events
   ('message.created')`。
3. `INSERT room_invites(token_hash=hash(token), remaining_uses=max_uses)`。
4. `_saveReplay(...)` 后再写 outbox。

### 5.4 acceptInvite 语义变化（重点审查项）
```js
joinedSeq = room.history_visibility === 'from_start' ? 1 : room.last_seq + 1
readSeq = joinedSeq - 1
```
- Memory：`room.historyVisibility`（room 对象内存态）。
- Postgres：`room.history_visibility`。
- 普通房间（`after_join`）行为不变，`test/server.test.mjs:361` 的 joinedSeq=2 断言仍通过；
  交接房间从返回的 `readSeq=0` 继续读取即可得到 seq=1 的种子消息。

## 6. 测试

### 6.1 新增 MCP 测试（Memory store，`test/mcp/group_chat_mcp.test.mjs`）
1. **成功路径**：一次调用返回 room（owner=调用者、lastSeq=1）、message（human、
   含「背景/已确认结论/待讨论事项」章节）、invite（inviteCode≥22）；重放 deepEqual。
2. **幂等**：省略邀请码选项后用显式默认值重放结果一致；改 `contextSummary` 重放 →
   `idempotency_conflict`。
3. **邀请加入闭环**：Bob 用 inviteCode `group_join_room` → `group_get_room_context`
   （members=2）→ 从返回的 `readSeq=0` 调用 `group_read_messages` 读到种子消息。
4. **校验**：空 title / contextSummary 32769 / 组装后超长（contextSummary 32000 +
   decision 2000）/ 未知字段（strict）→ 均 `isError`。

### 6.2 新增 Postgres 测试（`test/postgres_store.test.mjs`，需 TEST_DATABASE_URL）
并发 `handoffToRoom` 重放 deepEqual；room/message/invite 三者持久化；他人经 invite
加入后 `joinedSeq === 1`、`readSeq === 0`，且能从该游标读到种子消息。

### 6.3 结果
```
tests 53, suites 4, pass 47, fail 0, skipped 6
```
跳过 6 个均为需 `TEST_DATABASE_URL` 的 Postgres 用例（含新增 1 个）。

## 7. 已知限制 / 审查关注点

1. **Postgres 与迁移未实测**：本地无数据库，迁移 006 与 Postgres store 用例未真正执行。
   需 `TEST_DATABASE_URL` 验证；部署需先跑 `npm run db:migrate`（或 `RUN_MIGRATIONS=1`），
   否则数据库约束不接受 `from_start`，交接功能直接报错。
2. **acceptInvite 全局条件化**：虽然只在 `history_visibility='from_start'` 时改变 joinedSeq，
   但该分支处于公共加入路径，需确认并发 join 与现有「加入后看不到历史」测试仍通过。
3. **组装上限的校验位置在 store 而非 zod**：`decisions`/`openQuestions` 单项各 ≤2000、
   最多 50 条，与 contextSummary 合计可超 32768，由 store 抛 `invalid_request`。zod 层无法
   表达「合计 ≤32768」这类跨字段约束，故放在 store（Memory 与 Postgres 共用同一函数，
   行为一致）。
4. **明文 invite token 进幂等重放记录**：与既有 `createInvite` 一致，属于既有设计，非本轮
   引入。

## 8. 验证步骤

```powershell
npm.cmd run check                          # 语法检查
npm.cmd test                               # 内存模式全量测试
$env:TEST_DATABASE_URL = 'postgresql://<user>:<pass>@127.0.0.1:5432/<db>'
npm.cmd test                               # 含 Postgres 真实用例（需先迁移）
```

## 9. 影响面小结

- 新增工具不会影响既有 12 个工具的契约与行为。
- 普通房间加入语义不变（唯一分支改动受 `history_visibility='from_start'` 门控）。
- 需数据库迁移（006），部署顺序：迁移先行。
- AGENTS.md 为仓库级，影响范围仅限本仓库目录下的 AI 会话。
