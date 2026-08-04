import { createHash, randomBytes } from 'node:crypto';
import { createServer, STATUS_CODES } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WebSocket, WebSocketServer } from 'ws';

import { HttpError } from './errors.mjs';
import {
  MemoryGroupChatStore,
  PostgresGroupChatStore,
} from './group_chat_store.mjs';
import { createGroupChatMcpServer } from './mcp/group_chat_mcp_server.mjs';

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_INVITE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const MCP_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const GENERATION_STATUSES = [
  'queued',
  'claimed',
  'generating',
  'review_pending',
  'published',
  'discarded',
  'failed',
  'cancelled',
  'expired',
  'execution_uncertain',
];
const OPEN_GENERATION_STATUSES = [
  'queued',
  'claimed',
  'generating',
  'review_pending',
  'execution_uncertain',
];

function newId(prefix) {
  return `${prefix}_${randomBytes(12).toString('base64url')}`;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function fingerprint(method, pathname, body) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize({ method, pathname, body })))
    .digest('hex');
}

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'invalid_request', `${label} must be an object`);
  }
}

function assertFields(value, allowed, required = []) {
  assertObject(value, 'request body');
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new HttpError(400, 'invalid_request', `Unknown request field: ${unknown[0]}`);
  }
  for (const field of required) {
    if (!(field in value)) {
      throw new HttpError(400, 'invalid_request', `Missing request field: ${field}`);
    }
  }
}

function assertString(value, label, min = 1, max = 128) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new HttpError(400, 'invalid_request', `${label} must be ${min}-${max} characters`);
  }
  return value;
}

function assertNullableString(value, label, min = 1, max = 128) {
  if (value === null) return null;
  return assertString(value, label, min, max);
}

function assertEnum(value, label, allowed) {
  if (!allowed.includes(value)) {
    throw new HttpError(400, 'invalid_request', `${label} is not supported`);
  }
  return value;
}

function assertInteger(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, 'invalid_request', `${label} is out of range`);
  }
  return value;
}

function assertTimestamp(value, label) {
  assertString(value, label, 20, 30);
  const parsed = Date.parse(value);
  if (!TIMESTAMP_PATTERN.test(value) || Number.isNaN(parsed)) {
    throw new HttpError(400, 'invalid_request', `${label} must be strict UTC RFC 3339`);
  }
  return parsed;
}

function parsePathSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, 'invalid_request', 'Invalid URL path');
  }
}

function parseMcpAllowedOrigins(value) {
  if (value === undefined || value.trim().length === 0) return [];
  return [...new Set(value.split(',').map((origin) => origin.trim()).filter(Boolean))];
}

function normalizeMcpAllowedOrigins(origins) {
  if (!Array.isArray(origins)) {
    throw new Error('MCP_ALLOWED_ORIGINS must be a comma-separated origin list');
  }
  return origins.map((origin) => {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`MCP_ALLOWED_ORIGINS contains an invalid origin: ${origin}`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error(`MCP_ALLOWED_ORIGINS contains an invalid origin: ${origin}`);
    }
    return origin;
  });
}

function assertMcpOrigin(request, allowedOrigins) {
  const origin = request.headers.origin;
  if (origin === undefined) return;
  if (typeof origin !== 'string' || !allowedOrigins.includes(origin)) {
    throw new HttpError(403, 'invalid_origin', 'Origin is not allowed');
  }
}

function createMcpRateLimiter(limit, clock = Date.now) {
  const windows = new Map();
  let nextSweepAt = 0;
  return (userId) => {
    const now = clock();
    if (now >= nextSweepAt) {
      for (const [candidateUserId, window] of windows) {
        if (window.resetAt <= now) windows.delete(candidateUserId);
      }
      nextSweepAt = now + MCP_RATE_LIMIT_WINDOW_MS;
    }

    let window = windows.get(userId);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + MCP_RATE_LIMIT_WINDOW_MS };
      windows.set(userId, window);
    }
    if (window.count >= limit) {
      throw new HttpError(429, 'rate_limited', 'MCP request rate limit exceeded', {
        retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
      });
    }
    window.count += 1;
  };
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, 'payload_too_large', 'Request body is too large');
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_request', 'Request body must be valid JSON');
  }
}

function applyCommonHeaders(response, requestId, corsAllowOrigin) {
  response.setHeader('x-request-id', requestId);
  response.setHeader('access-control-allow-origin', corsAllowOrigin);
}

function writeJson(response, status, body, requestId, corsAllowOrigin) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  applyCommonHeaders(response, requestId, corsAllowOrigin);
  if (status === 204) {
    response.end();
    return;
  }
  response.end(JSON.stringify(body));
}

function sendError(response, error, requestId, corsAllowOrigin, logger) {
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : 'internal_error';
  const message = error instanceof HttpError ? error.message : 'Unexpected server error';
  if (!(error instanceof HttpError)) {
    logger.error?.(`[server] request ${requestId} failed`, error);
  }
  const retryAfterSeconds = error instanceof HttpError
    ? error.retryAfterSeconds
    : undefined;
  if (retryAfterSeconds !== undefined) {
    response.setHeader('retry-after', String(retryAfterSeconds));
  }
  writeJson(
    response,
    status,
    {
      error: {
        code,
        requestId,
        message,
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      },
    },
    requestId,
    corsAllowOrigin,
  );
}

