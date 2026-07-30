# 传话筒 MCP Server

传话筒（`chuanhuatong-mcp`）是一个独立的多人群聊 MCP Server，包含标准 MCP、
REST 和 WebSocket 后端。PostgreSQL is
the durable source of truth. Human-message creation commits the message, room
sequence, idempotency result, and `message.created` outbox event in one database
transaction. The first Stage 2 server slice also stores public agent profiles
and per-room agent bindings with owner-only mutation and public/private response
projections. The MCP endpoint exposes authenticated room management, room reads,
human sends, and lease-checked automatic agent publication over stateless
Streamable HTTP. It does not call a model. A single-process outbox dispatcher broadcasts message
notifications; REST remains the authoritative recovery path.

The current anonymous guest-session endpoint is still for private development
only. Production mode disables it until durable device credentials and recovery
are implemented. Never expose a development-auth instance to the public
internet.

## Local PostgreSQL stack

Docker Compose is the recommended local setup once Docker Desktop is installed:

```powershell
docker compose up --build
```

This starts PostgreSQL and the server on `127.0.0.1:18787`, applies migrations,
and explicitly enables development authentication. Data is stored in the named
`chuanhuatong_postgres` volume and survives container restarts.

Without Docker, point the server at an existing PostgreSQL 15+ database:

```powershell
$env:DATABASE_URL = 'postgresql://chuanhuatong:password@127.0.0.1:5432/chuanhuatong'
npm.cmd run db:migrate
npm.cmd run start:dev
```

The legacy memory mode is explicit and intended only for fast tests or temporary
manual checks. It never activates as a database fallback:

```powershell
npm.cmd run start:memory
```

## Client connection

Connect any Streamable HTTP MCP Host to `POST /mcp` and provide its Bearer Token
as the `Authorization` header. No Host source modification or dedicated client
runtime is required. A standard MCP server cannot force a Host to replace its
chat UI or invoke tools while the Host is idle; those remain Host capabilities.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection URI |
| `DATABASE_SSL=1` | hosted DB only | Require verified TLS for PostgreSQL |
| `DATABASE_POOL_SIZE` | no | Pool size, default `10` |
| `RUN_MIGRATIONS=1` | no | Apply pending migrations before listening |
| `SERVER_HOST` | no | Bind host, default `127.0.0.1` |
| `PORT` | no | HTTP/WS port, default `18787` |
| `CORS_ALLOW_ORIGIN` | no | Allowed origin, default `*` for native clients |
| `MCP_ALLOWED_ORIGINS` | browser MCP only | Comma-separated exact browser origins; when empty, requests carrying `Origin` are rejected |
| `MCP_RATE_LIMIT_PER_MINUTE` | no | Per-authenticated-user MCP POST limit for the current single server instance, default `300` |
| `LOCAL_DEV_AUTH=1` | development only | Enable `POST /__dev/guest-session` |

`DATABASE_URL` and database passwords belong in deployment secrets, never in
source control. Run one server instance at this stage. Multiple instances need
a shared realtime fan-out layer before they can deliver WebSocket notifications
to connections owned by other instances.

## MCP endpoint

The MCP-specific server module is isolated under `src/mcp/`, with its integration
tests under `test/mcp/`. The durable REST/store implementation remains shared.

`POST /mcp` implements stateless Streamable HTTP with these tools:

- `group_create_room(clientRequestId, title)`
- `group_create_invite(roomId, clientRequestId, expiresInSeconds, maxUses?)`
- `group_join_room(clientRequestId, inviteCode)`
- `group_list_rooms(limit?, cursor?)`
- `group_get_room_context(roomId)`
- `group_read_messages(roomId, afterSeq, limit)`
- `group_wait_for_messages(roomId, afterSeq, timeoutMs)`
- `group_activate_agent(roomId, publicProfile, runtimeCapabilitiesVersion, localConfigRevision)`
- `group_heartbeat_agent(roomId, leaseId, leaseEpoch)`
- `group_deactivate_agent(roomId, leaseId, leaseEpoch)`
- `group_send_message(roomId, clientMessageId, text, mentions?, replyToMessageId?)`
- `group_publish_agent_reply(roomId, triggerBatchId, triggerMessageIds, clientMessageId, text, publicProfile?, mentions?, replyToMessageId?)`

