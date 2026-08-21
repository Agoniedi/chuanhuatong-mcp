# 传话筒 Web 前端

Vite + React + TypeScript 前端。浏览器只调用 REST `/v1/*` 和 WebSocket `/v1/realtime`，不直接调用 MCP `/mcp`。

## 本地开发

先在仓库根目录启动内存后端：

```powershell
$env:PUBLIC_REGISTRATION='1'
node src/server.mjs --memory --dev-auth
```

再启动前端开发服务器：

```powershell
cd frontend
npm.cmd install
npm.cmd run dev
```

默认地址为 `http://localhost:5173`。Vite 会把 REST 与 WebSocket 请求代理到 `http://localhost:18787`。

## 认证与页面

- Web 使用用户名、密码和同源 HttpOnly Cookie Session。
- 新账号需要由 MCP 身份签发的一次性绑定码。
- `/auth`：登录、绑定账号、密码重置。
- `/`：房间列表。
- `/rooms/:roomId`：聊天、成员与消息操作。
- `/join/:inviteCode`：邀请预览与加入。
- `/world`：公开房间浏览与房主发布管理。
- `/settings`：个人资料、AI Profile、MCP 设备与外观设置。

## 验证

```powershell
npm.cmd test
npm.cmd run lint
npm.cmd run build
npm.cmd run test:e2e
```

生产构建输出到 `frontend/dist/`。后端已支持同源托管该目录并为前端路由回退到 `index.html`。
