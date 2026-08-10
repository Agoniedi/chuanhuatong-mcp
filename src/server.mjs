import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, STATUS_CODES } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WebSocket, WebSocketServer } from 'ws';

import { HttpError } from './errors.mjs';
import {
  MemoryGroupChatStore,
  PostgresGroupChatStore,
} from './group_chat_store.mjs';
import {
  createGroupChatMcpServer,
  createRegistrationMcpServer,
} from './mcp/group_chat_mcp_server.mjs';
import { createPasswordDigest, verifyPasswordDigest } from './passwords.mjs';

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const AVATAR_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_INVITE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const MCP_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const REGISTRATION_RATE_LIMIT_WINDOW_MS = 3600 * 1000;
const WEB_SESSION_COOKIE = 'chuanhuatong_session';
const WEB_SESSION_MAX_AGE_SECONDS = 10 * 365 * 24 * 60 * 60;
const FRONTEND_DIST = fileURLToPath(new URL('../frontend/dist/', import.meta.url));
const STATIC_MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.webp', 'image/webp'],
]);
const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,32}$/;
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

function createRegistrationRateLimiter(limit, clock = Date.now) {
  const windows = new Map();
  let nextSweepAt = 0;
  return (ip) => {
    const now = clock();
    if (now >= nextSweepAt) {
      for (const [candidateIp, window] of windows) {
        if (window.resetAt <= now) windows.delete(candidateIp);
      }
      nextSweepAt = now + REGISTRATION_RATE_LIMIT_WINDOW_MS;
    }

    let window = windows.get(ip);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + REGISTRATION_RATE_LIMIT_WINDOW_MS };
      windows.set(ip, window);
    }
    if (window.count >= limit) {
      throw new HttpError(429, 'rate_limited', 'Registration rate limit exceeded', {
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

async function readAvatar(request) {
  const mimeType = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
  if (!AVATAR_MIME_TYPES.has(mimeType)) {
    throw new HttpError(415, 'unsupported_media_type', 'Avatar must be JPEG, PNG, or WebP');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_AVATAR_BYTES) {
      throw new HttpError(413, 'payload_too_large', 'Avatar must be at most 2 MiB');
    }
    chunks.push(chunk);
  }
  if (size === 0) {
    throw new HttpError(400, 'invalid_request', 'Avatar must not be empty');
  }
  return { mimeType, content: Buffer.concat(chunks) };
}

function applyCommonHeaders(response, requestId, corsAllowOrigin) {
  response.setHeader('x-request-id', requestId);
  response.setHeader('access-control-allow-origin', corsAllowOrigin);
  if (corsAllowOrigin !== '*') response.setHeader('access-control-allow-credentials', 'true');
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

function parseCookies(request) {
  const header = request.headers.cookie;
  if (typeof header !== 'string') return new Map();
  const cookies = new Map();
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) cookies.set(name, value);
  }
  return cookies;
}

function authenticationToken(request) {
  const header = request.headers.authorization;
  if (typeof header === 'string') return bearerToken(request);
  const token = parseCookies(request).get(WEB_SESSION_COOKIE);
  if (!token) throw new HttpError(401, 'authentication_required', 'Authenticated session required');
  return assertString(token, 'Web session', 1, 256);
}

function webSessionCookie(token, secure) {
  return [
    `${WEB_SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${WEB_SESSION_MAX_AGE_SECONDS}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

function clearedWebSessionCookie(secure) {
  return [
    `${WEB_SESSION_COOKIE}=`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=0',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

function normalizedUsername(value) {
  const username = assertString(value, 'username', 3, 32);
  if (!USERNAME_PATTERN.test(username)) {
    throw new HttpError(400, 'invalid_request', 'username must contain only letters, numbers, or underscores');
  }
  return { username, usernameKey: username.toLowerCase() };
}

function requestIp(request, options) {
  const forwardedIp = options.trustProxy
    ? request.headers['x-forwarded-for']?.split(',')[0]?.trim()
    : null;
  return forwardedIp || request.socket.remoteAddress || '127.0.0.1';
}

function mcpBaseUrl(request, options) {
  const forwardedProtocol = options.trustProxy
    ? request.headers['x-forwarded-proto']?.split(',')[0]?.trim()
    : null;
  const protocol = forwardedProtocol || (request.socket.encrypted ? 'https' : 'http');
  const host = request.headers.host ?? '127.0.0.1';
  return `${protocol}://${host}/mcp`;
}

async function authUser(store, request) {
  return store.authenticate(authenticationToken(request));
}

function isAllowedWebMutation(method, path) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return true;
  if (method === 'POST' && [
    '/v1/auth/logout',
    '/v1/auth/change-password',
    '/v1/auth/upgrade',
    '/v1/profile-resources',
    '/v1/me/devices',
    '/v1/agent-profiles',
  ].includes(path)) return true;
  if (method === 'PATCH' && path === '/v1/me') return true;
  if (method === 'PATCH' && /^\/v1\/agent-profiles\/[^/]+$/.test(path)) return true;
  if (method === 'DELETE' && /^\/v1\/me\/devices\/[^/]+$/.test(path)) return true;
  return method === 'PUT' && /^\/v1\/rooms\/[^/]+\/read$/.test(path);
}

async function serveFrontend(
  request,
  response,
  path,
  requestId,
  corsAllowOrigin,
  frontendDist,
) {
  const frontendRoot = resolve(frontendDist);
  const frontendIndex = resolve(frontendRoot, 'index.html');
  if (!['GET', 'HEAD'].includes(request.method) || !existsSync(frontendIndex)) {
    return false;
  }
  const relativePath = decodeURIComponent(path).replace(/^\/+/, '');
  const candidate = resolve(frontendRoot, relativePath || 'index.html');
  const insideDist = candidate === frontendRoot || candidate.startsWith(`${frontendRoot}${sep}`);
  const filePath = insideDist && existsSync(candidate) && statSync(candidate).isFile()
    ? candidate
    : frontendIndex;
  applyCommonHeaders(response, requestId, corsAllowOrigin);
  response.statusCode = 200;
  response.setHeader(
    'content-type',
    STATIC_MIME_TYPES.get(extname(filePath).toLowerCase()) ?? 'application/octet-stream',
  );
  response.setHeader('cache-control', filePath === frontendIndex
    ? 'no-cache'
    : 'public, max-age=31536000, immutable');
  if (request.method === 'HEAD') {
    response.end();
  } else {
    await pipeline(createReadStream(filePath), response);
  }
  return true;
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
  registration,
) {
  if (!['GET', 'POST'].includes(request.method)) {
    response.setHeader('allow', 'GET, POST');
    writeJson(response, 405, {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed' },
      id: null,
    }, requestId, corsAllowOrigin);
    return;
  }

  const mcpServer = user
    ? createGroupChatMcpServer({
        store,
        user,
        mcpBaseUrl: registration.mcpBaseUrl,
        logger,
        onMessageCreated: wakeOutbox,
      })
    : createRegistrationMcpServer({
        mcpBaseUrl: registration.mcpBaseUrl,
        logger,
        registerIdentity: registration.registerIdentity,
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
          let recipientUserIds = [];
          if (event.type === 'message.created' && event.roomId) {
            recipientUserIds = await store.listRealtimeRecipientUserIds(
              event.roomId,
              event.payload.seq,
            );
          } else if (event.type === 'profile.updated') {
            recipientUserIds = await store.listProfileRecipientUserIds(
              event.payload.ownerUserId,
            );
          }
          for (const userId of recipientUserIds) {
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
        if (request.method !== 'GET' || url.pathname !== '/v1/realtime') {
          throw new HttpError(404, 'resource_not_found', 'Realtime route not found');
        }
        // Existing Bearer Header wins when both authentication forms are present.
        if (!request.headers.authorization && url.searchParams.has('token')) {
          request.headers.authorization = `Bearer ${url.searchParams.get('token')}`;
        } else if (url.search && !url.searchParams.has('token')) {
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

  if (request.method === 'POST' && path === '/v1/auth/register') {
    if (!options.publicRegistration) {
      throw new HttpError(404, 'resource_not_found', 'Public registration is disabled');
    }
    options.checkRegistrationRateLimit(requestIp(request, options));
    const body = await readJson(request);
    assertFields(
      body,
      ['username', 'displayName', 'password', 'passwordConfirmation', 'bindingCode'],
      ['username', 'displayName', 'password', 'passwordConfirmation', 'bindingCode'],
    );
    const { username, usernameKey } = normalizedUsername(body.username);
    const displayName = assertString(body.displayName, 'displayName', 1, 80).trim();
    if (displayName.length === 0) {
      throw new HttpError(400, 'invalid_request', 'displayName must not be blank');
    }
    const password = assertString(body.password, 'password', 6, 128);
    if (body.passwordConfirmation !== password) {
      throw new HttpError(400, 'invalid_request', 'passwordConfirmation does not match password');
    }
    const bindingCode = assertString(body.bindingCode, 'bindingCode', 8, 9);
    const digest = await createPasswordDigest(password);
    const result = await store.registerWebAccount({
      username,
      usernameKey,
      displayName,
      passwordSalt: digest.salt,
      passwordHash: digest.hash,
      bindingCode,
    });
    response.setHeader('set-cookie', webSessionCookie(result.token, options.secureCookies));
    write(201, result.user);
    return;
  }

  if (request.method === 'POST' && path === '/v1/auth/login') {
    const body = await readJson(request);
    assertFields(body, ['username', 'password'], ['username', 'password']);
    const { usernameKey } = normalizedUsername(body.username);
    const password = assertString(body.password, 'password', 6, 128);
    const credentials = await store.getWebLoginCredentials({ usernameKey });
    if (!await verifyPasswordDigest(password, credentials.passwordSalt, credentials.passwordHash)) {
      throw new HttpError(401, 'invalid_credentials', 'Username or password is incorrect');
    }
    const result = await store.createWebSession({ userId: credentials.userId, label: 'Web browser' });
    response.setHeader('set-cookie', webSessionCookie(result.token, options.secureCookies));
    write(200, result.user);
    return;
  }

  if (request.method === 'POST' && path === '/v1/auth/reset-password') {
    const body = await readJson(request);
    assertFields(
      body,
      ['username', 'newPassword', 'passwordConfirmation', 'resetCode'],
      ['username', 'newPassword', 'passwordConfirmation', 'resetCode'],
    );
    const { usernameKey } = normalizedUsername(body.username);
    const password = assertString(body.newPassword, 'newPassword', 6, 128);
    if (body.passwordConfirmation !== password) {
      throw new HttpError(400, 'invalid_request', 'passwordConfirmation does not match newPassword');
    }
    const digest = await createPasswordDigest(password);
    await store.resetWebPassword({
      usernameKey,
      resetCode: assertString(body.resetCode, 'resetCode', 8, 9),
      passwordSalt: digest.salt,
      passwordHash: digest.hash,
    });
    response.setHeader('set-cookie', clearedWebSessionCookie(options.secureCookies));
    write(204);
    return;
  }

  if (path === '/mcp') {
    assertMcpOrigin(request, options.mcpAllowedOrigins);
    if (!request.headers.authorization && url.searchParams.has('token')) {
      request.headers.authorization = `Bearer ${url.searchParams.get('token')}`;
    }
    let user = null;
    if (request.headers.authorization) {
      user = await store.authenticate(bearerToken(request));
      if (request.method === 'POST') options.checkMcpRateLimit(user.userId);
    } else if (!options.publicRegistration) {
      throw new HttpError(401, 'authentication_required', 'Bearer session required');
    }
    const baseUrl = mcpBaseUrl(request, options);
    await handleMcpRequest(
      store,
      user,
      request,
      response,
      requestId,
      options.corsAllowOrigin,
      options.logger,
      wakeOutbox,
      {
        mcpBaseUrl: baseUrl,
        registerIdentity: async (args) => {
          options.checkRegistrationRateLimit(requestIp(request, options));
          return store.createMcpRegistration({
            displayName: args.displayName.trim(),
            deviceLabel: args.deviceLabel,
            key: args.clientRequestId,
            requestFingerprint: fingerprint('MCP', '/mcp/group_register', args),
          });
        },
      },
    );
    return;
  }

  if (!path.startsWith('/v1/')) {
    if (await serveFrontend(
      request,
      response,
      path,
      requestId,
      options.corsAllowOrigin,
      options.frontendDist,
    )) return;
    throw new HttpError(404, 'resource_not_found', 'Route not found');
  }
  const user = await authUser(store, request);
  if (!request.headers.authorization && !isAllowedWebMutation(request.method, path)) {
    throw new HttpError(
      403,
      'web_read_only',
      'Web sessions cannot change room state; use an MCP device token',
    );
  }

  if (request.method === 'POST' && path === '/v1/auth/logout') {
    await store.revokeDevice({ userId: user.userId, deviceId: user.deviceId });
    response.setHeader('set-cookie', clearedWebSessionCookie(options.secureCookies));
    write(204);
    return;
  }

  if (request.method === 'POST' && path === '/v1/auth/change-password') {
    const body = await readJson(request);
    assertFields(
      body,
      ['currentPassword', 'newPassword', 'passwordConfirmation'],
      ['currentPassword', 'newPassword', 'passwordConfirmation'],
    );
    const currentPassword = assertString(body.currentPassword, 'currentPassword', 6, 128);
    const newPassword = assertString(body.newPassword, 'newPassword', 6, 128);
    if (body.passwordConfirmation !== newPassword) {
      throw new HttpError(400, 'invalid_request', 'passwordConfirmation does not match newPassword');
    }
    const credentials = await store.getWebLoginCredentialsByUserId({ userId: user.userId });
    if (!await verifyPasswordDigest(
      currentPassword,
      credentials.passwordSalt,
      credentials.passwordHash,
    )) {
      throw new HttpError(401, 'invalid_credentials', 'Current password is incorrect');
    }
    const digest = await createPasswordDigest(newPassword);
    await store.changeWebPassword({
      userId: user.userId,
      currentDeviceId: user.deviceId,
      passwordSalt: digest.salt,
      passwordHash: digest.hash,
    });
    write(204);
    return;
  }

  if (request.method === 'POST' && path === '/v1/auth/upgrade') {
    const body = await readJson(request);
    assertFields(
      body,
      ['username', 'password', 'passwordConfirmation'],
      ['username', 'password', 'passwordConfirmation'],
    );
    const { username, usernameKey } = normalizedUsername(body.username);
    const password = assertString(body.password, 'password', 6, 128);
    if (body.passwordConfirmation !== password) {
      throw new HttpError(400, 'invalid_request', 'passwordConfirmation does not match password');
    }
    const digest = await createPasswordDigest(password);
    const result = await store.upgradeWebAccount({
      userId: user.userId,
      username,
      usernameKey,
      passwordSalt: digest.salt,
      passwordHash: digest.hash,
    });
    response.setHeader('set-cookie', webSessionCookie(result.token, options.secureCookies));
    write(200, result.user);
    return;
  }

  if (request.method === 'GET' && path === '/v1/me') {
    write(200, await store.getMe({ userId: user.userId }));
    return;
  }

  if (request.method === 'PATCH' && path === '/v1/me') {
    const body = await readJson(request);
    const key = assertString(request.headers['operation-id'], 'Operation-Id');
    assertFields(
      body,
      ['expectedProfileRevision', 'displayName', 'avatarResourceId'],
      ['expectedProfileRevision'],
    );
    if (Object.keys(body).length < 2) {
      throw new HttpError(400, 'invalid_request', 'At least one profile field is required');
    }
    let displayName;
    if (Object.hasOwn(body, 'displayName')) {
      displayName = assertString(body.displayName, 'displayName', 1, 80).trim();
      if (displayName.length === 0) {
        throw new HttpError(400, 'invalid_request', 'displayName must not be blank');
      }
    }
    const avatarResourceId = Object.hasOwn(body, 'avatarResourceId')
      ? assertNullableString(body.avatarResourceId, 'avatarResourceId')
      : undefined;
    const result = await store.updateMyProfile({
      userId: user.userId,
      expectedProfileRevision: assertInteger(
        body.expectedProfileRevision,
        'expectedProfileRevision',
        1,
        Number.MAX_SAFE_INTEGER,
      ),
      displayName,
      avatarResourceId,
      key,
      requestFingerprint: fingerprint(request.method, path, body),
    });
    write(result.status, result.body);
    return;
  }

  if (request.method === 'POST' && path === '/v1/profile-resources') {
    const avatar = await readAvatar(request);
    write(201, await store.createProfileResource({
      userId: user.userId,
      mimeType: avatar.mimeType,
      content: avatar.content,
    }));
    return;
  }

  const profileResourceMatch = path.match(/^\/v1\/profile-resources\/([^/]+)$/);
  if (request.method === 'GET' && profileResourceMatch) {
    const resource = await store.getProfileResource({
      resourceId: parsePathSegment(profileResourceMatch[1]),
    });
    response.statusCode = 200;
    response.setHeader('content-type', resource.mimeType);
    response.setHeader('content-length', String(resource.byteSize));
    applyCommonHeaders(response, requestId, options.corsAllowOrigin);
    response.end(resource.content);
    return;
  }

  if (request.method === 'GET' && path === '/v1/me/devices') {
    write(200, { items: await store.listDevices({ userId: user.userId }) });
    return;
  }

  if (request.method === 'POST' && path === '/v1/me/devices') {
    const body = await readJson(request);
    assertFields(body, ['label'], ['label']);
    const result = await store.createMcpDeviceSession({
      userId: user.userId,
      label: assertString(body.label, 'label', 1, 80),
    });
    const urlWithToken = new URL(mcpBaseUrl(request, options));
    urlWithToken.searchParams.set('token', result.token);
    write(201, {
      ...result,
      mcpUrl: urlWithToken.toString(),
      authorizationHeader: `Bearer ${result.token}`,
    });
    return;
  }

  const deviceMatch = path.match(/^\/v1\/me\/devices\/([^/]+)$/);
  if (request.method === 'DELETE' && deviceMatch) {
    await store.revokeDevice({
      userId: user.userId,
      deviceId: parsePathSegment(deviceMatch[1]),
    });
    write(204);
    return;
  }

  if (request.method === 'GET' && path === '/v1/agent-profiles') {
    write(200, { items: await store.listAgentProfiles({ userId: user.userId }) });
    return;
  }

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

  if (request.method === 'GET' && path === '/v1/invites/preview') {
    const inviteToken = assertString(url.searchParams.get('token'), 'token', 22, 256);
    write(200, await store.invitePreview({ inviteToken }));
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

  const webReadMatch = path.match(/^\/v1\/rooms\/([^/]+)\/read$/);
  if (request.method === 'PUT' && webReadMatch) {
    const body = await readJson(request);
    assertFields(body, ['readSeq'], ['readSeq']);
    write(200, await store.updateWebRoomRead({
      userId: user.userId,
      roomId: parsePathSegment(webReadMatch[1]),
      readSeq: assertInteger(body.readSeq, 'readSeq', 0, Number.MAX_SAFE_INTEGER),
    }));
    return;
  }

  const messagesMatch = path.match(/^\/v1\/rooms\/([^/]+)\/messages$/);
  if (messagesMatch) {
    const roomId = parsePathSegment(messagesMatch[1]);
    if (request.method === 'GET') {
      const afterSeqValue = url.searchParams.get('afterSeq');
      const beforeSeqValue = url.searchParams.get('beforeSeq');
      if (afterSeqValue !== null && beforeSeqValue !== null) {
        throw new HttpError(400, 'invalid_request', 'afterSeq and beforeSeq cannot be combined');
      }
      const limitValue = url.searchParams.get('limit');
      const limit = limitValue === null ? (afterSeqValue === null ? 100 : 50) : Number(limitValue);
      assertInteger(limit, 'limit', 1, 200);
      if (afterSeqValue !== null) {
        const afterSeq = Number(afterSeqValue);
        assertInteger(afterSeq, 'afterSeq', 0, Number.MAX_SAFE_INTEGER);
        write(200, await store.listMessages({
          userId: user.userId,
          roomId,
          afterSeq,
          limit,
        }));
      } else {
        const beforeSeq = beforeSeqValue === null ? null : Number(beforeSeqValue);
        if (beforeSeq !== null) {
          assertInteger(beforeSeq, 'beforeSeq', 1, Number.MAX_SAFE_INTEGER);
        }
        write(200, await store.listWebMessages({
          userId: user.userId,
          roomId,
          beforeSeq,
          limit,
        }));
      }
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
  publicRegistration = process.env.PUBLIC_REGISTRATION === '1',
  trustProxy = process.env.TRUST_PROXY === '1',
  store = new MemoryGroupChatStore(),
  logger = console,
  corsAllowOrigin = process.env.CORS_ALLOW_ORIGIN ?? '*',
  mcpAllowedOrigins = parseMcpAllowedOrigins(process.env.MCP_ALLOWED_ORIGINS),
  mcpRateLimitPerMinute = Number(process.env.MCP_RATE_LIMIT_PER_MINUTE ?? 300),
  outboxPollIntervalMs = 250,
  secureCookies = process.env.NODE_ENV === 'production',
  frontendDist = FRONTEND_DIST,
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
  const checkRegistrationRateLimit = createRegistrationRateLimiter(10);
  let wakeOutbox = () => {};
  const server = createServer((request, response) => {
    const requestId = newId('req');
    handleRequest(
      store,
      request,
      response,
      {
        devAuthEnabled: effectiveDevAuthEnabled,
        publicRegistration,
        trustProxy,
        corsAllowOrigin,
        checkMcpRateLimit,
        checkRegistrationRateLimit,
        logger,
        mcpAllowedOrigins: effectiveMcpAllowedOrigins,
        secureCookies,
        frontendDist,
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
