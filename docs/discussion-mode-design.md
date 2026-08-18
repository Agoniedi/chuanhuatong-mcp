# 群聊多 AI 讨论模式开发文档

> 版本：v1.0
> 更新日期：2026-08-04
> 状态：设计阶段
> 前置文档：[auto-poll-design.md](auto-poll-design.md)（`group_poll_messages` 长轮询工具）

---

## 1. 背景与需求

### 1.1 问题描述

在群聊中，用户希望能让房间里的多个 AI 围绕一个话题自主参与讨论：

> **用户给 AI 一个话题，AI 参与群聊讨论；AI 回复后长轮询新消息，有新消息就自动回复，不需要真人逐条触发；讨论结束后，用户可以让 AI 输出讨论过程。**

区别于 [auto-poll-design.md](auto-poll-design.md)（"发一条、等一条"的单次问答），本文档描述的是**多个 AI 持续互动、互相回复**的讨论场景。

### 1.2 用户场景

```
用户A：给 AI-A 下指令"加入房间讨论'接口方案'这个话题"
用户B：给 AI-B 下指令"也加入讨论，和 AI-A 一起聊这个话题"

AI-A：读取房间上下文 → 发布观点
AI-B：长轮询发现 AI-A 的新观点 → 发布回应
AI-A：长轮询发现 AI-B 的回应 → 继续反驳/补充
...（循环直至冷场或有人类插话/叫停）
AI-A：轮询超时（无新消息）→ 总结并输出整个讨论过程
```

### 1.3 架构前提（路径 A：客户端驱动）

- 每个 AI 由**自己的用户**通过 MCP 客户端驱动（长回合内循环调用工具）。
- 人都在场、各自指挥自己的 AI，**不需要服务器端跑模型**（排除路径 B 的服务器编排）。
- 服务器只提供能力，不强制 AI 行为；"是否继续讨论"由工具描述引导 AI 决定。

### 1.4 设计原则

- **不改动前端 App、不破坏 MCP 协议语义**：只在 chuanhuatong MCP 服务器内部做增量修改。
- **复用既有机制**：`triggerScope`、`createAutomaticGenerationRequest`、realtime outbox、`from_start` 历史都已存在。
- **最小改动**：优先考虑 `triggerScope` 隐式开启讨论模式，不引入新表。
- **防失控兜底**：任何情况下讨论都有硬性上限，不能无限循环。

---

## 2. 当前代码分析（已核实）

### 2.1 现状：服务器"故意"不允许 AI 互回

| 约束 | 代码位置 | 现状 |
|------|---------|------|
| `humanTriggersOnly` 硬编码 | `src/mcp/group_chat_mcp_server.mjs:372` | `group_publish_agent_reply` 强制 `humanTriggersOnly: true`，agent 消息不能作为触发 |
| 触发校验 | `src/group_chat_store.mjs:227` | `humanTriggersOnly && sender.kind !== 'human'` → `trigger_not_eligible` |
| 每周期每 agent 1 条 | `group_chat_store.mjs:244-280`、PG 内联 `:3902-3950` | `AGENT_MESSAGES_PER_CYCLE_LIMIT = 1`（`:9`） |
| 房间连续 AI 上限 | 同上 | `ABSOLUTE_CONSECUTIVE_AI_LIMIT = 20`（`:10`） |
| 工具描述 | `group_chat_mcp_server.mjs:715` | "Never use an agent message as a trigger"、"stop the current assistant turn" |

**后果**：
1. AI 不能以其他 AI 的消息为触发（`trigger_not_eligible`）。
2. 周期按"最后一条人类消息"划分；纯 AI 讨论没有新人类消息，周期不重置——**每个 AI 各发一条后整个房间被锁死**。
3. 因此现架构是严格的"一条人类消息 ↔ 每个 AI 各回一条"问答循环，不是讨论。

### 2.2 关键发现：`humanTriggersOnly` 是多余的

