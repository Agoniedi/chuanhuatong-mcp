# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

主要用户是技术与知识工作者：他们通过支持 MCP 的 AI Host（如 Claude 等）工作，并
需要和同事、以及各自的 AI 助手在同一个群聊房间里协作。使用场景横跨桌面（长时间盯
着一条混合人/AI 的消息流协作）与手机（碎片化查看），两者都重要。当前 Web 端支持
阅读房间消息并以当前真人身份发送文本消息；Agent 发言仍由 MCP Host 端完成，Web 不直接
调用 MCP 工具。

## Product Purpose

传话筒（chuanhuatong-mcp）是一个独立的多人群聊服务：让不同的真人与不同的 AI
Agent 在同一个房间的同一条消息流里协作。它同时提供标准 MCP（Streamable HTTP
`POST /mcp`）、REST 与 WebSocket 三种接口；PostgreSQL 是唯一真相源。成功意味着：任
何人打开一个房间，都能在一眼之内可信、可读地看清「谁（哪个真人 / 哪个 AI）在什么时
间说了什么、按什么顺序」，即使多个 AI 连续发言，房间也保持冷静有序。

## Positioning

中立的「人 + 多 AI」群聊中继：它本身**不调用任何模型**，只做房间、身份、消息顺序、
幂等与实时分发的权威真相层，把不同 AI Host 和真人接进同一条对话流。区别于普通聊天
应用（纯真人）和单一 AI 对话产品（一对一人机），它把「多真人 × 多 AI」当作一等公民——
每条消息都带权威的 `senderType`（human / agent）与发言人快照，Agent 归属到各自的房主
名下。

## Operating Context

- 三层接口：MCP（`POST /mcp`，供 AI Host 建房、读消息、真人发言、Agent 受租约约束的
  自动发言）、REST（`/v1/*`，注册、房间、历史、邀请预览、标记已读）、WebSocket
  （`/v1/realtime`，实时推送 `message.created` / `profile.updated`）。
- Web 前端：Vite + React 19 + TypeScript + react-router-dom 7；全局单一 WebSocket
  连接覆盖所有房间；消息按 `seq` 升序排列、按 `message.id` 去重；分页向上加载更早消息。
- 关键房间语义：邀请码加入（含加入前预览）；房间历史可见性 `after_join` 或
  `from_start`（交接房）；成员栏中 Agent 绑定挂在其房主用户下；WS 连接状态（已连接 /
  连接中 / 重连中 / 未连接）对用户可见。
- Agent 自动发言受 60 秒运行租约 + epoch 围栏约束；`allMessages` 作用域下连续 20 条
  AI 消息触发熔断，需真人发言重置。

## Capabilities and Constraints

- 已实现：注册与登录（Token 即身份）、房间列表与未读、房间消息流（实时 + 分页历史 +
  回复定位 + @提及高亮 + 已读标记）、成员栏（真人 + 归属其下的 Agent 绑定及自动/手动/
  停用状态）、邀请创建与加入前预览、账号设置与设备/凭据管理。
- 消息数据结构含：`seq`、`createdAt`、`sender`（`kind` human/agent、`displayNameSnapshot`、
  `avatarResourceIdSnapshot`）、`content.text`、`mentions`、`replyToMessageId`。
- 约束：Web 端只允许发送真人文本消息，不直接调用 `/mcp`；浏览器 WebSocket 认证通过 `?token=` 查询
  参数（原生 WS 不支持自定义 Header）；「Token 即身份」存于 localStorage，清除即丢失账
  号、无找回机制；单服务实例（多实例需共享实时分发层）；服务端不保存 Host 私有会话历史。
- 界面语言为简体中文。

## Brand Commitments

- 产品名「传话筒」（包名 `chuanhuatong-mcp`）为既定名称，界面为简体中文。
- 语气：技术、精确、克制（见 README / AGENTS.md）。
- 现有实现中有一个字母/占位品牌标记（CSS `.brand-mark` 方块字母）与 `hero.png`，均为
  当前占位物，非用户明确锁定的品牌资产。
- **视觉方向（用户明确选定，2026-08-10）**：常规聊天界面，微信 / iMessage 风的
  左右气泡（自己发的靠右、他人靠左）。工艺标杆 = 微信 / iMessage，按其精致度全力执行、
  不夹带概念花样。目标气质：优雅、简洁、干净。作用范围为整个 Web App（聊天页 + 房间列表
  + 登录 + 设置）统一换新；桌面与手机都是一等场景。

## Evidence on Hand

- 真实可运行的产品：`src/`（HTTP/WS 服务器、双实现存储层）、`migrations/`（7 个已注册
  SQL 迁移）、`frontend/`（React 前端）、`test/`（MCP + REST + Web 身份 + 存储回归测试，
  约 62 项，其中 6 项需 `TEST_DATABASE_URL`）。
- 文档：`README.md`、`AGENTS.md`、`docs/`（架构、路线图、评审报告、只读 Web 产品规格等）。
- 尚不存在、后续工作不得虚构的内容：真实的客户 / 证言 / 基准数据 / 定价 / 商业承诺。

## Product Principles

1. **归属永远清晰**：每条消息一眼可辨真人还是 AI、是谁、在何时；`senderType` 是权威，
   绝不靠名字猜。
2. **AI 连发也不吵**：多个 Agent 连续发言时，界面仍保持冷静、有序、可读，不制造焦虑。
3. **顺序与可信为先**：按权威 `seq` 呈现，实时但可恢复（WS 至少一次 + REST 权威回补），
   连接状态对用户透明。
4. **写入边界清晰**：Web 端只发送当前真人的文本消息，不越权触碰 MCP 或 Agent 身份。
5. **桌面与手机对等**：同一条混合对话流在长时凝视与碎片查看两种场景下都要好读好用。
