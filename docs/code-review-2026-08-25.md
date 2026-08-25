# 代码审查报告 · 2026-08-25

审查对象：工作区未提交改动（`git status --short` 中的 10 个文件），核心是「房间成员移出 /
主动退出」端到端能力 + 房间列表长按（置顶 / 退出）+ Service Worker 精简。

```
frontend/public/sw.js         |   5 -
frontend/src/App.spec.tsx     |  86 +
frontend/src/App.tsx          | 239 +
frontend/src/api/members.ts   |  13 +
frontend/src/types.ts         |   6 +
src/group_chat_store.mjs      | 115 +
src/server.mjs                |  24 +
test/postgres_store.test.mjs  | 103 +
test/server.test.mjs          |  73 +
test/web_identity.test.mjs    |   6 +
```

## 一、验证基线（本次实测）

| 命令 | 结果 |
|------|------|
| `npm run check` | 通过 |
| `npm test` | tests 76 / pass 68 / fail 0 / **skip 8** |
| `npm test --prefix frontend` | 7 个文件 / 18 项全部通过 |
| `npm run lint --prefix frontend`（oxlint） | 通过 |
| `npx tsc --noEmit`（frontend） | 通过 |
| `npm run test:e2e --prefix frontend` | 未执行（需先构建 `frontend/dist`） |

整体结论：改动方向正确，分层干净（store → REST → outbox/WS → 前端），两套 store 都补了实现，
测试也跟上了。下面按严重度列出容易疏忽的点。

---

## 二、高优先级

### H1. 「移出成员」可以被当事人一键撤销——邀请没有失效，世界房间的邀请码还是公开的

`_removeRoomMember`（`src/group_chat_store.mjs:1254`、`src/group_chat_store.mjs:4276`）只做了
四件事：删 `room_members`、删该用户的 `room_agent_bindings`、删 `web_room_reads`、发事件。
**没有吊销任何邀请，也没有任何黑名单/`removed_at` 记录**，而 `acceptInvite`
（`src/group_chat_store.mjs:2379`）对「曾被移出」毫无感知。

后果：

1. 被踢的人只要手里还留着任何未过期、还有剩余次数的邀请码，立刻就能重新进房。
   新增的两个测试其实正好演示了这条路径（`test/server.test.mjs` 用 `maxUses: 2` 的同一个邀请
   重新加入，`test/postgres_store.test.mjs` 用 `postgres-membership-rejoin` 重新加入）。
2. 更严重的是已发布到「世界」的房间：`GET /v1/world/rooms/:roomId`
   （`src/server.mjs:1109` → `getWorldRoom`，`src/group_chat_store.mjs:1142` /
   `src/group_chat_store.mjs:4093`）**只要求任意已登录用户，不校验成员身份，并直接返回
   `inviteToken`**。前端 `joinWorldRoom` 就是这么拿 token 的。也就是说对公开房间，
   「踢出」等于一次不带任何冷却的刷新——被踢者在「世界」页点一下就回来了。

建议（按成本递增任选）：

- 最低成本：移出时把该房间中**由被移出者创建**的邀请置为 `revokedAt`，并在 UI 上对已发布到世界
  的房间明确提示「公开房间移出成员后对方可再次加入，请先取消发布」。
- 正确做法：新增 `room_bans(room_id, user_id, banned_at, banned_by)`（或 `room_members` 增加
  `removed_at` 软删列），`acceptInvite` / `getWorldRoom→join` 命中即 `403 room_membership_revoked`；
  同时给房主一个「解封」入口。

### H2. PostgreSQL 分支这次是**零执行覆盖**，而且两套 store 的清理语义并不等价

新增的 PG 测试挂了 `{ skip: !process.env.TEST_DATABASE_URL }`，本地跑出来 8 skipped——
`PostgresGroupChatStore.leaveRoom` / `removeRoomMember` / `_removeRoomMember` 的 SQL
一行都没真正跑过。我逐列核对过 schema（`outbox_events`、`web_room_reads`、
`room_agent_bindings`、`rooms`），列名和 `deleteRoom` 的既有写法一致，`generation_requests.binding_id`
不是外键所以删 binding 不会触发 `23503`，`agent_runtimes.binding_id` 有
`ON DELETE CASCADE`——静态看是对的，但这不能替代一次真实执行。

**合并前请务必配置 `TEST_DATABASE_URL` 跑一遍。**

同时两套实现的清理范围不一致 / 都有遗漏：

