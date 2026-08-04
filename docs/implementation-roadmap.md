# 传话筒 MCP 实施路线

> 更新日期：2026-07-30
> 当前目标：只实现一个独立、标准的远程 MCP Server，不要求二次开发 Host
> 当前状态：13 个 MCP 工具已实现并部署；官方 SDK 线上双身份建房、邀请、加入和消息闭环已通过；`group_handoff_to_room` 原子交接已实现

## 1. 不可变边界

- 产品实现在仓库根目录，通过 HTTPS Streamable HTTP `/mcp` 对外提供能力。
- 任意兼容客户端都只是普通 MCP Host，不要求修改 Host 源码来实现群聊功能。
- 不依赖独立 Runner、Host 专用会话模式、定制消息列表或客户端后台服务。
- PostgreSQL 是房间、成员、消息顺序、幂等和 Agent 发布状态的唯一真相。
- MCP Server 不保存 Host 的模型 API Key、系统提示词、私人会话历史或推理过程。

标准 MCP 的能力边界必须保持清晰：Server 可以提供工具、资源和提示，但不能强制 Host 拦截普通聊天输入、改变 Host UI 或在 Host 未发起调用时持续驱动模型。第一版通过工具调用完成群聊闭环，不能把特定 Host 的专用行为写成验收条件。

## 2. 第一版用户闭环

一个支持远程 MCP 和工具调用的 Host 应能完成：

1. 使用 Bearer Token 连接 `/mcp`。
2. 创建房间，或使用一次性邀请码加入房间。
3. 列出可见房间并读取房间成员、Agent 和消息上下文。
4. 发送人类消息，按 `seq` 增量读取或等待新消息。
5. 对支持 Agent 执行的 Host，首次配置公开 Agent 身份，之后直接以结构化 Agent 身份发布回复；租约由发布工具自动恢复。

第一版消息范围为纯文本、结构化提及和回复引用。不实现图片、文件、语音、编辑、撤回或定制群聊 UI。

## 3. MCP 工具契约

### 房间与邀请

```text
group_create_room(clientRequestId, title)
group_create_invite(roomId, clientRequestId, expiresInSeconds, maxUses?)
group_join_room(clientRequestId, inviteCode)
group_list_rooms(limit?, cursor?)
group_get_room_context(roomId)
```

### 交接

```text
group_handoff_to_room(
  clientRequestId,
  title,
  contextSummary,
  decisions?,
  openQuestions?,
  inviteOptions?
)
```

- 一次 MCP 调用在单数据库事务内完成「建房 + 写入交接消息 + 创建邀请码」，杜绝建房成功但内容发送失败的半完成态。
- 交接消息由 Host AI 生成的结构化交接包组装：`contextSummary` 为背景、`decisions` 为已确认结论、`openQuestions` 为待讨论事项，服务端组装为一条带章节的消息。
- 组装后消息上限 32768 字符，超出返回 `invalid_request`；调用方应先摘要再拆分。
- sender 始终由 Bearer 身份派生，显示为当前用户；Server 不保存 Host 私有会话历史。
- 交接房间置 `historyVisibility=from_start`，邀请加入者从种子消息起可见，初始 `readSeq=joinedSeq-1`；普通房间保持 `after_join` 历史边界。
- 幂等：邀请码默认值在计算请求指纹前规范化；同一 `clientRequestId` 的等价参数重放结果一致，改参重放返回 `idempotency_conflict`。

- 建房人自动成为 owner。
- 只有 owner/admin 可以创建邀请。
- 加入房间必须提供有效邀请码，不能只凭 `roomId` 加入。
- `clientRequestId` 是稳定幂等键；同一键改参数返回 `idempotency_conflict`。
- 邀请码仅在创建结果中返回，数据库只保存哈希。

### 消息

```text
group_read_messages(roomId, afterSeq, limit)
group_wait_for_messages(roomId, afterSeq, timeoutMs)
group_send_message(roomId, clientMessageId, text, mentions?, replyToMessageId?)
```

- sender 始终由 Bearer 身份派生，调用方不能伪造。
- MCP 消息显式返回扁平的 `senderType=human|agent` 与 `senderDisplayName`；Host 不得根据昵称推断发送者类型。
- `messageId + seq` 是消息唯一真相。
- `nextSeq` 只前进到本页最后一条实际返回的消息，不能使用 `highWaterSeq` 跳页。
- 发送重试必须复用同一个 `clientMessageId`。

### Agent 发布

```text
group_activate_agent(roomId, publicProfile, runtimeCapabilitiesVersion, localConfigRevision)
group_heartbeat_agent(roomId, leaseId, leaseEpoch)
group_deactivate_agent(roomId, leaseId, leaseEpoch)
group_publish_agent_reply(
  roomId,
  triggerBatchId,
  triggerMessageIds,
  clientMessageId,
  text,
  publicProfile?,
  mentions?,
  replyToMessageId?
)
```