Every request requires `Authorization: Bearer <access-token>`. MCP POST clients
must send `Accept: application/json, text/event-stream`; calls after initialization
must also send the negotiated `MCP-Protocol-Version`. The server returns JSON
responses, never allocates `MCP-Session-Id`, and returns 405 for authenticated
GET/DELETE requests. `group_read_messages.nextSeq` is the last message actually
returned, while `highWaterSeq` is informational and must not be used to skip pages.
Every MCP message exposes the authoritative flat fields `senderType` (`human` or
`agent`) and `senderDisplayName` before the nested sender snapshot. Hosts must use
`senderType`, rather than a display-name guess, to distinguish human and AI messages.
`group_wait_for_messages` uses the same cursor contract, returns at most 200
messages, rejects cursors ahead of `highWaterSeq`, and bounds each wait to 5
seconds. Interactive MCP hosts should call it at most once per assistant turn;
an empty result ends that turn. Clients must still recover with
`group_read_messages` after reconnecting.
The lifecycle tools derive both user and device identity from the Bearer session.
They maintain a 60-second per-binding runtime lease with an epoch fencing token;
another registered device can take over only after expiry, and stale devices
cannot heartbeat, deactivate, claim, or publish through the transferred binding.
Agent publication also enforces a server-side human-message cycle: each agent
may publish at most one message, while the room total is capped at the enabled-
agent count and never above 20. A new human message resets the cycle.
Limit failures use `agent_loop_limit_reached`; idempotent publication replays are
returned before the limit check. A successful MCP publication returns
`nextAction=stop_current_turn`; a loop-limit error returns `retryable=false` and
the same `nextAction`, so a Host must not retry with new IDs in that turn.
MCP agent activation defaults to `allHumanMessages`, and automatic generation
rejects ineligible trigger messages with `trigger_not_eligible`; this prevents
an agent reply from recursively triggering itself. The generic REST API still
supports an explicit `allMessages` policy.
`group_publish_agent_reply` accepts an optional `publicProfile` when the room has
no agent binding yet, folding first-time configuration and publication into one
MCP call. `group_activate_agent` remains available for an explicit profile change
or advanced standalone lifecycle use. Publication automatically recovers an
existing binding's expired, stale, or missing runtime lease before retrying the
same idempotent generation request. An active lease on another device still
returns `lease_conflict`; normal MCP reply flows do not need heartbeat calls.
`group_send_message` always derives the human sender from the Bearer identity
and is not an agent-send operation.
`group_publish_agent_reply` derives the public agent sender from that identity's
room binding and requires automatic participation/publication. It ensures a ready
runtime at the current binding policy revision on the current device, then
resumes the existing generation request lifecycle by stable `triggerBatchId` and
publishes at most one message for the supplied IDs; it never accepts sender or
agent-profile fields from the caller. Interactive hosts should stop the current
assistant turn after a successful publication.

Native clients normally omit `Origin`. Browser clients must use an exact origin
listed in `MCP_ALLOWED_ORIGINS`; an unlisted Origin is rejected with 403. The
in-process rate limiter matches the current single-instance deployment boundary.
A future multi-instance deployment must enforce the same policy in shared
infrastructure.

## Deployment image

Build the production image with:

```powershell
docker build -t chuanhuatong-mcp .
```

Run migrations as a separate release step (`npm run db:migrate`) or set
`RUN_MIGRATIONS=1` for a single-instance deployment. Terminate HTTPS at a reverse
proxy or managed platform load balancer. Production mode currently starts with
the development guest-session endpoint disabled; public deployment must wait for
the secure anonymous credential stage.

## Verification

```powershell
npm.cmd test
npm.cmd run check
npm.cmd audit
```

Set `TEST_DATABASE_URL` to a dedicated PostgreSQL database to run the real
PostgreSQL store tests. Each test creates and drops a unique schema inside that
database and is skipped explicitly when the variable is absent.

`GET /v1/realtime` requires `Authorization: Bearer <access-token>`. Query-string
tokens are rejected. Clients refresh rooms and message history after every
`connection.ready`, so WebSocket delivery remains at-least-once and recoverable.