| 清理对象 | Memory | Postgres | `deleteRoom` 的做法 |
|---|---|---|---|
| `room_agent_bindings` | 显式删 | 显式删 | 级联 |
| `agent_runtimes` | 显式遍历删 | 依赖 FK 级联 | 级联 |
| `generation_requests` | **未清理** | **未清理** | 显式删 |
| 未派发的 outbox | 未清理（合理） | 未清理（合理） | 显式删 |

`generation_requests` 的残留是真问题：被移出者名下处于 `queued` / `claimed` / `generating` /
`review_pending` 的请求会永久留在库里，且 `binding_id` 指向一个已经不存在的 binding。
好消息是发布路径安全——`_requireGenerationContext`（`src/group_chat_store.mjs:589`）会先
`requireMembership` 再 `_bindingById`，所以被移出者**发不出**消息；坏消息是
`listGenerationRequests` / `getGenerationRequest` 不校验房间成员身份，被移出者的设备仍能列出并轮询
这些孤儿请求（能看到 `roomId`、`triggerMessageIds`、seq 区间等元数据）。

建议：在 `_removeRoomMember` 里把该 `(roomId, ownerUserId)` 下非终态的 generation request
标为 `cancelled`（比直接删更好，保留审计），两套 store 都要做，并补一条断言。

---

## 三、中优先级

### M3. 重复 DELETE 被当成失败，英文报错直接甩给用户

`leaveRoom` 重试会走 `requireMembership` → `403 forbidden / "Room membership required"`；
`removeRoomMember` 重试 → `404 resource_not_found`。而 `ConfirmDialog`
（`frontend/src/App.tsx:405`）的 catch 直接 `setError(error.message)`，于是网络抖动或用户手快
连点两次「确认踢出」时，**操作其实已经成功，界面却弹出一句英文** "Room membership required"。

建议：`leaveRoom` / `removeRoomMember` / `deleteRoom` 的调用点把 403/404 视作幂等成功；
`ConfirmDialog` 不要直出 `ApiError.message`，按 `error.code` 映射中文文案，未知才回落到
「操作失败，请重试」。

### M4. 成员面板里「踢出」按钮的可见文案写成了「退出」

`frontend/src/App.tsx:1357`：`aria-label` 是「将 {name} 踢出房间」，可见文字却是「退出」。
房主看到自己名字旁边一列「退出」，很容易误解成「让我自己退出」。视觉文案与无障碍文案自相矛盾，
建议统一为「移出」或「踢出」。

同理 `Rooms` 操作面板里房主看到的也是「退出」，实际行为是**解散并永久删除全部消息**
（`exitRoomFromList`，`frontend/src/App.tsx:2144`）。确认弹窗文案是对的，但操作面板那一行
建议直接按角色显示「解散房间」。

### M5. 权限模型与既有代码不一致

`removeRoomMember` 只认 `room.ownerUserId === userId`，而房间里存在 `admin` 角色，
`requireInviteManager`（`src/group_chat_store.mjs:402`）允许 owner **或 admin** 建邀请/撤邀请。
「能拉人但不能移人」是个刻意选择还是漏了 admin？如果是刻意的，建议在 store 里加一行注释说明；
如果不是，改用 `_membership(..., { manager: true })` 与既有约定对齐。

另外 PG 版 `removeRoomMember`（`src/group_chat_store.mjs:4256`）只比对 `rooms.owner_user_id`，
没有锁调用者自己的 `room_members` 行（内存版同样）。当前 owner 必然是成员所以不构成漏洞，
但和其它写路径「先 `_membership(lock)` 再动手」的模式不一致。

### M6. 其他在线成员的成员面板不会自动更新

`room.membership_removed` 的前端分支（`frontend/src/App.tsx`，`handleWsEvent` 内）对非当事人只调
`refreshRooms()`。若成员 A 正开着成员面板，B 被踢出后 A 那边仍显示 B（含 B 的 AI），要关掉重开才刷新。
`Chat` 的 `members` 只在打开面板时拉一次。建议把该事件透传进 `Chat`，或在事件里带上 `roomId`
触发一次 `listMembers` 重拉。

### M7. 删掉 `sw.js` 的 fetch 处理器会打掉 PWA 可安装性

删掉直通式 `fetch` 处理器本身是对的——`event.respondWith(fetch(event.request))` 是反模式，
会破坏 Range 请求和流式响应、白增一跳。但 Chrome 的可安装性判定要求「注册了一个有效
fetch 处理器的 Service Worker」，现在 `frontend/public/sw.js` 只剩 install/activate，
**「添加到主屏幕」/ 安装提示会失效**，而这个项目是有 `manifest.webmanifest` + `apple-touch-icon`
的移动优先 PWA。

