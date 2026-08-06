# 群聊消息自动轮询 MCP 工具开发文档

> 版本：v1.0
> 更新日期：2026-08-01
> 状态：设计阶段

---

## 1. 背景与需求

### 1.1 问题描述

当前群聊消息的获取依赖用户主动让 AI 调用 `group_read_messages` 或 `group_wait_for_messages` 工具。用户期望：

> **AI 发送消息后，自动等待并获取群聊回复，主动告知用户新消息内容，无需用户手动查询。**

### 1.2 用户场景

```
用户：在群里问"张三，接口改好了吗？"
AI：  → 调用 group_send_message 发送消息
     → 自动调用长轮询工具，等待群聊回复（最长 1 分钟）
     → 张三回复："改好了，已提交"
     → AI 主动告知用户："张三回复了，说接口已经改好并提交了"
```

### 1.3 设计原则

- **不改动前端 App**：不修改 RikkaHub、Kelivo、Operit 的代码
- **不改动 MCP 协议**：不破坏现有工具的语义和兼容性
- **最小改动**：只在 chuanhuatong MCP 服务器内部做增量修改
- **轻量负担**：轮询频率和数据库压力控制在可接受范围

---

## 2. 当前代码分析

### 2.1 现有 `group_wait_for_messages` 工具

文件：`src/mcp/group_chat_mcp_server.mjs`

**输入定义**（第 559-563 行）：
```javascript
inputSchema: z.object({
  roomId: idSchema,
  afterSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  timeoutMs: z.number().int().min(0).max(5000),    // ← 硬限制 5 秒
}).strict()
```

**核心逻辑**（第 320-334 行）：
```javascript
async function waitForMessages({ store, userId, roomId, afterSeq, timeoutMs, signal }) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const page = await readMessagesPage({ store, userId, roomId, afterSeq, limit: 200 });
    const remainingMs = deadline - Date.now();
    if (page.messages.length > 0 || remainingMs <= 0) return page;
    await delay(Math.min(250, remainingMs), undefined, { signal });  // 每 250ms 轮询一次
  }
}
```

### 2.2 关键发现

| 项目 | 现状 | 分析 |
|------|------|------|
| 超时上限 | `max(5000)` = 5 秒 | 不足以支持 1 分钟等待 |
| 轮询间隔 | `250ms` | 1 分钟 = 240 次查询，频率偏高 |
| HTTP 超时 | `createServer` 默认 `timeout = 0`（永不超时） | 本地开发无断连风险 |
| 连接池占用 | 每次 `listMessages` 查询后立即归还连接 | 不长期占用连接池 |
| 数据库查询 | 轻量索引查询，单次 ~1ms | 负载极低 |

### 2.3 断连风险矩阵

| 部署环境 | 风险 | 说明 |
|---------|------|------|
| 本地开发（127.0.0.1） | ✅ 无风险 | Node.js 默认无超时，每 2s 有活跃查询 |
| Docker 本地 | ✅ 无风险 | 同上 |
| 生产 + Nginx 反代 | ⚠️ 需配置 | Nginx 默认 `proxy_read_timeout = 60s`，刚好够用 |
| 生产 + Cloudflare | ✅ 无风险 | Cloudflare 默认 100s 超时 |

---

## 3. 设计方案

### 3.1 方案对比

| 方案 | 改动量 | 优点 | 缺点 |
|------|--------|------|------|
| **A. 修改现有工具** | 极小（2 行） | 改动最少，不新增工具 | 语义变更，可能影响现有客户端 |
| **B. 新增独立工具** | 中等（+50 行） | 保持向后兼容，职责清晰 | 多一个工具 |
| **C. 后端内部捎带通知** | 大（+200 行） | 最智能，无需客户端配合 | 改动大，复杂度高 |

**推荐方案：B（新增独立工具）**，理由：
- 不破坏现有 `group_wait_for_messages` 的 5 秒限制语义
- 新工具 `group_poll_messages` 职责明确：长时间等待
- 客户端可以自由选择使用哪个工具

### 3.2 新增工具定义

**工具名称**：`group_poll_messages`

**描述**：长时间轮询群聊新消息。AI 发送消息后调用此工具，等待群聊成员回复。轮询间隔 2 秒，最长等待 60 秒。有新消息时立即返回，超时无新消息返回空结果。

