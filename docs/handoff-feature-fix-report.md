# `group_handoff_to_room` 功能修复报告

> 日期：2026-08-04
> 范围：修复独立审查发现的 4 项问题
> 状态：代码与内存模式回归测试已通过；PostgreSQL 真实环境待验证

## 1. 修复结论

| 编号 | 严重度 | 问题 | 状态 |
| --- | --- | --- | --- |
| 1 | P1 | 最大长度请求 ID 导致写入成功但 MCP 输出失败 | 已修复 |
| 2 | P1 | 交接房间公开的历史策略与实际权限不一致 | 已修复 |
| 3 | P2 | 新成员的 `readSeq` 跳过种子交接消息 | 已修复 |
| 4 | P2 | 省略默认参数与显式默认参数产生幂等冲突 | 已修复 |

四项修复均保留原有产品边界：服务端不读取 Host 私有会话历史，不调用模型，交接内容仍由
Host AI 生成并由当前 Bearer 身份作为人类消息发布。

## 2. 问题 1：最大长度请求 ID 导致端到端失败

### 2.1 原问题

`clientRequestId` 的公开输入上限为 128 字符。旧实现使用
`${clientRequestId}#handoff` 生成种子消息的 `clientMessageId`，最大长度会达到 136 字符，
超过 MCP `messageSchema` 的 128 字符限制。

数据库事务已经完成建房、写入消息和创建邀请后，MCP SDK 才校验输出。结果是数据已提交，
但调用方收到 `-32602 Output validation error`，且同一幂等键重试仍会重放无法通过校验的
结果，调用方无法取得已创建的邀请码。

### 2.2 修复

新增固定长度派生函数：

```js
function handoffMessageId(key) {
  return `handoff_${hash(key)}`;
}
```

SHA-256 十六进制摘要为 64 字符，加前缀后总长 72 字符。Memory 与 PostgreSQL store 使用
同一函数，因此任意合法 `clientRequestId` 都不会再生成超出输出契约的消息 ID。

### 2.3 回归覆盖

新增最大边界测试：使用 128 字符 `clientRequestId` 调用工具，断言调用成功且返回的
`clientMessageId.length <= 128`。

## 3. 问题 2：历史可见性契约不真实

### 3.1 原问题

旧实现通过内部 `share_history_on_join` 布尔字段让交接房间的新成员从 seq=1 开始读取，
但公开房间快照仍返回 `historyVisibility: 'after_join'`。客户端无法判断交接房间允许读取
入群前历史，成员也可能错误理解房间的隐私边界。

### 3.2 修复

移除隐藏布尔语义，直接扩展既有公开字段：

```text
historyVisibility = after_join | from_start
```

- 普通房间继续使用 `after_join`。
- 交接房间创建时使用 `from_start`。
- Memory `roomSnapshot` 返回房间真实值。
- PostgreSQL `rowToRoom` 继续直接映射 `rooms.history_visibility`。
- MCP `roomSchema` 同步接受两个枚举值。
- 邀请加入逻辑按 `history_visibility === 'from_start'` 决定 `joinedSeq`。

迁移 006 修改 `rooms_history_visibility_check`，允许 `after_join` 和 `from_start` 两种取值，
不再新增 `share_history_on_join` 列。

### 3.3 回归覆盖

Memory MCP 测试断言创建和加入交接房间时均返回 `from_start`。PostgreSQL 测试增加相同
断言。现有普通房间测试继续断言 `after_join` 和入群前历史不可见。

## 4. 问题 3：加入游标跳过种子消息

### 4.1 原问题

交接房间的新成员获得 `joinedSeq=1`，但旧实现仍把 `readSeq` 初始化为当前
`room.lastSeq=1`。客户端若从返回的 `readSeq` 继续读取，只会查询 seq>1 的消息，从而跳过
本应首先展示的种子交接内容。

原测试固定使用 `afterSeq=0`，没有覆盖从加入响应游标继续读取的真实流程。

