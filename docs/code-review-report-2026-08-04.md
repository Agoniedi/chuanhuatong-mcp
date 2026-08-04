# 传话筒 MCP 整体代码审查报告

- 审查日期：2026-08-04
- 审查对象：修补前的工作区代码（包含尚未提交的 `group_set_display_name` 改动）
- 审查方式：静态代码审查、差异审查、内存模式测试、语法检查、依赖审计

> 修补状态：本报告列出的 5 项主要问题已于 2026-08-04 完成修补。第 3 节保留原始发现和修补前行号作为审计记录，实际修改与复验结果见第 8 节。

## 1. 审查结论

当前实现的主体结构清晰，内存存储与 PostgreSQL 存储的主要行为基本一致，MCP、REST、WebSocket 的职责边界也比较明确。现有自动化测试全部通过，但仍发现 5 项需要处理的问题：

| 优先级 | 问题 | 主要影响 |
| --- | --- | --- |
| P1 | 凭据撤销后，已建立的 WebSocket 不会失效 | 已撤销用户仍可持续接收房间实时消息 |
| P2 | 人类发送消息时未校验 agent mention | 可写入指向不存在或不属于房间的 agent 引用 |
| P2 | PostgreSQL 消息页与 `highWaterSeq` 不在同一快照 | 并发发送时可能出现消息序号高于返回水位 |
| P2 | 生成请求分页游标依赖可变的 `status` | 状态变化会使合法游标突然失效 |
| P2 | 生产依赖中存在已知漏洞版本 | `npm audit --omit=dev` 报告 1 个高危和 1 个中危问题 |

建议先处理 WebSocket 凭据撤销问题，再处理三个数据一致性问题，最后完成依赖升级和回归验证。

## 2. 审查范围与验证方法

本次重点检查了以下部分：

- MCP 工具注册、输入输出约束和身份使用方式；
- 内存存储与 PostgreSQL 存储的行为一致性；
- 房间、成员、消息、mention、生成请求和幂等记录；
- REST 鉴权、WebSocket 建连与凭据撤销；
- 当前新增的用户显示名修改工具；
- 测试覆盖、语法检查、依赖锁文件和生产依赖审计。

本报告不包含压力测试、真实 PostgreSQL 并发测试、外部渗透测试和生产环境配置审查。

## 3. 详细发现

### 3.1 P1：凭据撤销后，现有 WebSocket 仍持续有效

**证据**

- `src/server.mjs:370-393` 只在 WebSocket HTTP upgrade 阶段调用 `authUser`。
- 建连后，连接仅按 `user.userId` 保存在 `socketsByUserId` 中，没有保存或重新检查 session/device 身份。
- `scripts/admin_credentials.mjs:241-246` 撤销凭据时只删除 `sessions` 表中的记录，没有通知服务进程关闭对应连接。

**影响**

管理员撤销某个 token/device 后，新请求会鉴权失败，但已经建立的 WebSocket 在主动断线或服务重启前仍可继续收到该用户房间的实时事件。这会使“撤销凭据”的实际行为与管理员预期不一致，并可能造成房间消息继续泄露给已撤销客户端。

**触发条件**

1. 客户端使用有效 token 建立 `/v1/realtime` WebSocket；
2. 管理员通过凭据脚本撤销对应 device/session；
3. 房间中产生新事件；
4. 原 WebSocket 连接仍能收到事件。

**修复建议**

在连接索引中同时记录 `deviceId` 或 session 标识，并建立明确的撤销传播机制。最直接的实现是让服务端负责撤销操作，并在删除 session 后立即关闭对应 socket；如果必须保留独立管理脚本，则需要通过数据库通知、内部管理接口或短周期 session 复核将撤销事件传给服务进程。

**建议测试**

- 建立 WebSocket 后撤销当前 device，断言连接被关闭；
- 撤销一个 device 不应关闭同一用户的其他有效 device；
- 撤销后重新连接必须鉴权失败；
- 多进程部署时，每个实例上的对应连接都应失效。

### 3.2 P2：人类消息允许不存在的 agent mention

**证据**

- PostgreSQL 路径 `src/group_chat_store.mjs:4381-4393` 只提取并校验 `mention.kind === 'user'` 的目标。
- 内存路径 `src/group_chat_store.mjs:1744-1748` 同样只校验用户 mention。
- agent 发布消息的路径已经校验 agent mention，可参考 `src/group_chat_store.mjs:4050-4061`。