**输入参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `roomId` | `string` | 是 | 房间 ID |
| `afterSeq` | `number` | 是 | 起始消息序列号（调用 `group_send_message` 返回的 `seq`） |
| `timeoutMs` | `number` | 否 | 最长等待毫秒数，默认 60000，最大 60000 |

**输出**：与 `group_read_messages` / `group_wait_for_messages` 相同的格式：

```json
{
  "messages": [
    {
      "id": "msg_xxx",
      "roomId": "room_xxx",
      "seq": 42,
      "senderType": "human",
      "senderDisplayName": "张三",
      "content": {
        "schemaVersion": 1,
        "type": "text",
        "text": "改好了，已提交"
      }
    }
  ],
  "nextSeq": 42,
  "highWaterSeq": 50,
  "hasMore": false
}
```

### 3.3 轮询参数

| 参数 | 值 | 说明 |
|------|----|------|
| 轮询间隔 | `2000ms`（2 秒） | 平衡实时性和负载 |
| 最大超时 | `60000ms`（1 分钟） | 满足等待回复场景 |
| 最大消息数 | `200` 条/次 | 复用现有 `WAIT_MESSAGE_LIMIT` |
| 空结果策略 | 超时返回空数组 | 客户端据此判断"暂无回复" |

---

## 4. 负担分析

### 4.1 数据库查询量

| 场景 | 轮询间隔 | 1 分钟查询次数 | 单次耗时 | 总耗时 |
|------|---------|---------------|---------|--------|
| 当前（250ms） | 0.25s | 240 次 | ~1ms | ~240ms |
| **方案（2s）** | **2s** | **30 次** | **~1ms** | **~30ms** |

### 4.2 连接池占用

`pg.Pool` 的 `query()` 是"用完即还"的：
- `listMessages()` → 从池子借一个连接 → 执行 SQL（~1ms）→ **立刻归还**
- `await delay(2000)` 等待期间 → **连接已在池中空闲，其他人可用**
- 下次循环 → 再借再还

**实际占用连接的时间 = 30 次 × 1ms = 30ms**，而不是 1 分钟。

### 4.3 多用户场景估算

| 指标 | 1 用户 | 10 用户 | 50 用户 |
|------|--------|---------|---------|
| 同时轮询人数 | 1 | 10 | 50 |
| 每分钟查询总数 | 30 次 | 300 次 | 1500 次 |
| 每秒查询数 | 0.5 QPS | 5 QPS | 25 QPS |
| 连接池占用 | 0.03ms/分钟 | 0.3ms/分钟 | 1.5ms/分钟 |
| 对数据库影响 | 可忽略 | 可忽略 | 很低 |

**结论：不需要增大连接池（默认 10 个连接足够）。**

---

## 5. 实现计划

### 5.1 修改文件清单

| 文件 | 修改内容 | 预计行数 |
|------|---------|---------|
| `src/mcp/group_chat_mcp_server.mjs` | 新增 `group_poll_messages` 工具定义和 `pollMessages` 函数 | ~40 行 |
| `test/mcp/group_chat_mcp.test.mjs` | 新增 `group_poll_messages` 测试用例 | ~80 行 |
| `README.md` | 更新工具列表 | ~5 行 |

### 5.2 具体实现

#### 5.2.1 新增 `pollMessages` 函数（`group_chat_mcp_server.mjs`）

```javascript
const POLL_MESSAGE_LIMIT = 200;
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_TIMEOUT_MS = 60000;

async function pollMessages({ store, userId, roomId, afterSeq, timeoutMs, signal }) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const page = await readMessagesPage({
      store,
      userId,
      roomId,
      afterSeq,
      limit: POLL_MESSAGE_LIMIT,
    });
    const remainingMs = deadline - Date.now();
    if (page.messages.length > 0 || remainingMs <= 0) return page;
    await delay(Math.min(POLL_INTERVAL_MS, remainingMs), undefined, { signal });
  }
}
```

#### 5.2.2 注册新工具

```javascript
server.registerTool('group_poll_messages', {
  description: 'Long-poll for room messages with extended timeout. ' +
    'Call after group_send_message to wait for replies. ' +
    'Polls every 2s for up to 60s. Returns immediately when new messages arrive. ' +
    'senderType is the authoritative human-or-agent identity; never infer sender type from the display name.',
  inputSchema: z.object({
    roomId: idSchema,
    afterSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    timeoutMs: z.number().int().min(0).max(POLL_MAX_TIMEOUT_MS).default(POLL_MAX_TIMEOUT_MS),
  }).strict(),
  outputSchema: readMessagesOutputSchema,
  annotations: READ_ONLY_ANNOTATIONS,
}, toolHandler(async ({ roomId, afterSeq, timeoutMs }, extra) => pollMessages({
  store,
  userId: user.userId,
  roomId,
  afterSeq,
  timeoutMs,
  signal: extra.signal,
}), logger));
```