function bearerToken(request) {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    throw new HttpError(401, 'authentication_required', 'Bearer session required');
  }
  return assertString(header.slice('Bearer '.length), 'Bearer session', 1, 256);
}

async function authUser(store, request) {
  return store.authenticate(bearerToken(request));
}

async function handleMcpRequest(
  store,
  user,
  request,
  response,
  requestId,
  corsAllowOrigin,
  logger,
  wakeOutbox,
) {
  if (request.method !== 'POST') {
    response.setHeader('allow', 'POST');
    writeJson(response, 405, {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed' },
      id: null,
    }, requestId, corsAllowOrigin);
    return;
  }

  const mcpServer = createGroupChatMcpServer({
    store,
    user,
    logger,
    onMessageCreated: wakeOutbox,
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await mcpServer.connect(transport);
  applyCommonHeaders(response, requestId, corsAllowOrigin);
  try {
    await transport.handleRequest(request, response);
  } finally {
    await mcpServer.close();
  }
}

function realtimeEnvelope(type, payload, roomId) {
  return {
    protocolVersion: 1,
    eventId: newId('evt'),
    type,
    occurredAt: new Date().toISOString(),
    ...(roomId ? { roomId } : {}),
    payload,
  };
}

function sendRealtimeEvent(socket, event) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(event), (error) => {
    if (error) socket.terminate();
  });
}