**影响**

人类消息可以携带一个不存在、已删除或不属于当前房间的 agent ID。数据库会保存这类无效引用，消费者无法可靠解析 mention，内存与 PostgreSQL 都会接受同样的错误数据。

**修复建议**

复用 agent 消息发布路径的验证规则：分别收集 user 和 agent mention，确认用户是房间成员，同时确认 agent 存在且属于该房间。保持两种发送者路径的错误码和错误信息一致。

**建议测试**

- 人类 mention 当前房间内的 agent 成功；
- mention 不存在、其他房间或已删除的 agent 返回 `invalid_request`；
- 同一目标重复出现时验证逻辑不应因计数方式误判；
- 内存与 PostgreSQL 用例应给出相同结果。

### 3.3 P2：PostgreSQL 消息页与 `highWaterSeq` 不在同一快照

**证据**

`src/group_chat_store.mjs:4343-4356` 先通过 `_room(this.pool, roomId)` 读取 `rooms.last_seq`，随后使用另一次独立查询读取消息列表。两次查询没有放入同一个事务快照，也没有把消息查询限制到已读取的 `last_seq`。

**影响**

如果在两次查询之间有新消息提交，返回的 `items` 可能包含 `seq > highWaterSeq` 的消息。当前 README 已说明 `highWaterSeq` 仅供参考，客户端不应拿它跳页，因此不一定直接丢消息，但服务端返回值内部仍然自相矛盾，容易让客户端统计、同步或诊断逻辑出错。

**修复建议**

选择并明确一种契约：

1. 在同一事务快照中读取 room 和 messages；或
2. 将消息查询增加 `seq <= highWaterSeq` 条件，使返回页严格受已读取水位限制；或
3. 在读完消息后计算并返回不小于最后一条消息序号的水位，同时更新接口语义和测试。

如果 `highWaterSeq` 表示“本次读取开始时的房间水位”，方案 2 最简单且最容易验证。

**建议测试**

- 在读取 room 后、读取 messages 前并发插入新消息；
- 断言所有返回消息的 `seq <= highWaterSeq`；
- 连续翻页不丢失、不重复已确认范围内的消息。

### 3.4 P2：生成请求分页游标依赖可变的 `status`

**证据**

- PostgreSQL 路径 `src/group_chat_store.mjs:3582-3589` 解析 `pageToken` 时要求游标记录仍满足当前 `status = ANY(...)`。
- 内存路径 `src/group_chat_store.mjs:1238-1254` 先按当前状态过滤，再在过滤结果中查找游标。

**影响**

用户读取第一页后，如果作为游标的最后一项在读取下一页前发生状态变化，它会从过滤集合中消失。原本由服务端签发的合法 `pageToken` 随即变成 `invalid_request`，导致正常分页流程中断。生成请求的状态本身就是预期会变化的，因此该问题不是纯理论场景。

**修复建议**

游标应基于不可变排序键，例如编码后的 `(createdAt, id)`，而不是要求游标实体继续满足可变过滤条件。PostgreSQL 和内存实现应使用同一游标格式和同一比较规则。

**建议测试**

- 读取第一页后改变游标项状态，再读取第二页；
- 改变非游标项状态时分页保持确定性；
- 相同 `createdAt` 下使用 `id` 作为稳定的次级排序键；
- 非法、篡改或与当前用户无关的游标仍返回 `invalid_request`。

### 3.5 P2：生产锁文件包含已知漏洞依赖

**证据**

- `package-lock.json:450-451` 锁定 `fast-uri@3.1.4`；
- `package-lock.json:587-588` 锁定 `hono@4.12.32`；
- 两者均由当前 `@modelcontextprotocol/sdk@1.30.0` 依赖链引入；
- `npm audit --omit=dev` 返回 1 个高危和 1 个中危漏洞。

**影响**

`fast-uri` 会随 SDK 默认的 AJV 验证器加载，不能仅因项目没有直接导入它就视为完全不可达。Hono 的 CORS 漏洞在当前服务调用路径中的可达性较低，但锁文件仍会使生产依赖审计失败，也会增加后续部署和供应链合规风险。

**修复建议**

优先升级 `@modelcontextprotocol/sdk` 到包含修复后传递依赖的兼容版本，并检查锁文件实际解析出的 `fast-uri` 与 `hono` 版本。不要只手工修改 lockfile；升级后应重新运行 MCP 契约测试和 `npm audit --omit=dev`。