建议改成最小离线壳：预缓存 `index.html`，`fetch` 里只对导航请求做
`cache-first-with-network-fallback`，其余请求 `return`（不调 `respondWith`）。

顺带一个相邻的既有问题：`serveFrontend`（`src/server.mjs:436` 附近）对所有非 `index.html`
的文件下发 `public, max-age=31536000, immutable`，这会命中**文件名不带 hash 的**
`/sw.js`、`/manifest.webmanifest`、`/favicon.*`。浏览器对 SW 脚本的缓存上限是 24h，所以这次
`sw.js` 的改动最长要一天才在老用户那里生效。建议对 `sw.js` 和 manifest 单独下发 `no-cache`。

### M8. 长按交互与弹窗的边界情况

`frontend/src/App.tsx:843` 起的长按实现：

- **没有位移阈值**，也没有 `onPointerLeave`。触屏上慢速起滑（浏览器还没判定成滚动、没发
  `pointercancel`）满 500ms 就会弹出操作面板。建议记录 `pointerdown` 坐标，`pointermove`
  超过 ~10px 即 `cancelLongPress`。
- `ConfirmDialog` 没有 Esc 关闭、没有初始焦点、没有焦点陷阱；操作面板的遮罩层是裸 `div` +
  `onClick`，键盘用户无法关闭。弹窗打开时也没有锁 body 滚动。
- `ConfirmDialog` 用了固定 DOM id `confirm-dialog-title`；`Rooms` 的退出确认和 `Chat` 的踢人确认
  虽然当前不会同时出现，但一旦同时挂载就是重复 id + `aria-labelledby` 指错。建议用 `useId()`。

---

## 四、低优先级 / 打磨

- **L9**：`togglePinnedRoom`（`frontend/src/App.tsx:2131`）和 `exitRoomFromList` 把
  `localStorage.setItem` 写在 `setState` 的 updater 里。updater 应当是纯函数（StrictMode 会双调），
  这里恰好幂等所以没出问题，但建议挪到 `useEffect([pinnedRoomIds, state.me])`——顺便把两处重复的
  写盘逻辑合成一处。
- **L10**：置顶只存本地、不跨设备（产品上可接受，但要有意识）。另外只有
  `exitRoomFromList` 会清理 pinned 集合；走 WS 的 `room.deleted` / `room.membership_removed`
  分支不清理，localStorage 里会慢慢攒下已消失房间的 id。
- **L11**：`Room.owner` 语义被重载——`toUiRoom` 存的是 `ownerUserId`（`frontend/src/App.tsx:98`），
  `toWorldRoom` 存的是 `ownerDisplayName`（`frontend/src/App.tsx:114`）。而 `canDelete`、
  `canManageMembers`、`exitRoomFromList` 全靠 `room.owner === userId` 判断。哪天有人把一个
  world room 对象传进 `Rooms`/`Chat`，会**静默**判成非房主。建议拆成
  `ownerUserId?: string` + `ownerLabel?: string`。
- **L12**：`isAllowedWebMutation` 里 `/^\/v1\/rooms\/[^/]+\/members\/(?:me|[^/]+)$/` 的
  `(?:me|[^/]+)` 是冗余的，`[^/]+` 已经涵盖 `me`。
- **L13**：房间行 `role="button" tabIndex={0}` 只处理了 `Enter`，缺 `Space`（原生 button 语义）；
  且 `aria-label={room.name}` 会盖掉行内的未读数和最后一条消息，屏读用户听不到未读。
  建议 `aria-label` 里带上未读数量。
- **L14**：文档没跟上。`AGENTS.md` 的「Web API 摘要」没有新端点；「关键文件索引」的行数
  （`server.mjs ~1821` / `group_chat_store.mjs ~6112`）实际已是 1952 / 6524；「验证基线 73 项」
  实际 76 项。
- **L15**：移出成员没有任何审计痕迹——不写系统消息、不落日志表。被踢者只收到一个
  `room.membership_removed` 就房间消失，其他成员也不知道发生了什么。建议至少往房间里写一条
  系统消息，或落一张 `room_member_events` 表。
- **L16**：新的 DELETE 端点没有速率限制（与既有端点一致，仅注册有限流），也没有幂等键。
  DELETE 语义上可以接受，见 M3 的客户端侧处理建议。

---

## 五、建议的处理顺序