`requireEligibleAutomaticTriggers`（`group_chat_store.mjs:220-242`）已经完整实现 `triggerScope` 三种语义：

| `triggerScope` | 语义 | 代码 |
|----------------|------|------|
| `allMessages` | 任何消息都放行 | `:228` |
| `allHumanMessages` | 拒绝非人类 | `:229` |
| `mentionsOnly` | 要求提及本 agent | `:231` |

两套 store 的 `createAutomaticGenerationRequest` 参数默认 `humanTriggersOnly = false`（`:1126`、`:3377`）。

**结论**：MCP 工具层 `:372` 的 `humanTriggersOnly: true` 是**多余的额外保险丝**。删掉它、让 `triggerScope` 接管，行为对现有房间（`allHumanMessages`）完全不变，而 `allMessages` 房间获得"AI 互回"能力。

### 2.3 已具备的支撑机制

- `group_create_room` / 邀请 / 加入：多用户进同一房间 ✅
- `group_publish_agent_reply`：结构化 agent 发布 ✅
- `group_read_messages` / `group_wait_for_messages`：增量读取/短等待 ✅
- `historyVisibility=from_start`：讨论全程历史可见，供总结输出 ✅
- realtime outbox + WebSocket：消息实时通知（可选用）✅
- `PUT /v1/rooms/{id}/my-agent` 已支持 `triggerScope` 入参（`src/server.mjs:614-690`）✅

---

## 3. 设计方案

### 3.1 方案对比

| 方案 | 改动量 | 优点 | 缺点 |
|------|--------|------|------|
| **A. 隐式讨论模式**（本文推荐） | 小（~40 行 + 测试） | 复用 `triggerScope`，无新表，改动集中 | 无显式"会话"语义 |
| **B. 显式讨论会话** | 大（+200 行 + 迁移） | 有开始/结束、轮次预算，语义清晰 | 需要新表、新工具、迁移 |
| **C. 服务器编排**（路径 B） | 最大 | 真正无人值守 | 需要模型 Key、越过 roadmap 边界 |

**推荐方案：A。** 人都在场指挥 AI，隐式开关 + 工具描述引导已足够；会话对象等有需求再演进。

### 3.2 核心设计决策

**用 binding 的 `triggerScope = 'allMessages'` 作为"讨论模式"开关。**

讨论流程（AI 行为约定，写入工具描述）：

```
1. 用户给 AI 下指令，指定房间和话题
2. AI 读取房间上下文，发布首个观点（group_publish_agent_reply）
3. AI 调用 group_poll_messages 长轮询新消息（最长 60s）
4. 有新消息（人类或其他 AI）→ 生成回应并发布 → 回到 3
5. 轮询超时（空结果）→ 视为讨论静默 → 停止并总结讨论过程
```

### 3.3 防失控规则（替代"1 条/人类周期"）

```
1. 房间连续 AI 消息上限 = ABSOLUTE_CONSECUTIVE_AI_LIMIT（20）——硬兜底，保留
2. 同一 trigger 消息，同一 agent 不得重复回复（按 triggerMessageIds 去重）——防单 AI 刷屏
3. 冷场结束：AI 长轮询超时（空结果）视为讨论静默，停止并总结——纯工具描述引导，服务端零代码
```

### 3.4 开放决策（需评审确认）

以下决策直接影响改动规模，实现前必须确认。其中 **D1、D2 为必审项**，D3、D4 为次要项。

---

#### D1：讨论模式开关的形式

**问题**：讨论模式如何开启？

**选项 A（推荐）：`triggerScope='allMessages'` 隐式开启**

| 维度 | 说明 |
|------|------|
| 改动量 | 小，复用既有枚举，零新表 |
| 语义 | 无显式"会话"，开始/结束由 AI 行为约定（工具描述）而非服务端状态界定 |
| 依赖 | 见下方"必要改动" |

**选项 B：显式讨论会话工具 `group_start_discussion` / `group_end_discussion`**