function rejectUpgrade(socket, error) {
  const status = error instanceof HttpError ? error.status : 500;
  const body = JSON.stringify({
    error: {
      code: error instanceof HttpError ? error.code : 'internal_error',
      message: error instanceof HttpError ? error.message : 'Realtime upgrade failed',
    },
  });
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Error'}\r\n` +
    'Connection: close\r\n' +
    'Content-Type: application/json; charset=utf-8\r\n' +
    `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

function attachRealtimeServer(server, store, logger, pollIntervalMs) {
  const realtimeServer = new WebSocketServer({ noServer: true });
  const socketsByUserId = new Map();
  let drainRunning = false;
  let drainPending = false;
  let closed = false;

  const drain = async () => {
    if (closed) return;
    drainPending = true;
    if (drainRunning) return;
    drainRunning = true;
    try {
      while (drainPending && !closed) {
        drainPending = false;
        const entries = await store.listPendingOutboxEvents();
        for (const entry of entries) {
          const event = entry.event;
          if (event.type === 'message.created' && event.roomId) {
            const recipients = await store.listRealtimeRecipientUserIds(
              event.roomId,
              event.payload.seq,
            );
            for (const userId of recipients) {
              for (const socket of socketsByUserId.get(userId) ?? []) {
                const active = await store.isSessionActive({
                  userId,
                  deviceId: socket.sessionDeviceId,
                });
                if (!active) {
                  socket.close(1008, 'Session revoked');
                  continue;
                }
                sendRealtimeEvent(socket, event);
              }
            }
          }
          await store.markOutboxDispatched(entry.outboxId);
        }
        if (entries.length === 100) drainPending = true;
      }
    } catch (error) {
      logger.error?.('[realtime] outbox dispatch failed', error);
    } finally {
      drainRunning = false;
    }
  };

  const pollTimer = setInterval(() => void drain(), pollIntervalMs);
  pollTimer.unref?.();
  void drain();

  server.on('upgrade', (request, socket, head) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? '/', 'http://localhost');
        if (request.method !== 'GET' || url.pathname !== '/v1/realtime' || url.search) {
          throw new HttpError(404, 'resource_not_found', 'Realtime route not found');
        }
        const user = await authUser(store, request);
        realtimeServer.handleUpgrade(request, socket, head, (realtimeSocket) => {
          realtimeSocket.sessionDeviceId = user.deviceId;
          const userSockets = socketsByUserId.get(user.userId) ?? new Set();
          userSockets.add(realtimeSocket);
          socketsByUserId.set(user.userId, userSockets);
          realtimeSocket.on('close', () => {
            userSockets.delete(realtimeSocket);
            if (userSockets.size === 0) socketsByUserId.delete(user.userId);
          });
          realtimeSocket.on('error', (error) => {
            logger.warn?.(`[realtime] socket error: ${error.message}`);
          });
          sendRealtimeEvent(
            realtimeSocket,
            realtimeEnvelope('connection.ready', {}),
          );
          void drain();
        });
      } catch (error) {
        rejectUpgrade(socket, error);
      }
    })();
  });

  const closeRealtime = () => {
    if (closed) return;
    closed = true;
    clearInterval(pollTimer);
    for (const sockets of socketsByUserId.values()) {
      for (const socket of sockets) socket.close(1001, 'Server shutting down');
    }
    socketsByUserId.clear();
    realtimeServer.close();
  };
  server.on('close', closeRealtime);

  return { wakeOutbox: () => void drain(), closeRealtime };
}

async function handleRequest(
  store,
  request,
  response,
  options,
  requestId,
  wakeOutbox,
) {
  const url = new URL(request.url, 'http://127.0.0.1');
  const path = url.pathname;
  const write = (status, body) =>
    writeJson(response, status, body, requestId, options.corsAllowOrigin);

  if (request.method === 'OPTIONS') {
    if (path === '/mcp') {
      assertMcpOrigin(request, options.mcpAllowedOrigins);
    }
    response.statusCode = 204;
    applyCommonHeaders(response, requestId, options.corsAllowOrigin);
    response.setHeader(
      'access-control-allow-headers',
      'Authorization, Content-Type, Idempotency-Key, MCP-Protocol-Version, Operation-Id',
    );
    response.setHeader(
      'access-control-allow-methods',
      'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    );
    response.end();
    return;
  }

  if (request.method === 'GET' && path === '/healthz') {
    await store.health();
    write(200, { status: 'ok' });
    return;
  }

  if (request.method === 'POST' && path === '/__dev/guest-session') {
    if (!options.devAuthEnabled) {
      throw new HttpError(404, 'resource_not_found', 'Local development authentication is disabled');
    }
    const body = await readJson(request);
    assertFields(body, ['deviceId', 'displayName'], ['deviceId', 'displayName']);
    const deviceId = assertString(body.deviceId, 'deviceId', 8, 128);
    const displayName = assertString(body.displayName, 'displayName', 1, 80).trim();
    if (displayName.length === 0) {
      throw new HttpError(400, 'invalid_request', 'displayName must not be blank');
    }
    write(200, await store.createGuestSession({ deviceId, displayName }));
    return;
  }

  if (path === '/mcp') {
    assertMcpOrigin(request, options.mcpAllowedOrigins);
    const user = await authUser(store, request);
    if (request.method === 'POST') options.checkMcpRateLimit(user.userId);
    await handleMcpRequest(
      store,
      user,
      request,
      response,
      requestId,
      options.corsAllowOrigin,
      options.logger,
      wakeOutbox,
    );
    return;
  }

  if (!path.startsWith('/v1/')) {
    throw new HttpError(404, 'resource_not_found', 'Route not found');
  }
  const user = await authUser(store, request);

  if (request.method === 'POST' && path === '/v1/agent-profiles') {
    const body = await readJson(request);
    const key = assertString(request.headers['idempotency-key'], 'Idempotency-Key');
    assertFields(body, ['displayName', 'avatarResourceId', 'shortBio'], [
      'displayName',
      'shortBio',
    ]);
    const displayName = assertString(body.displayName, 'displayName', 1, 80).trim();
    if (displayName.length === 0) {
      throw new HttpError(400, 'invalid_request', 'displayName must not be blank');
    }
    const avatarResourceId = body.avatarResourceId === undefined
      ? null
      : assertNullableString(body.avatarResourceId, 'avatarResourceId');
    const shortBio = assertString(body.shortBio, 'shortBio', 0, 500);
    const result = await store.createAgentProfile({
      userId: user.userId,
      displayName,
      avatarResourceId,
      shortBio,
      key,
      requestFingerprint: fingerprint(request.method, path, body),
    });
    write(result.status, result.body);
    return;
  }

  const agentProfileMatch = path.match(/^\/v1\/agent-profiles\/([^/]+)$/);
  if (agentProfileMatch) {
    const agentProfileId = parsePathSegment(agentProfileMatch[1]);
    if (request.method === 'GET') {
      write(200, await store.getAgentProfile({
        userId: user.userId,
        agentProfileId,
      }));
      return;
    }
    if (request.method === 'PATCH') {
      const body = await readJson(request);
      const key = assertString(request.headers['operation-id'], 'Operation-Id');
      assertFields(
        body,
        ['expectedProfileRevision', 'displayName', 'avatarResourceId', 'shortBio'],
        ['expectedProfileRevision'],
      );
      if (Object.keys(body).length < 2) {
        throw new HttpError(400, 'invalid_request', 'At least one profile field is required');
      }
      const expectedProfileRevision = assertInteger(
        body.expectedProfileRevision,
        'expectedProfileRevision',
        1,
        Number.MAX_SAFE_INTEGER,
      );
      const changes = {};
      if (Object.hasOwn(body, 'displayName')) {
        const displayName = assertString(body.displayName, 'displayName', 1, 80).trim();
        if (displayName.length === 0) {
          throw new HttpError(400, 'invalid_request', 'displayName must not be blank');
        }
        changes.displayName = displayName;
      }
      if (Object.hasOwn(body, 'avatarResourceId')) {
        changes.avatarResourceId = assertNullableString(
          body.avatarResourceId,
          'avatarResourceId',
        );
      }
      if (Object.hasOwn(body, 'shortBio')) {
        changes.shortBio = assertString(body.shortBio, 'shortBio', 0, 500);
      }
      const result = await store.updateAgentProfile({
        userId: user.userId,
        agentProfileId,
        expectedProfileRevision,
        changes,
        key,
        requestFingerprint: fingerprint(request.method, path, body),
      });
      write(result.status, result.body);
      return;
    }
  }

  if (request.method === 'GET' && path === '/v1/rooms') {
    write(200, { items: await store.listRooms(user.userId) });
    return;
  }

  if (request.method === 'POST' && path === '/v1/rooms') {
    const body = await readJson(request);
    const key = assertString(request.headers['idempotency-key'], 'Idempotency-Key');
    assertFields(body, ['title'], ['title']);
    const title = assertString(body.title, 'title', 1, 120);
    const result = await store.createRoom({
      userId: user.userId,
      title,
      key,
      requestFingerprint: fingerprint(request.method, path, body),
    });
    write(result.status, result.body);
    return;
  }

  const roomMatch = path.match(/^\/v1\/rooms\/([^/]+)$/);
  if (request.method === 'GET' && roomMatch) {
    write(200, await store.getRoom({
      userId: user.userId,
      roomId: parsePathSegment(roomMatch[1]),
    }));
    return;
  }

  const roomAgentBindingsMatch = path.match(
    /^\/v1\/rooms\/([^/]+)\/agent-bindings$/,
  );
  if (request.method === 'GET' && roomAgentBindingsMatch) {
    write(200, await store.listRoomAgentBindings({
      userId: user.userId,
      roomId: parsePathSegment(roomAgentBindingsMatch[1]),
    }));
    return;
  }

  const myRoomAgentMatch = path.match(/^\/v1\/rooms\/([^/]+)\/my-agent$/);
  if (myRoomAgentMatch) {
    const roomId = parsePathSegment(myRoomAgentMatch[1]);
    if (request.method === 'GET') {
      write(200, await store.getMyRoomAgentBinding({ userId: user.userId, roomId }));
      return;
    }
    if (request.method === 'PUT') {
      const body = await readJson(request);
      const key = assertString(request.headers['operation-id'], 'Operation-Id');
      assertFields(
        body,
        [
          'agentProfileId',
          'participationMode',
          'publishMode',
          'triggerScope',
          'preferredRuntimeDeviceId',
          'generationLimitPer24h',
          'expectedPolicyRevision',
        ],
        [
          'agentProfileId',
          'participationMode',
          'publishMode',
          'triggerScope',
          'generationLimitPer24h',
          'expectedPolicyRevision',
        ],
      );
      const expectedPolicyRevision = body.expectedPolicyRevision === null
        ? null
        : assertInteger(
          body.expectedPolicyRevision,
          'expectedPolicyRevision',
          1,
          Number.MAX_SAFE_INTEGER,
        );
      const preferredRuntimeDeviceId = body.preferredRuntimeDeviceId === undefined
        ? null
        : assertNullableString(
          body.preferredRuntimeDeviceId,
          'preferredRuntimeDeviceId',
        );
      const result = await store.putMyRoomAgentBinding({
        userId: user.userId,
        roomId,
        agentProfileId: assertString(body.agentProfileId, 'agentProfileId'),
        participationMode: assertEnum(
          body.participationMode,
          'participationMode',
          ['off', 'manual', 'automatic'],
        ),
        publishMode: assertEnum(
          body.publishMode,
          'publishMode',
          ['reviewRequired', 'automatic'],
        ),
        triggerScope: assertEnum(
          body.triggerScope,
          'triggerScope',
          ['mentionsOnly', 'allHumanMessages', 'allMessages'],
        ),
        preferredRuntimeDeviceId,
        generationLimitPer24h: assertInteger(
          body.generationLimitPer24h,
          'generationLimitPer24h',
          1,
          1000,
        ),
        expectedPolicyRevision,
        key,
        requestFingerprint: fingerprint(request.method, path, body),
      });
      write(result.status, result.body);
      return;
    }
    if (request.method === 'DELETE') {
      const key = assertString(request.headers['operation-id'], 'Operation-Id');
      const expectedPolicyRevisionValue = url.searchParams.get('expectedPolicyRevision');
      if (expectedPolicyRevisionValue === null) {
        throw new HttpError(400, 'invalid_request', 'expectedPolicyRevision is required');
      }
      const expectedPolicyRevision = assertInteger(
        Number(expectedPolicyRevisionValue),
        'expectedPolicyRevision',
        1,
        Number.MAX_SAFE_INTEGER,
      );
      const result = await store.deleteMyRoomAgentBinding({
        userId: user.userId,
        roomId,
        expectedPolicyRevision,
        key,
        requestFingerprint: fingerprint(request.method, path, { expectedPolicyRevision }),
      });
      write(result.status, result.body);
      return;
    }
  }

  const myAgentRuntimeMatch = path.match(
    /^\/v1\/rooms\/([^/]+)\/my-agent\/runtimes\/([^/]+)$/,
  );
  if (request.method === 'PUT' && myAgentRuntimeMatch) {
    const body = await readJson(request);
    const key = assertString(request.headers['operation-id'], 'Operation-Id');
    assertFields(
      body,
      [
        'readiness',
        'readyForBindingPolicyRevision',
        'runtimeCapabilitiesVersion',
        'localConfigRevision',
      ],
      [
        'readiness',
        'readyForBindingPolicyRevision',
        'runtimeCapabilitiesVersion',
        'localConfigRevision',
      ],
    );
    const readiness = assertEnum(body.readiness, 'readiness', ['ready', 'notReady']);
    const readyForBindingPolicyRevision = body.readyForBindingPolicyRevision === null
      ? null
      : assertInteger(
        body.readyForBindingPolicyRevision,
        'readyForBindingPolicyRevision',
        0,
        Number.MAX_SAFE_INTEGER,
      );
    const result = await store.putMyAgentRuntime({
      user,
      roomId: parsePathSegment(myAgentRuntimeMatch[1]),
      deviceId: parsePathSegment(myAgentRuntimeMatch[2]),
      readiness,
      readyForBindingPolicyRevision,
      runtimeCapabilitiesVersion: assertInteger(
        body.runtimeCapabilitiesVersion,
        'runtimeCapabilitiesVersion',
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      localConfigRevision: assertInteger(
        body.localConfigRevision,
        'localConfigRevision',
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      key,
      requestFingerprint: fingerprint(request.method, path, body),
    });
    write(result.status, result.body);
    return;
  }

  const roomGenerationRequestsMatch = path.match(
    /^\/v1\/rooms\/([^/]+)\/generation-requests$/,
  );
  if (request.method === 'POST' && roomGenerationRequestsMatch) {
    const body = await readJson(request);
    const key = assertString(request.headers['idempotency-key'], 'Idempotency-Key');
    assertFields(
      body,
      [
        'clientGenerationRequestId',
        'triggerMessageIds',
        'expectedBindingPolicyRevision',
        'supersedesRequestId',
      ],
      [
        'clientGenerationRequestId',
        'triggerMessageIds',
        'expectedBindingPolicyRevision',
      ],
    );
    const clientGenerationRequestId = assertString(
      body.clientGenerationRequestId,
      'clientGenerationRequestId',
    );
    if (clientGenerationRequestId !== key) {
      throw new HttpError(
        409,
        'idempotency_conflict',
        'clientGenerationRequestId must equal Idempotency-Key',
      );
    }
    if (
      !Array.isArray(body.triggerMessageIds) ||
      body.triggerMessageIds.length < 1 ||
      body.triggerMessageIds.length > 128
    ) {
      throw new HttpError(
        400,
        'invalid_request',
        'triggerMessageIds must contain 1-128 items',
      );
    }
    const triggerMessageIds = body.triggerMessageIds.map((value) =>
      assertString(value, 'triggerMessageIds[]'));
    if (new Set(triggerMessageIds).size !== triggerMessageIds.length) {
      throw new HttpError(400, 'invalid_request', 'triggerMessageIds must be unique');
    }
    const result = await store.createManualGenerationRequest({
      user,
      roomId: parsePathSegment(roomGenerationRequestsMatch[1]),
      clientGenerationRequestId,
      triggerMessageIds,
      expectedBindingPolicyRevision: assertInteger(
        body.expectedBindingPolicyRevision,
        'expectedBindingPolicyRevision',
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      supersedesRequestId: body.supersedesRequestId === undefined
        ? null
        : assertString(body.supersedesRequestId, 'supersedesRequestId'),
      key,
      requestFingerprint: fingerprint(request.method, path, body),
    });
    write(result.status, result.body);
    return;
  }

  if (request.method === 'GET' && path === '/v1/generation-requests') {
    const statusValue = url.searchParams.get('status');
    const statuses = statusValue === null
      ? OPEN_GENERATION_STATUSES
      : statusValue.split(',').map((status) =>
        assertEnum(status, 'status', GENERATION_STATUSES));
    if (statuses.length < 1 || statuses.length > 10 || new Set(statuses).size !== statuses.length) {
      throw new HttpError(400, 'invalid_request', 'status filter is invalid');
    }
    const pageTokenValue = url.searchParams.get('pageToken');
    const pageToken = pageTokenValue === null
      ? null
      : assertString(pageTokenValue, 'pageToken', 1, 256);
    const limitValue = url.searchParams.get('limit');
    const limit = limitValue === null ? 50 : Number(limitValue);
    assertInteger(limit, 'limit', 1, 200);
    write(200, await store.listGenerationRequests({
      user,
      statuses,
      pageToken,
      limit,
    }));
    return;
  }

  const generationRequestMatch = path.match(
    /^\/v1\/generation-requests\/([^/]+)$/,
  );
  if (request.method === 'GET' && generationRequestMatch) {
    write(200, await store.getGenerationRequest({
      userId: user.userId,
      generationRequestId: parsePathSegment(generationRequestMatch[1]),
    }));
    return;
  }

  const generationCommandMatch = path.match(
    /^\/v1\/generation-requests\/([^/]+)\/(claim|start|review-pending|fail|discard|publish)$/,
  );
  if (request.method === 'POST' && generationCommandMatch) {
    const generationRequestId = parsePathSegment(generationCommandMatch[1]);
    const command = generationCommandMatch[2];
    const body = await readJson(request);
    const key = assertString(request.headers['operation-id'], 'Operation-Id');
    if (command === 'claim' || command === 'discard') {
      assertFields(body, ['expectedRequestVersion'], ['expectedRequestVersion']);
      const parameters = {
        user,
        generationRequestId,
        expectedRequestVersion: assertInteger(
          body.expectedRequestVersion,
          'expectedRequestVersion',
          0,
          Number.MAX_SAFE_INTEGER,
        ),
        key,
        requestFingerprint: fingerprint(request.method, path, body),
      };
      const result = command === 'claim'
        ? await store.claimGenerationRequest(parameters)
        : await store.discardGenerationRequest(parameters);
      write(result.status, result.body);
      return;
    }
    if (command === 'start' || command === 'review-pending' || command === 'fail') {
      assertFields(
        body,
        ['expectedRequestVersion', 'leaseId', 'leaseEpoch'],
        ['expectedRequestVersion', 'leaseId', 'leaseEpoch'],
      );
      const parameters = {
        user,
        generationRequestId,
        expectedRequestVersion: assertInteger(
          body.expectedRequestVersion,
          'expectedRequestVersion',
          0,
          Number.MAX_SAFE_INTEGER,
        ),
        leaseId: assertString(body.leaseId, 'leaseId'),
        leaseEpoch: assertInteger(
          body.leaseEpoch,
          'leaseEpoch',
          0,
          Number.MAX_SAFE_INTEGER,
        ),
        key,
        requestFingerprint: fingerprint(request.method, path, body),
      };
      const result = command === 'start'
        ? await store.startGenerationRequest(parameters)
        : command === 'review-pending'
          ? await store.markGenerationReviewPending(parameters)
          : await store.failGenerationRequest(parameters);
      write(result.status, result.body);
      return;
    }
    assertFields(
      body,
      [
        'expectedRequestVersion',
        'expectedBindingPolicyRevision',
        'clientMessageId',
        'content',
        'mentions',
        'replyToMessageId',
        'leaseId',
        'leaseEpoch',
      ],
      [
        'expectedRequestVersion',
        'expectedBindingPolicyRevision',
        'clientMessageId',
        'content',
      ],
    );
    assertFields(body.content, ['schemaVersion', 'type', 'text'], [
      'schemaVersion',
      'type',
      'text',
    ]);
    if (body.content.schemaVersion !== 1 || body.content.type !== 'text') {
      throw new HttpError(
        400,
        'invalid_request',
        'Only text schemaVersion 1 content is supported',
      );
    }
    const mentions = body.mentions === undefined ? [] : body.mentions;
    if (!Array.isArray(mentions) || mentions.length > 32) {
      throw new HttpError(400, 'invalid_request', 'mentions must contain at most 32 items');
    }
    const mentionKeys = new Set();
    for (const mention of mentions) {
      assertFields(mention, ['kind', 'targetId'], ['kind', 'targetId']);
      assertEnum(mention.kind, 'mention.kind', ['user', 'agent']);
      assertString(mention.targetId, 'mention.targetId');
      const mentionKey = `${mention.kind}:${mention.targetId}`;
      if (mentionKeys.has(mentionKey)) {
        throw new HttpError(400, 'invalid_request', 'Duplicate mention');
      }
      mentionKeys.add(mentionKey);
    }
    let replyToMessageId = body.replyToMessageId ?? null;
    if (replyToMessageId !== null) {
      replyToMessageId = assertString(replyToMessageId, 'replyToMessageId');
    }
    const leaseId = body.leaseId ?? null;
    const leaseEpoch = body.leaseEpoch ?? null;
    if ((leaseId === null) !== (leaseEpoch === null)) {
      throw new HttpError(400, 'invalid_request', 'leaseId and leaseEpoch must be supplied together');
    }
    const result = await store.publishGenerationRequest({
      user,
      generationRequestId,
      expectedRequestVersion: assertInteger(
        body.expectedRequestVersion,
        'expectedRequestVersion',
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      expectedBindingPolicyRevision: assertInteger(
        body.expectedBindingPolicyRevision,
        'expectedBindingPolicyRevision',
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      clientMessageId: assertString(body.clientMessageId, 'clientMessageId'),
      text: assertString(body.content.text, 'content.text', 1, 32768),
      mentions,
      replyToMessageId,
      leaseId: leaseId === null ? null : assertString(leaseId, 'leaseId'),
      leaseEpoch: leaseEpoch === null
        ? null
        : assertInteger(leaseEpoch, 'leaseEpoch', 0, Number.MAX_SAFE_INTEGER),
      key,
      requestFingerprint: fingerprint(request.method, path, body),
    });
    wakeOutbox();
    write(result.status, result.body);
    return;
  }

  const roomMembersMatch = path.match(/^\/v1\/rooms\/([^/]+)\/members(?:\/me)?$/);
  if (request.method === 'GET' && roomMembersMatch) {
    const roomId = parsePathSegment(roomMembersMatch[1]);
    if (path.endsWith('/me')) {
      write(200, await store.getMembership({ userId: user.userId, roomId }));
    } else {
      write(200, await store.listMembers({ userId: user.userId, roomId }));
    }
    return;
  }

  const invitesMatch = path.match(/^\/v1\/rooms\/([^/]+)\/invites$/);
  if (invitesMatch) {
    const roomId = parsePathSegment(invitesMatch[1]);
    if (request.method === 'GET') {
      write(200, { items: await store.listInvites({ userId: user.userId, roomId }) });
      return;
    }
    if (request.method === 'POST') {
      const body = await readJson(request);
      const key = assertString(request.headers['idempotency-key'], 'Idempotency-Key');
      assertFields(body, ['expectedRoomRevision', 'expiresAt', 'maxUses'], [
        'expectedRoomRevision',
        'expiresAt',
        'maxUses',
      ]);
      const expectedRoomRevision = assertInteger(
        body.expectedRoomRevision,
        'expectedRoomRevision',
        0,
        Number.MAX_SAFE_INTEGER,
      );
      const expiry = assertTimestamp(body.expiresAt, 'expiresAt');
      const now = Date.now();
      if (expiry <= now || expiry > now + MAX_INVITE_LIFETIME_MS) {
        throw new HttpError(400, 'invalid_request', 'expiresAt must be within 30 days');
      }
      const maxUses = assertInteger(body.maxUses, 'maxUses', 1, 100);
      const result = await store.createInvite({
        userId: user.userId,
        roomId,
        expectedRoomRevision,
        expiresAt: body.expiresAt,
        maxUses,
        key,
        requestFingerprint: fingerprint(request.method, path, body),
      });
      write(result.status, result.body);
      return;
    }
  }

  const inviteRevokeMatch = path.match(/^\/v1\/rooms\/([^/]+)\/invites\/([^/]+)$/);
  if (request.method === 'DELETE' && inviteRevokeMatch) {
    const key = assertString(request.headers['operation-id'], 'Operation-Id');
    const result = await store.revokeInvite({
      userId: user.userId,
      roomId: parsePathSegment(inviteRevokeMatch[1]),
      inviteId: parsePathSegment(inviteRevokeMatch[2]),
      key,
      requestFingerprint: fingerprint(request.method, path, null),
    });
    write(result.status, result.body);
    return;
  }

  if (request.method === 'POST' && path === '/v1/invites/accept') {
    const body = await readJson(request);
    assertFields(body, ['inviteToken'], ['inviteToken']);
    const inviteToken = assertString(body.inviteToken, 'inviteToken', 22, 256);
    const key = assertString(request.headers['operation-id'], 'Operation-Id');
    const result = await store.acceptInvite({
      userId: user.userId,
      inviteToken,
      key,
      requestFingerprint: fingerprint(request.method, path, body),
    });
    write(result.status, result.body);
    return;
  }

  const messagesMatch = path.match(/^\/v1\/rooms\/([^/]+)\/messages$/);
  if (messagesMatch) {
    const roomId = parsePathSegment(messagesMatch[1]);
    if (request.method === 'GET') {
      const afterSeqValue = url.searchParams.get('afterSeq');
      const limitValue = url.searchParams.get('limit');
      const afterSeq = afterSeqValue === null ? 0 : Number(afterSeqValue);
      const limit = limitValue === null ? 50 : Number(limitValue);
      assertInteger(afterSeq, 'afterSeq', 0, Number.MAX_SAFE_INTEGER);
      assertInteger(limit, 'limit', 1, 200);
      write(200, await store.listMessages({ userId: user.userId, roomId, afterSeq, limit }));
      return;
    }
    if (request.method === 'POST') {
      const body = await readJson(request);
      const key = assertString(request.headers['idempotency-key'], 'Idempotency-Key');
      assertFields(body, ['clientMessageId', 'content', 'mentions', 'replyToMessageId'], [
        'clientMessageId',
        'content',
      ]);
      const clientMessageId = assertString(body.clientMessageId, 'clientMessageId');
      if (clientMessageId !== key) {
        throw new HttpError(409, 'idempotency_conflict', 'clientMessageId must equal Idempotency-Key');
      }
      assertFields(body.content, ['schemaVersion', 'type', 'text'], [
        'schemaVersion',
        'type',
        'text',
      ]);
      if (body.content.schemaVersion !== 1 || body.content.type !== 'text') {
        throw new HttpError(400, 'invalid_request', 'Only text schemaVersion 1 content is supported');
      }
      const text = assertString(body.content.text, 'content.text', 1, 32768);
      const mentions = body.mentions === undefined ? [] : body.mentions;
      if (!Array.isArray(mentions) || mentions.length > 32) {
        throw new HttpError(400, 'invalid_request', 'mentions must contain at most 32 items');
      }
      const mentionKeys = new Set();
      for (const mention of mentions) {
        assertFields(mention, ['kind', 'targetId'], ['kind', 'targetId']);
        if (!['user', 'agent'].includes(mention.kind)) {
          throw new HttpError(400, 'invalid_request', 'Unsupported mention kind');
        }
        assertString(mention.targetId, 'mention.targetId');
        const mentionKey = `${mention.kind}:${mention.targetId}`;
        if (mentionKeys.has(mentionKey)) {
          throw new HttpError(400, 'invalid_request', 'Duplicate mention');
        }
        mentionKeys.add(mentionKey);
      }
      let replyToMessageId = body.replyToMessageId;
      if (replyToMessageId !== undefined && replyToMessageId !== null) {
        replyToMessageId = assertString(replyToMessageId, 'replyToMessageId');
      } else {
        replyToMessageId = null;
      }
      const result = await store.createHumanMessage({
        user,
        roomId,
        clientMessageId,
        text,
        mentions,
        replyToMessageId,
        key,
        requestFingerprint: fingerprint(request.method, path, body),
      });
      wakeOutbox();
      write(result.status, result.body);
      return;
    }
  }

  throw new HttpError(404, 'resource_not_found', 'Route not found');
}

export function createLocalServer({
  devAuthEnabled = false,
  store = new MemoryGroupChatStore(),
  logger = console,
  corsAllowOrigin = process.env.CORS_ALLOW_ORIGIN ?? '*',
  mcpAllowedOrigins = parseMcpAllowedOrigins(process.env.MCP_ALLOWED_ORIGINS),
  mcpRateLimitPerMinute = Number(process.env.MCP_RATE_LIMIT_PER_MINUTE ?? 300),
  outboxPollIntervalMs = 250,
} = {}) {
  if (!Number.isInteger(mcpRateLimitPerMinute) || mcpRateLimitPerMinute < 1) {
    throw new Error('MCP_RATE_LIMIT_PER_MINUTE must be a positive integer');
  }
  const effectiveMcpAllowedOrigins = normalizeMcpAllowedOrigins(mcpAllowedOrigins);
  const effectiveDevAuthEnabled = devAuthEnabled && process.env.NODE_ENV !== 'production';
  if (effectiveDevAuthEnabled) {
    logger.warn?.('[local-dev] anonymous guest sessions are enabled for local development only.');
  }
  const checkMcpRateLimit = createMcpRateLimiter(mcpRateLimitPerMinute);
  let wakeOutbox = () => {};
  const server = createServer((request, response) => {
    const requestId = newId('req');
    handleRequest(
      store,
      request,
      response,
      {
        devAuthEnabled: effectiveDevAuthEnabled,
        corsAllowOrigin,
        checkMcpRateLimit,
        logger,
        mcpAllowedOrigins: effectiveMcpAllowedOrigins,
      },
      requestId,
      wakeOutbox,
    ).catch((error) => {
      if (response.headersSent) {
        logger.error?.(`[server] request ${requestId} failed after headers were sent`, error);
        response.destroy();
        return;
      }
      sendError(response, error, requestId, corsAllowOrigin, logger);
    });
  });
  const realtime = attachRealtimeServer(
    server,
    store,
    logger,
    outboxPollIntervalMs,
  );
  ({ wakeOutbox } = realtime);
  let storeCloseOperation;
  const closeStore = () => {
    storeCloseOperation ??= store.close();
    return storeCloseOperation;
  };
  server.on('close', () => {
    void closeStore().catch((error) => {
      logger.error?.('[server] storage shutdown failed', error);
    });
  });
  server.shutdown = async () => {
    realtime.closeRealtime();
    if (server.listening) {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
    await closeStore();
  };
  return server;
}

export async function startLocalServer({
  host = process.env.SERVER_HOST ?? process.env.LOCAL_SERVER_HOST ?? '127.0.0.1',
  port = Number(process.env.PORT ?? 18787),
  devAuthEnabled = process.env.LOCAL_DEV_AUTH === '1' || process.argv.includes('--dev-auth'),
  memory = process.argv.includes('--memory'),
  migrate = process.env.RUN_MIGRATIONS === '1' || process.argv.includes('--migrate'),
  logger = console,
} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  if (memory && process.env.NODE_ENV === 'production') {
    throw new Error('In-memory storage is disabled in production');
  }
  const store = memory
    ? new MemoryGroupChatStore()
    : await PostgresGroupChatStore.connect({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_SSL === '1',
        migrate,
        logger,
      });
  const server = createLocalServer({ devAuthEnabled, store, logger });
  server.listen(port, host, () => {
    logger.info?.(`[server] listening at http://${host}:${port}`);
    if (memory) logger.warn?.('[local-dev] using explicit in-memory storage; data will be lost on restart');
  });
  return server;
}

if (process.argv[1] && process.argv[1].endsWith('server.mjs')) {
  try {
    const server = await startLocalServer();
    let shuttingDown = false;
    const shutdown = (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.info(`[server] received ${signal}; shutting down`);
      void server.shutdown().catch((error) => {
        console.error('[server] shutdown failed', error);
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  } catch (error) {
    console.error('[server] startup failed', error);
    process.exitCode = 1;
  }
}