1. 配 `TEST_DATABASE_URL` 跑通 PG 测试（H2 前半）——这是唯一「必须在合并前做」的事。
2. H1：至少加黑名单或吊销邀请，否则「移出成员」这个功能在公开房间里不成立。
3. H2 后半：`generation_requests` 收尾 + 两套 store 语义对齐。
4. M3 / M4：幂等重试与文案，改动小、用户可见收益大。
5. M7：`sw.js` 换成最小离线壳，恢复可安装性；顺手修 `sw.js` 的缓存头。
6. 其余按方便程度处理；L14 的文档更新建议和这批改动一起提交。

---

# 第二轮：扩大到最近两个 commit 与整体架构

第一轮只覆盖了工作区未提交的改动。这一轮补上 `6a0ad98`（8-24 聊天外观持久化 + AI 按房主分组）、
`f9e8104`（8-22 世界发布/加入流程）以及由此暴露的整体问题。

## 六、第二轮高优先级

### D1. 现在只能从「世界」加入房间——邀请码在 Web UI 里无处可用

`frontend/src/App.tsx` 里既没有 `useNavigate`/`useLocation`/`URLSearchParams`（一处都没有），
也没有任何「粘贴邀请码加入」的入口。`acceptInvite` 唯一的调用点是
`joinWorldRoom`（`frontend/src/App.tsx:2160`），token 来自 `getWorldRoom()`。结果：

- `previewInvite`（`frontend/src/api/rooms.ts:33`）零调用，后端
  `GET /v1/invites/preview` 从 Web 前端已不可达。
- `/join?token=...` 这类邀请链接落地后只会看到房间列表，没有任何加入提示（旧的
  `src/pages/JoinPage.tsx` 已不在路由里，见 D2）。
- **这与 AGENTS.md 里「拉群继续」协作交接工作流的第 3 步直接冲突**：那里明确要求
  「把返回的 `inviteCode` 展示给用户，说明同事用该邀请码加入即可看到前情」。同事拿到邀请码后，
  在当前 Web UI 里无路可走——除非房主先把房间发布到「世界」（而那又会引出 H1 的问题）。

这是重设计遗留的功能回退，优先级应当高于本次新增的移出成员功能。建议：在房间页加一个
「输入邀请码加入」入口（复用 `previewInvite` 做确认页），并在 `App` 启动时解析
`?token=` / `/join` 路径。

### D2. `src/pages/` + 一半 `src/components/` 是死代码孤岛（约 1900 行）

`main.tsx` 只渲染 `<App/>`，`App.tsx` 不使用任何 router hook。以下文件**没有任何生产代码引用**，
只被自己的 spec 引用：

```
src/pages/AuthPage.tsx      193 行
src/pages/JoinPage.tsx       39
src/pages/RoomListPage.tsx   73
src/pages/RoomPage.tsx      216
src/pages/SettingsPage.tsx  475
src/pages/WorldPage.tsx     301
src/components/{Avatar,MemberPanel,MessageItem,MessageList,SendBar,TopLevelNav}.tsx  ≈ 600
```

连带后果：

1. **测试覆盖率是虚高的**：`npm test --prefix frontend` 的 18 项里，
   `TopLevelNav.spec.tsx`（2 项）和 `MessageList.spec.tsx`（2 项）测的是**已经不上线的组件**。
   真正跑在 `App.tsx` 上的只有 `App.spec.tsx` 的 4 项。
2. `clearChatBackground` 唯一调用点在死掉的 `SettingsPage.tsx:255` → 引出 D3。
3. `react-router-dom` 实际只剩 `main.tsx` 里的 `<BrowserRouter>` 空壳，可以整个移除
   （连带 `frontend/e2e` 里 `page.goto('/auth')` 能工作只是因为后端 SPA 回退把所有路径都返回
   `index.html`，跟路由无关）。
4. `AGENTS.md` 仍写着「6 个页面：AuthPage、RoomListPage、RoomPage、JoinPage、WorldPage、
   SettingsPage」与「react-router-dom 7」，已经完全不符合现实。

建议：删掉这个孤岛（含它们的 spec），或者反过来——如果 `pages/` 里还有想保留的能力（比如
JoinPage 的邀请确认流程，正好是 D1 缺的那块），就把它接回 `App.tsx` 再删其余部分。
**现状是两套 UI 并存但只有一套上线，这是最容易让后续改动改错文件的形态。**

### D3. 聊天背景：预设和「默认」不持久化，上传的背景无法删除

`6a0ad98` 把自定义上传改成写 IndexedDB（正确），但只修好了一半：

- `setChatBg` 就是个裸 `useState` setter（`frontend/src/App.tsx:2046`），直接透传给 `AppearancePage`。
- 点 `BG_OPTIONS` 里的任何预设或「默认」（`value: null`），只改内存 state
  （`frontend/src/App.tsx:1911`），**既不写 IndexedDB，也不调 `clearChatBackground`**。