### 4.2 修复

Memory 与 PostgreSQL 的新成员初始化统一改为：

```js
readSeq = joinedSeq - 1;
```

该规则同时覆盖两种房间：

- 交接房间：`joinedSeq=1`、`readSeq=0`，种子消息处于可读取状态。
- 普通房间：`joinedSeq=lastSeq+1`、`readSeq=lastSeq`，原有行为不变。

### 4.3 回归覆盖

MCP 测试改为读取加入响应中的 `membership.readSeq`，再将其作为
`group_read_messages.afterSeq`，断言能够读到 seq=1 的种子消息。PostgreSQL 测试增加同样
的游标衔接断言。

## 5. 问题 4：等价默认参数发生幂等冲突

### 5.1 原问题

旧 schema 使用 `z.object({...}).default({})`。整个 `inviteOptions` 缺省时，Zod 直接返回
`{}`，不会继续应用内部字段默认值；显式传入默认值时，解析结果则包含完整字段。两种输入
执行行为相同，但用于计算幂等指纹的对象不同：

```json
{"inviteOptions": {}}
```

```json
{"inviteOptions": {"expiresInSeconds": 604800, "maxUses": 10}}
```

因此相同 `clientRequestId` 的等价重试会返回 `idempotency_conflict`。

### 5.2 修复

`inviteOptions` 改为可选对象。handler 在调用 store 前先生成规范化参数：

```js
const inviteOptions = {
  expiresInSeconds: args.inviteOptions?.expiresInSeconds ?? 604800,
  maxUses: args.inviteOptions?.maxUses ?? 10,
};
```

规范化结果同时用于创建邀请和计算请求指纹。省略整个对象、传入空对象或显式传入默认值，
都会得到相同的有效参数和幂等指纹；真正改变参数仍会返回 `idempotency_conflict`。

### 5.3 回归覆盖

新增等价重放断言：首次省略 `inviteOptions`，随后用同一 `clientRequestId` 显式传入
7 天 / 10 次，返回结果必须与首次调用完全一致。

## 6. 影响文件

| 文件 | 修复内容 |
| --- | --- |
| `src/group_chat_store.mjs` | 固定长度交接消息 ID；真实历史策略；加入游标修复 |
| `src/mcp/group_chat_mcp_server.mjs` | 历史策略枚举；邀请码默认参数规范化与指纹修复 |
| `migrations/006_room_share_history_on_join.sql` | 扩展 `history_visibility` CHECK |
| `test/mcp/group_chat_mcp.test.mjs` | 四项问题的 MCP 回归覆盖 |
| `test/postgres_store.test.mjs` | 历史策略和加入游标的 PostgreSQL 断言 |
| `README.md` | 更新交接房间公开契约和读取游标说明 |
| `docs/implementation-roadmap.md` | 更新交接契约与幂等说明 |
| `docs/handoff-feature-change-report.md` | 同步最终实现与剩余风险 |

## 7. 验证结果

已执行：

```text
node --test --test-name-pattern="handoff" test/mcp/group_chat_mcp.test.mjs
  tests 3, pass 3, fail 0

npm.cmd test
  tests 53, pass 47, fail 0, skipped 6

npm.cmd run check
  pass

git diff --check
  pass
```

跳过的 6 项均需要 `TEST_DATABASE_URL`，包括新增的 PostgreSQL 交接测试。

## 8. 尚未完成的验证

当前环境没有可用的 PostgreSQL/psql，Docker Desktop 引擎也未启动，因此以下项目尚未实际
执行：

1. 在真实 PostgreSQL 上应用迁移 006。
2. 验证 `rooms_history_visibility_check` 从单值约束扩展为双值约束。
3. 运行 PostgreSQL store 的并发幂等、持久化、邀请加入和读取游标测试。

部署前应在专用测试数据库设置 `TEST_DATABASE_URL` 后重新执行 `npm.cmd test`。迁移必须先于
包含 `group_handoff_to_room` 的服务版本部署。