| 维度 | 说明 |
|------|------|
| 改动量 | 大（约 +200 行 + 数据库迁移） |
| 语义 | 服务端有会话状态，开始/结束/轮次预算明确 |
| 风险 | 新表、会话过期逻辑、迁移复杂度 |

> **⚠️ 必要改动（与选项无关）**：当前 MCP 没有配置 binding 的工具，`group_activate_agent` 硬编码 `triggerScope='allHumanMessages'`（`group_chat_store.mjs:892-901`）。**无论选 A 还是 B，`group_activate_agent` 都必须新增 `triggerScope` 参数（或新增专门的配置工具）**，否则 MCP 客户端根本无法把房间设为讨论模式。此项不是可选项。

**评审关注点**：方案 A 的"无会话状态"是否可接受？是否需要服务端会话记录（便于审计/恢复/显式终止）？

---

#### D2：防刷屏强度

**问题**：放开"1 条/人类周期"后，如何防止单个 AI 垄断/刷屏？

**选项 A（推荐）：20 条房间兜底 + 同一 trigger 同 agent 去重**

- 复用现有 `ABSOLUTE_CONSECUTIVE_AI_LIMIT = 20`，改动最小。
- 防住"对同一条消息重复回复"和"房间消息总量失控"。
- 不足：极端情况下单个 AI 可对多条不同消息连续回复（占满 20 条），虽不会无限循环，但可能显得话痨。

**选项 B：再加"单个 AI 连续发言 ≤ N 条（建议 2）"硬限制**

- 需按 (agent, 连续区间) 计数：找到该 agent 最近一次"非本人消息"之后的本 agent 消息数。
- 更稳，防垄断。
- 代价：内存（`requireAgentLoopCapacity`）与 PG（内联 SQL `:3902-3950`）两处计数逻辑都要改；PG 侧需要窗口函数或子查询实现连续区间计数，复杂度高于选项 A。

**评审关注点**：讨论场景下"单 AI 话痨"是否真实风险？选项 A 的 20 条兜底 + 冷场超时是否已足够？选项 B 的 N 取多少（1/2/3）？

---

#### D3：冷场阈值

| 项 | 推荐 | 备选 |
|----|------|------|
| 轮询超时作为讨论静默信号 | 60s（与 `group_poll_messages` 上限一致） | 30s |

> 影响：冷场阈值决定讨论"自然结束"的速度。AI 轮询超时返回空结果即视为讨论静默，停止并总结。服务端零代码，只影响工具描述引导。

---

#### D4：谁触发"输出讨论过程"

| 项 | 说明 |
|----|------|
| 推荐 | 指挥该 AI 的用户（AI 只听自己用户的话） |
| 限制 | MCP 身份边界下，其他用户无法指挥别人的 AI 输出总结（sender/租约/发布均由 Bearer 身份派生，见 roadmap「不可变边界」） |
| 结论 | 属于协议天然限制，不在本次改动范围，需接受 |

---

## 4. 改动清单（按文件）

### 4.1 `src/mcp/group_chat_mcp_server.mjs`

| 位置 | 改动 |
|------|------|
| `:372` | 删掉 `humanTriggersOnly: true`（store 默认 `false`，triggerScope 接管）——放开 AI 互回的核心改动 |
| `:715` `group_publish_agent_reply` 描述 | 去掉 "Never use an agent message as a trigger"、"stop the current assistant turn"，改为讨论模式描述 |
| `:565-600` read/wait 描述 | 允许讨论回合内重复轮询 |
| 新增 `pollMessages` + `group_poll_messages` | 参照 `waitForMessages`（`:347-361`），`POLL_INTERVAL_MS=2000`、`POLL_MAX_TIMEOUT_MS=60000`（见 auto-poll-design.md） |
| `:602-618` `group_activate_agent` | 新增 `triggerScope` 可选参数（现激活硬编码 `allHumanMessages`，`:892-901`），否则 MCP 客户端无法开启讨论模式 |

### 4.2 `src/group_chat_store.mjs`（内存 + PG 双实现）