- 刷新后 `useEffect(() => readChatBackgroundUrl().then(setChatBg))`（`:2055`）
  又把 IndexedDB 里那张旧的上传图读回来。

所以实际行为是：上传过一次自定义背景之后，选「默认」看起来生效了，**一刷新就恢复**，
而且没有任何办法删掉它。`clearChatBackground` 全项目零生产调用。

顺带：4 个预设背景是 Unsplash 的**远程 URL**，离线不可用（对一个 PWA 来说不理想），
也意味着每个用户的浏览器会去访问 unsplash.com。建议改成本地打包的图或纯 CSS 渐变。

## 七、第二轮中低优先级

### D4. 新加的幂等键在 Web 路径上是纯开销，且 `idempotency_records` 无界增长

`f9e8104` 给 `updateWorldRoom` 加了 `_replay`/`_saveReplay`，但 Web 客户端传的是
`operationId: newRequestId()`——**每次调用现场生成一个新 UUID**
（`frontend/src/api/rooms.ts:27`、`:36`）。重试永远命中不到 replay 记录，
唯一效果是每次发布/取消发布都往 `idempotency_records` 写一行。真正受益的只有 MCP 侧
（`group_publish_room_to_world` 的 `clientRequestId` 由模型给定）。

更值得注意的是这张表**没有 TTL、没有清理任务**（`migrations/001_initial.sql:81`），
而 `sendMessage` 每发一条消息就写一行，`response_body jsonb` 存整条消息快照
（`frontend/src/api/messages.ts:33`）——等于消息内容在库里存两份且永不回收。
建议加一个按 `created_at` 的定期清理（保留 24–48h 足够覆盖重试窗口），并给该列建索引。

### D5. 两套 store 的「幂等 vs 授权」顺序不一致

内存版 `updateWorldRoom` 先查 replay 再校验房主（`src/group_chat_store.mjs:1156`），
PG 版先锁房间校验房主再查 replay（`src/group_chat_store.mjs:4075`）。仓库里其它写方法
（如 `createInvite`）都是「先校验后 replay」。内存版是唯一的例外，建议对齐——
否则一个已缓存的响应在内存模式下会绕过房主校验返回（当前因为 replay 按
`principalId` 分键所以不构成越权，但这是靠巧合成立的）。

### D6. 人类成员的「在线」绿点是硬编码的

`frontend/src/App.tsx:1092`：`online: true`。所有人类成员的状态点永远是绿的；
AI 那一列的点反映 `participationMode`，是真实信号。一个永远亮的绿点比没有点更糟，
因为用户会照它做判断（「他在线，怎么不回我」）。建议要么接真实在线状态
（realtime 连接已有 `socketsByUserId`，加一个 presence 查询不难），要么把人类那一列的点去掉。

### D7. `Chat` 缺 `key={room.id}`

`previousLastIdRef`、`input`、`members`、`pendingCount`、`showMembers` 都不随房间重置
（`frontend/src/App.tsx:1046` 起）。当前交互路径下切房间必经列表、组件会卸载，所以暂时不出问题；
但 `onRemoveMember` 里已经有 `setView(current => ({...current, room:{...}}))` 这种原地改 view 的写法，
再多几处就会踩到。给 `<Chat>` 加 `key={view.room.id}` 是一行的保险。

### D8. 无背景时每次都重开 IndexedDB

`readChatBackgroundUrl`（`frontend/src/appearance.ts:100`）在没有背景时 `activeBackgroundUrl`
恒为 `null`，于是每次调用都 `openDatabase()` + 一次事务。启动路径上
`initializeAppearance()` 和 `App` 的 effect 各来一次。建议用一个
`loaded` 标记或缓存 promise。（6a0ad98 里加的双重 `if (!activeBackgroundUrl)` 检查确实修掉了
并发调用重复 `createObjectURL` 的泄漏，这点是对的。）

## 八、修正后的优先级建议

1. **D1**（邀请码无法使用）——这是唯一会让 MCP 主线工作流（拉群继续 → 同事加入）走不通的问题。
2. **H1**（移出成员可被撤销）+ **H2**（PG 零覆盖）。
3. **D3**（背景无法清除）、**D2**（死代码孤岛，顺手把 `AGENTS.md` 一起校正）。
4. **M3 / M4 / D6**（幂等重试、文案、假在线状态）——都是小改动、用户直接可见。
5. **D4**（idempotency_records 清理）——上线时间越久越难补。
6. 其余按方便程度处理。