**建议测试**

- `npm audit --omit=dev` 不再报告上述漏洞；
- MCP 初始化、`tools/list`、工具调用和错误响应测试全部通过；
- 对 URI/schema 校验相关输入补充一次回归测试。

## 4. 用户显示名 MCP 工具专项结论

当前未提交改动新增了：

```text
group_set_display_name(clientRequestId, displayName)
```

该设计符合此项目“独立 MCP Server”的定位，没有增加前端页面或要求宿主软件改造。工具修改的是当前 token 对应的人类身份显示名，并保持以下行为：

- token、`userId`、房间成员关系和历史记录不变；
- 以后发送的人类消息使用新名字；
- 已发送消息保留发送时的名字快照；
- 名字会去除首尾空白，长度限制为 1 至 80；
- 与其他用户重名时返回冲突；
- 通过 `clientRequestId` 保持写操作幂等。

通用 MCP 协议没有统一字段可让服务端自动读取 Codex、ChatGPT 或其他宿主软件中配置的用户名，因此让用户明确说“把我在传话筒群聊里的名字改成张三”，再由宿主调用该工具，是目前最直接且可移植的实现。

专项审查未发现该改名工具存在明确的功能性缺陷。需要注意：PostgreSQL 真实数据库路径尚未在本机执行，因此其唯一索引冲突和事务行为目前只经过静态审查及测试代码覆盖，未经过真实数据库验证。

## 5. 测试与检查结果

| 检查 | 结果 |
| --- | --- |
| `npm.cmd test` | 54 项：48 通过、0 失败、6 跳过 |
| MCP 定向测试 | 26/26 通过 |
| 核心源文件 `node --check` | 通过 |
| `git diff --check` | 通过 |
| `npm audit --omit=dev` | 失败：1 个高危、1 个中危 |
| PostgreSQL 真实用例 | 未运行：未设置 `TEST_DATABASE_URL` |
| Docker 集成验证 | 未运行：Docker Desktop daemon 未启动 |

跳过的 6 项测试均依赖 `TEST_DATABASE_URL`，不能把当前结果等同于 PostgreSQL 路径已经完整验证。

## 6. 低优先级测试与运维空白

以下内容暂不构成明确的线上缺陷，但建议纳入后续维护：

- `npm run check` 目前只执行 `node --check src/server.mjs`，不会独立检查 store、MCP server 和脚本文件；
- `idempotency_records` 没有清理机制，长期运行后会持续增长；
- 已派发的 `outbox_events` 没有归档或清理机制，长期运行后也会持续增长；
- 缺少真实 PostgreSQL 环境下的并发、事务和约束回归结果。

## 7. 原建议处理顺序

1. 修复凭据撤销后 WebSocket 不失效的问题，并加入端到端测试；
2. 补齐人类消息的 agent mention 校验；
3. 统一消息水位语义和 PostgreSQL 查询快照；
4. 将生成请求分页改为不可变复合游标；
5. 升级 MCP SDK 依赖链并清除生产审计漏洞；
6. 在真实 PostgreSQL 环境运行全套测试，再决定是否发布当前改名工具。

## 8. 修补结果

已完成以下修改：

- 实时事件发送前按 `userId + deviceId` 复核 session；已撤销连接不再接收下一条事件，并以 WebSocket `1008` 关闭；
- 人类消息在内存和 PostgreSQL 路径都校验 agent mention 必须绑定在当前房间；
- PostgreSQL 消息查询增加 `seq <= highWaterSeq` 上界；
- 生成请求分页游标改为从不受状态筛选影响的原始记录读取不可变排序键；
- `fast-uri` 更新至 `3.1.5`，`hono` 更新至 `4.13.0`。

修补后验证结果：

| 检查 | 结果 |
| --- | --- |
| `npm.cmd test` | 56 项：50 通过、0 失败、6 跳过 |
| 相关源文件和测试文件 `node --check` | 通过 |
| `git diff --check` | 通过 |
| `npm audit --omit=dev` | 通过：0 个漏洞 |

跳过的 6 项仍为依赖 `TEST_DATABASE_URL` 的真实 PostgreSQL 用例；其中已加入 agent mention、并发消息水位和状态变化分页的回归覆盖，但本机尚未实际执行这些数据库用例。