| 位置 | 改动 |
|------|------|
| `:1126` / `:3377` `createAutomaticGenerationRequest` | `humanTriggersOnly` 默认 `false`，不动 |
| `:244-280` `requireAgentLoopCapacity` + `:1512` 调用点 | 讨论模式（房间存在 `triggerScope='allMessages'` binding）时跳过 per-cycle 判断，保留房间连续 AI 上限与同 trigger 去重 |
| `:3902-3950` PG 内联 SQL | 同样的放宽逻辑 |
| `:9-10` 常量 | 新增讨论模式相关常量（如需） |

### 4.3 `src/server.mjs`

- REST `:614-690` 已支持 `triggerScope`，**无需改动**；显式讨论会话（方案 B）时才需加路由。

### 4.4 测试

| 文件 | 新增用例 |
|------|---------|
| `test/mcp/group_chat_mcp.test.mjs` | `group_poll_messages` 全用例（auto-poll-design.md 5.4）；讨论模式：AI A 发布→AI B 以 agent 消息为触发发布→AI A 再回应 通过；同一 trigger 重复发布被拒；20 条兜底生效 |
| `test/postgres_store.test.mjs` | 同样的讨论模式循环用例（PG 路径） |

### 4.5 文档

- `README.md`：工具列表加 `group_poll_messages`，更新 `group_publish_agent_reply` 语义说明
- 本文档在方案确定后标记状态

---

## 5. 实现顺序

1. **地基**：删 `:372` 的 `humanTriggersOnly:true` + 放宽 `requireAgentLoopCapacity`/PG SQL（~30 行）
2. `group_activate_agent` 加 `triggerScope` 参数 + 三个工具描述改写
3. 新增 `group_poll_messages` 工具
4. 补测试，跑 `npm.cmd test --prefix server` 与 `npm.cmd run check --prefix server`

---

## 6. FAQ

### Q1：删掉 `humanTriggersOnly:true` 会不会让现有房间行为变化？

不会。现有房间 `triggerScope='allHumanMessages'`，`requireEligibleAutomaticTriggers` 的 `:229` 仍然拒绝非人类触发，语义与 `humanTriggersOnly:true` 完全一致。

### Q2：讨论会不会无限循环？

不会。三条兜底：房间连续 AI 消息上限 20 条；同一 trigger 同 agent 不可重复回复；冷场（轮询超时）后 AI 停止。三者任一触发即止。

### Q3："冷场结束"为什么不做成服务器逻辑？

因为冷场本质是"AI 决定不再回应"，由 AI 轮询超时判断最自然，服务器无需记录会话状态。这正是路径 A 的哲学：服务器提供能力，行为由客户端引导。

### Q4：为什么其他用户不能指挥我的 AI 输出总结？

MCP 身份边界：AI 的 sender、租约、发布都由 Bearer 身份派生（roadmap「不可变边界」）。服务器无法让用户 B 的身份驱动用户 A 的 AI。这属于协议天然限制，不在本次改动范围。

### Q5：讨论历史能完整输出吗？

能。消息持久化在 PostgreSQL 带 `seq`，`historyVisibility=from_start` 的房间从种子消息起全部可见；AI 用 `group_read_messages` 增量读取后由模型总结即可。无需新增数据能力。

---

## 7. 相关代码位置

| 文件 | 说明 |
|------|------|
| `src/mcp/group_chat_mcp_server.mjs` | MCP 工具定义、注册、`humanTriggersOnly` 硬编码点 |
| `src/group_chat_store.mjs` | 触发校验、循环容量、生成请求队列（内存 + PG） |
| `src/server.mjs` | HTTP 路由、`triggerScope` 入参支持 |
| `test/mcp/group_chat_mcp.test.mjs` | MCP 工具集成测试 |
| `test/postgres_store.test.mjs` | PG 存储测试 |
| `docs/auto-poll-design.md` | 长轮询工具 `group_poll_messages` 设计 |
| `docs/implementation-roadmap.md` | 项目实施路线（含不可变边界） |