- Agent owner、设备和 sender 均由 Bearer session 与房间 Binding 派生。
- 租约使用 epoch fencing，旧设备不能续租或发布。
- 房间尚无 Agent Binding 时，首次回复可在 `group_publish_agent_reply.publicProfile` 中直接配置公开资料，在一次 MCP 调用内完成配置与发布；显式改资料或高级生命周期操作仍使用 `group_activate_agent`。
- `group_publish_agent_reply` 在现有 Binding 上自动恢复过期、缺失或策略版本落后的 Runtime，并用原幂等请求继续发布；其他设备持有有效租约时仍返回 `lease_conflict`。
- 同一人类消息周期内，每个 Agent 最多发布 1 条；房间连续 AI 消息总量不超过启用 Agent 数量，绝对上限 20。
- 发布成功返回 `nextAction=stop_current_turn`；重复发布返回 `agent_loop_limit_reached`、`retryable=false` 和相同终止动作，Host 不得换新 ID 重试。
- Server 只校验并发布结构化回复，不负责调用模型。

## 4. 通用协议约束

- 所有输入和输出使用严格 JSON Schema，`additionalProperties: false`。
- 所有列表、文本、ID、等待时间和邀请码寿命均有界。
- 成功结果同时提供 `structuredContent` 和文本 JSON。
- 业务失败返回稳定错误码，不伪装成功。
- ACL 是唯一授权依据；工具 annotations 只是 Host 提示。
- 写工具必须支持响应丢失后的幂等重试。

## 5. 安全优先级

功能闭环阶段保留以下底线：

- 公网只开放 `/mcp` 与 `/healthz`。
- MCP 请求必须认证，房间操作必须执行服务端 ACL。
- PostgreSQL 不开放公网端口，邀请码只存哈希，日志不得记录 Token 或邀请码。
- 使用 HTTPS，不把真实密钥写入源码、文档或测试。

以下加固延后到功能闭环之后：OAuth 2.1、公开注册、Token 自助撤销与轮换、分布式限流、完善审计和端到端加密。

## 6. 分阶段实施

### 阶段 1：MCP 基础能力（已完成并部署）

- 房间列表与上下文。
- 消息读取、等待和幂等发送。
- Agent 激活、心跳、停用和发布。
- 设备租约、发布生命周期与 AI 循环熔断。

### 阶段 2：房间自助管理（已完成并部署）

- `group_create_room`。
- `group_create_invite`。
- `group_join_room`。
- 覆盖创建重放、参数冲突、越权、一次性消费和严格 schema 测试。

### 阶段 3：标准 MCP 可用性闭环

- [已完成] 用官方 MCP SDK 验证 `serverInfo=chuanhuatong-mcp` 和精确 13 个工具。
- [已完成] 两个独立 Bearer 身份仅通过 MCP 完成建房、邀请、加入、幂等重放、发送和读取。
- 在不修改 Host 的前提下，用标准 MCP 工具调用完成建房、邀请、加入、发送和读取。
- 根据实际 Host 行为决定是否补充标准 MCP prompt/resource；不引入 Host 私有协议。

### 阶段 4：Agent 功能闭环

- [已完成并部署] MCP Agent 默认只响应人类消息，服务端拒绝 Agent 自触发；监听单次最多 5 秒并要求 Host 在空结果后结束当前回合。
- [已完成并部署] 消息增加显式人类/AI 类型；首次回复可内联配置 Agent，后续发布自动恢复 Runtime，普通回复不再依赖显式激活或心跳。
- 验证支持工具调用的 Host 能按上下文在有限调用次数内完成 Agent 生命周期和单次发布。
- 若 Host 不支持连续 Agent 调度，明确记录标准 MCP 边界，不转向修改特定 Host。
- 只在仍能保持单一 MCP 部署的前提下评估服务端模型编排；引入模型 Key 前必须另行确认安全和费用边界。

### 阶段 5：公开分发前加固

- OAuth 2.1、Protected Resource Metadata、audience/resource 校验。
- Token 撤销、轮换、审计与滥用防护。
- 多实例共享限流与实时通知。
- 数据导出、删除和隐私说明。

## 7. 当前验收标准

- `tools/list` 精确公开 13 个工具。
- 两个身份可以完全通过 MCP 创建/加入同一房间并交换消息。
- 邀请一次性消费、ACL、分页、幂等和乱序补偿均由服务器保证。
- 不需要任何 Host 源码修改或独立 Runner。
- `npm.cmd test --prefix server` 与 `npm.cmd run check --prefix server` 通过。
