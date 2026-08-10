# 2026-08-09 实施交接记录

## 当前结论

`docs/read-only-web-product-spec.md` 对应的 Memory、PostgreSQL、HTTP、MCP 和 Web 实现已经落地。内存模式自动化测试、前端单元测试、前端构建和 Playwright 真实浏览器端到端测试均通过；当前唯一没有实际执行的是依赖 `TEST_DATABASE_URL` 的 7 个 PostgreSQL 集成用例。

## 已完成

### 身份、账号与设备

- 未认证 `/mcp` 在 `PUBLIC_REGISTRATION=1` 时只暴露 `group_register`。
- MCP 注册返回长期 Token、Bearer Header、带 `?token=` 的 MCP URL 和一次性网页绑定码。
- Memory 与 PostgreSQL 均实现网页绑定、登录、升级旧账号、正常改密、MCP 重置码、Cookie Session、独立 MCP 设备 Token、设备列表和停用。
- 显示名允许重复；用户名保持大小写不敏感且唯一。
- 正常修改密码保留当前 Web Session、注销其他 Web Session；MCP 重置密码注销全部 Web Session，不影响 MCP Token。

### 资料与头像

- 迁移 007 已注册，包含网页账号、绑定/重置码、资料资源、网页已读位置和设备元数据。
- JPEG、PNG、WebP 头像以 PostgreSQL/Memory 资源存储，最大 2 MiB，仅有效会话可读。
- 真人和多个 Agent Profile 可分别修改名称、头像和简介；头像必须属于当前用户。
- `profile.updated` 通过 outbox/WebSocket 发给本人及共享房间成员，历史消息继续使用发送时快照。

### Web 严格只读

- 前端已从 localStorage Bearer 改为同源 HttpOnly Cookie。
- 房间列表、消息、成员、未读和个人设置可用；建房、加群、邀请和发送入口已移除。
- 服务端会拒绝 Cookie Web Session 对房间、邀请、消息、成员和 Agent 运行状态的修改，返回 `web_read_only`；账号、资料、设备和 `web_read_seq` 修改仍允许。
- Bearer/MCP 的既有 REST 写能力保持兼容。
- 首次进入加载最新 100 条，向上加载更早消息；断线后按 `seq` 补齐，按消息 ID 去重。
- 不在底部时不强制滚动并显示新消息数；真正看到最新消息后才单调更新独立 `web_read_seq`，不改变 `room_members.read_seq`。
- 当前用户及其 AI 在右侧，其他真人及其 AI 在左侧；成员按真人归组 AI，不展示参与模式。
- 已支持回复摘要与原消息定位、`@` 高亮、头像、AI 标识、加载/空/错误状态、亮暗主题和移动端布局。
- `frontend/dist/` 已由后端同源托管，未知 Web 路由回退到 SPA 的 `index.html`；`/v1/*` 和 `/mcp` 不受回退影响。

### MCP 双消息原子发布

- 新增 `group_send_message_and_agent_reply`。
- 最终发布阶段在 Memory 的同一原子变更、PostgreSQL 的同一数据库事务中按“真人消息 → AI 消息”连续写入；任一校验失败时两条消息都不可见。
- 工具支持幂等重放，返回 `humanMessage`、`agentMessage` 和 `nextAction: stop_current_turn`。
- 原有 `group_send_message` 与 `group_publish_agent_reply` 保留。

### 回归与浏览器预检

- 旧 REST 注册、MCP 工具列表和显示名唯一测试均已迁移到新契约。
- 已覆盖 Cookie 只读权限、头像/Profile、设备/密码、资料推送、最新 100 条与向前分页、独立网页已读和双消息成功/回滚/幂等。
- 前端新增 Vitest 测试，覆盖消息分页合并/去重/排序、未读与已读位置单调更新，以及 WebSocket 事件解析、重连、卸载清理和最新回调。
- 前端新增 Playwright 端到端测试，使用真实内存后端覆盖 Cookie 登录、未读显示与清零、消息左右归类、只读入口隐藏，并验证 Cookie 调用建房接口被 `403 web_read_only` 拒绝。
- 已清理移除功能遗留的建房、发送栏、邀请弹窗/预览和部分旧成员样式，同时删除未使用的邀请预览 API 文件；`/join/:inviteCode` 占位路由和 Bearer/MCP 建房能力按产品契约保留。
- 浏览器预检覆盖桌面、390px 宽度、亮暗主题、Cookie 登录、未读清零、左右归类、成员分组、回复与设置页；未发现横向溢出或控制台错误。

## 最终验证基线

- `npm.cmd run check`：通过。
- `npm.cmd test`：63 通过、0 失败、7 跳过；跳过项均要求 `TEST_DATABASE_URL`。
- 前端 `npm.cmd test`：2 个测试文件、5 项测试全部通过。
- 前端 `npm.cmd run test:e2e`：1 项 Playwright 真实浏览器测试通过；命令会先执行前端构建。
- `frontend\\npm.cmd run build`：通过，TypeScript 和 Vite 构建成功。
- `frontend\\npm.cmd run lint`：通过，无警告。
- `git diff --check`：通过，仅报告当前 Windows Git 的 LF/CRLF 提示，没有空白错误。

## 发布前剩余动作

1. 提供隔离 PostgreSQL 测试库并运行：

   ```powershell
   $env:TEST_DATABASE_URL='postgresql://...'
   npm.cmd test
   ```

2. 按部署环境运行迁移 007，并确认 Web、REST、WebSocket 和 MCP 由同一 HTTPS 域名提供。
3. 反向代理访问日志必须隐藏 `/mcp?token=` 的查询参数。
4. 当前改动尚未提交；提交前按实际差异选择文件，不要纳入来源不明文件。

## Git 与工作区

- 分支：`codex/web-mvp-testing`
- HEAD：`69a9a89 Support mobile HTTP request IDs`
- 本轮实现均未提交、未推送。
- 不要删除或顺手纳入：`chuanhuatong-admin-deploy-a250199.tar.gz`、`docs/discussion-mode-design.md`、`docs/xiaohongshu-post.md`、`frontend/README.md`、`frontend/public/`、`frontend/src/assets/`。

## 可复用验证命令

```powershell
npm.cmd run check
node --test test/web_identity.test.mjs
npm.cmd test
Set-Location frontend
npm.cmd test
npm.cmd run build
npm.cmd run lint
npm.cmd run test:e2e
```

Playwright 当前默认复用系统已安装的 Chrome；首次在新环境运行前需确认 Chrome 可用。