### 5.3 AI 使用策略

AI 在使用 `group_poll_messages` 时，应遵循以下策略：

```
1. 用户要求发消息到群聊
2. AI 调用 group_send_message → 获取返回的 message.seq
3. AI 调用 group_poll_messages(roomId, afterSeq=message.seq, timeoutMs=60000)
4. 情况 A：有新消息 → AI 读取消息内容并告知用户
5. 情况 B：超时无回复 → AI 告知用户"暂时没人回复"
```

### 5.4 测试用例

| 测试场景 | 预期结果 |
|---------|---------|
| 有新消息时立即返回 | 消息数组非空 |
| 超时无新消息 | 返回空消息数组，nextSeq 不变 |
| 超时 0ms（立即返回） | 不等待，直接返回 |
| 超时 60000ms（最大） | 等待 1 分钟，正常返回 |
| 超时 > 60000ms | 参数校验拒绝 |
| `afterSeq` 超过 room 最新 seq | 返回空消息数组 |
| 并发调用（多个房间同时轮询） | 互不干扰，各自独立 |

---

## 6. 部署与运维

### 6.1 配置变更

无需新增环境变量。现有的 `DATABASE_POOL_SIZE` 保持默认值 `10` 即可。

### 6.2 生产环境建议

如果使用 Nginx 反向代理，需确认 `proxy_read_timeout` 配置：

```nginx
# 如果使用 Nginx 反代
location /mcp {
    proxy_pass http://backend:18787;
    proxy_read_timeout 65s;  # 建议 65s，略大于 60s 轮询超时
    proxy_http_version 1.1;
}
```

### 6.3 监控指标（可选）

| 指标 | 说明 |
|------|------|
| `poll_messages.count` | 调用次数 |
| `poll_messages.hit_rate` | 有消息返回的比例（非空结果 / 总调用） |
| `poll_messages.avg_wait_ms` | 平均等待时间 |

---

## 7. FAQ

### Q1：为什么不用 250ms 轮询间隔？

250ms 间隔 1 分钟 = 240 次查询，数据库压力虽低但没必要。2 秒间隔对用户感知影响极小（群聊回复通常不会在 2 秒内），但查询量降低到 1/8。

### Q2：要不要增大连接池？

不需要。`pg.Pool.query()` 是"用完即还"的，等待期间连接已归还池中。默认 10 个连接够几十个人同时轮询。

### Q3：会不会断连？

本地开发不会断连（Node.js 默认无 HTTP 超时，且每 2 秒有活跃查询）。生产环境若使用 Nginx，需将 `proxy_read_timeout` 设为 65s 以上。

### Q4：为什么不改现有 `group_wait_for_messages`？

保持向后兼容。现有工具限定 5 秒超时，已有客户端可能依赖此行为。新增工具职责更清晰，客户端按需选择。

### Q5：同时监控多个房间怎么办？

AI 可以依次调用 `group_poll_messages` 监控不同房间，或用户选择只监控主要房间。长远可考虑新增 `group_poll_all_rooms` 工具，但当前不做。

### Q6：AI 不主动调用怎么办？

此方案依赖 AI 的主动调用策略。如果用户使用的 AI 客户端不自动调用工具，需要用户在 prompt 中明确指示 AI 使用此功能。这是 MCP 协议本身的限制，无法通过服务器端代码解决。

---

## 8. 附录

### 8.1 相关代码位置

| 文件 | 说明 |
|------|------|
| `src/mcp/group_chat_mcp_server.mjs` | MCP 工具定义和注册 |
| `src/server.mjs` | HTTP 服务器、路由、认证 |
| `src/group_chat_store.mjs` | 数据存储层（PostgreSQL + 内存） |
| `test/mcp/group_chat_mcp.test.mjs` | MCP 工具集成测试 |
| `README.md` | 项目文档 |
| `docs/implementation-roadmap.md` | 实施路线图 |

### 8.2 参考

- [MCP Streamable HTTP 规范](https://spec.modelcontextprotocol.io/specification/2024-11-05/basic/transports/#streamable-http)
- [pg.Pool 文档](https://node-postgres.com/apis/pool)
