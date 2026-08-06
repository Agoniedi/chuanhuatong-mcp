import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, describe, it } from 'node:test';
import WebSocket from 'ws';
import { MemoryGroupChatStore } from '../src/group_chat_store.mjs';
import { createLocalServer } from '../src/server.mjs';

let server;
let baseUrl;
let users;

async function requestAt(origin, path, options = {}) {
  const response = await fetch(`${origin}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
  });
  const body = response.status === 204 ? null : await response.json();
  return { response, body };
}

async function request(path, options = {}) {
  return requestAt(baseUrl, path, options);
}

async function json(path, method, body, headers = {}) {
  return request(path, { method, body: JSON.stringify(body), headers });
}

async function jsonAt(origin, path, method, body, headers = {}) {
  return requestAt(origin, path, { method, body: JSON.stringify(body), headers });
}

async function startIsolatedServer(options) {
  const isolatedServer = createLocalServer(options);
  isolatedServer.listen(0, '127.0.0.1');
  await once(isolatedServer, 'listening');
  return {
    server: isolatedServer,
    baseUrl: `http://127.0.0.1:${isolatedServer.address().port}`,
  };
}

function realtimeUrl() {
  return `${baseUrl.replace('http://', 'ws://')}/v1/realtime`;
}

async function openRealtime(accessToken) {
  const socket = new WebSocket(realtimeUrl(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const ready = waitForRealtimeEvent(socket, 'connection.ready');
  await Promise.all([once(socket, 'open'), ready]);
  return socket;
}

function waitForRealtimeEvent(socket, type, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${type}`));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timeout);
      socket.off('message', onMessage);
      socket.off('error', onError);
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    function onMessage(data) {
      const event = JSON.parse(data.toString());
      if (event.type !== type) return;
      cleanup();
      resolve(event);
    }
    socket.on('message', onMessage);
    socket.on('error', onError);
  });
}

async function closeRealtime(socket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = once(socket, 'close');
  socket.close();
  await closed;
}

async function createManualGenerationFixture(prefix, { ready = true } = {}) {
  const auth = { Authorization: `Bearer ${users.alice.accessToken}` };
  const profile = await json('/v1/agent-profiles', 'POST', {
    displayName: `${prefix} AI`,
    shortBio: 'Generation lifecycle test profile.',
  }, {
    ...auth,
    'Idempotency-Key': `${prefix}-profile`,
  });
  const room = await json('/v1/rooms', 'POST', { title: `${prefix} room` }, {
    ...auth,
    'Idempotency-Key': `${prefix}-room`,
  });
  const bindingBody = {
    agentProfileId: profile.body.id,
    participationMode: 'manual',
    publishMode: 'reviewRequired',
    triggerScope: 'mentionsOnly',
    preferredRuntimeDeviceId: 'device-alice',
    generationLimitPer24h: 20,
    expectedPolicyRevision: null,
  };
  const binding = await json(`/v1/rooms/${room.body.id}/my-agent`, 'PUT', bindingBody, {
    ...auth,
    'Operation-Id': `${prefix}-binding`,
  });
  const trigger = await json(`/v1/rooms/${room.body.id}/messages`, 'POST', {
    clientMessageId: `${prefix}-trigger`,
    content: { schemaVersion: 1, type: 'text', text: 'Please answer this message.' },
  }, {
    ...auth,
    'Idempotency-Key': `${prefix}-trigger`,
  });
  let runtime = null;
  if (ready) {
    runtime = await json(
      `/v1/rooms/${room.body.id}/my-agent/runtimes/device-alice`,
      'PUT',
      {
        readiness: 'ready',
        readyForBindingPolicyRevision: binding.body.policyRevision,
        runtimeCapabilitiesVersion: 1,
        localConfigRevision: 1,
      },
      { ...auth, 'Operation-Id': `${prefix}-runtime` },
    );
  }
  const generationBody = {
    clientGenerationRequestId: `${prefix}-generation`,
    triggerMessageIds: [trigger.body.id],
    expectedBindingPolicyRevision: binding.body.policyRevision,
  };
  const generationHeaders = {
    ...auth,
    'Idempotency-Key': `${prefix}-generation`,
  };
  const generation = await json(
    `/v1/rooms/${room.body.id}/generation-requests`,
    'POST',
    generationBody,
    generationHeaders,
  );
  return {
    auth,
    profile: profile.body,
    room: room.body,
    binding: binding.body,
    bindingBody,
    trigger: trigger.body,
    runtime: runtime?.body ?? null,
    generation: generation.body,
    generationBody,
    generationHeaders,
  };
}

before(async () => {
  server = createLocalServer({ devAuthEnabled: true, logger: { warn() {} } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const alice = await json('/__dev/guest-session', 'POST', {
    deviceId: 'device-alice',
    displayName: 'Alice',
  });
  const bob = await json('/__dev/guest-session', 'POST', {
    deviceId: 'device-bob',
    displayName: 'Bob',
  });
  const charlie = await json('/__dev/guest-session', 'POST', {
    deviceId: 'device-charlie',
    displayName: 'Charlie',
  });
  users = { alice: alice.body, bob: bob.body, charlie: charlie.body };
});

after(async () => {
  server.close();
  await once(server, 'close');
});

describe('local group chat REST loop', () => {
  it('does not expose guest sessions when development authentication is disabled', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const lockedServer = createLocalServer({ devAuthEnabled: true });
      lockedServer.listen(0, '127.0.0.1');
      await once(lockedServer, 'listening');
      const lockedUrl = `http://127.0.0.1:${lockedServer.address().port}`;
      const response = await fetch(`${lockedUrl}/__dev/guest-session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: 'device-blocked', displayName: 'Blocked' }),
      });
      assert.equal(response.status, 404);
      lockedServer.close();
      await once(lockedServer, 'close');
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it('registers one user idempotently and returns a valid replacement token on replay', async () => {
    const isolated = await startIsolatedServer({
      publicRegistration: true,
      logger: { warn() {}, error() {} },
    });
    try {
      const missingKey = await jsonAt(
        isolated.baseUrl,
        '/v1/auth/register',
        'POST',
        { displayName: 'Missing Registration Key' },
      );
      const headers = { 'Idempotency-Key': 'registration-idempotency-1' };
      const first = await jsonAt(
        isolated.baseUrl,
        '/v1/auth/register',
        'POST',
        { displayName: 'Registration User' },
        headers,
      );
      const replay = await jsonAt(
        isolated.baseUrl,
        '/v1/auth/register',
        'POST',
        { displayName: 'Registration User' },
        headers,
      );
      const conflict = await jsonAt(
        isolated.baseUrl,
        '/v1/auth/register',
        'POST',
        { displayName: 'Different Registration User' },
        headers,
      );
      const me = await requestAt(isolated.baseUrl, '/v1/me', {
        headers: { Authorization: `Bearer ${replay.body.token}` },
      });

      assert.equal(missingKey.response.status, 400);
      assert.equal(missingKey.body.error.code, 'invalid_request');
      assert.equal(first.response.status, 201);
      assert.equal(replay.response.status, 201);
      assert.equal(replay.body.userId, first.body.userId);
      assert.notEqual(replay.body.token, first.body.token);
      assert.equal(conflict.response.status, 409);
      assert.equal(conflict.body.error.code, 'idempotency_conflict');
      assert.equal(me.response.status, 200);
      assert.equal(me.body.userId, first.body.userId);
      assert.equal(me.body.displayName, 'Registration User');
    } finally {
      await isolated.server.shutdown();
    }
  });

  it('ignores forwarded client addresses unless proxy trust is enabled', async () => {
    const untrusted = await startIsolatedServer({
      publicRegistration: true,
      logger: { warn() {}, error() {} },
    });
    try {
      for (let index = 0; index < 11; index += 1) {
        const result = await jsonAt(
          untrusted.baseUrl,
          '/v1/auth/register',
          'POST',
          { displayName: `Untrusted Proxy User ${index}` },
          {
            'Idempotency-Key': `untrusted-proxy-registration-${index}`,
            'X-Forwarded-For': `203.0.113.${index + 1}`,
          },
        );
        assert.equal(result.response.status, index < 10 ? 201 : 429);
      }
    } finally {
      await untrusted.server.shutdown();
    }

    const trusted = await startIsolatedServer({
      publicRegistration: true,
      trustProxy: true,
      logger: { warn() {}, error() {} },
    });
    try {
      for (let index = 0; index < 11; index += 1) {
        const result = await jsonAt(
          trusted.baseUrl,
          '/v1/auth/register',
          'POST',
          { displayName: `Trusted Proxy User ${index}` },
          {
            'Idempotency-Key': `trusted-proxy-registration-${index}`,
            'X-Forwarded-For': `198.51.100.${index + 1}`,
          },
        );
        assert.equal(result.response.status, 201);
      }
    } finally {
      await trusted.server.shutdown();
    }
  });

  it('keeps guest identity stable and rejects normalized duplicate nicknames', async () => {
    const first = await json('/__dev/guest-session', 'POST', {
      deviceId: 'device-delta',
      displayName: 'Delta',
    });
    const resumed = await json('/__dev/guest-session', 'POST', {
      deviceId: 'device-delta',
      displayName: 'Delta',
    });
    const duplicate = await json('/__dev/guest-session', 'POST', {
      deviceId: 'device-echo',
      displayName: 'Ｄｅｌｔａ',
    });
    const renamed = await json('/__dev/guest-session', 'POST', {
      deviceId: 'device-delta',
      displayName: 'Echo',
    });
    const released = await json('/__dev/guest-session', 'POST', {
      deviceId: 'device-foxtrot',
      displayName: 'Delta',
    });

    assert.equal(first.response.status, 200);
    assert.equal(resumed.body.user.userId, first.body.user.userId);
    assert.equal(duplicate.response.status, 409);
    assert.equal(duplicate.body.error.code, 'conflict');
    assert.equal(renamed.body.user.userId, first.body.user.userId);
    assert.equal(renamed.body.user.profileRevision, 2);
    assert.equal(released.response.status, 200);
  });

  it('requires a bearer session and rejects unknown request fields', async () => {
    const unauthenticated = await json('/v1/rooms', 'POST', { title: 'Private' }, {
      'Idempotency-Key': 'room-auth-check',
    });
    assert.equal(unauthenticated.response.status, 401);
    assert.equal(unauthenticated.body.error.code, 'authentication_required');

    const unknownField = await json('/v1/rooms', 'POST', { title: 'Private', extra: true }, {
      Authorization: `Bearer ${users.alice.accessToken}`,
      'Idempotency-Key': 'room-unknown-field',
    });
    assert.equal(unknownField.response.status, 400);
    assert.equal(unknownField.body.error.code, 'invalid_request');
  });

  it('creates a room and returns the exact idempotent result', async () => {
    const headers = {
      Authorization: `Bearer ${users.alice.accessToken}`,
      'Idempotency-Key': 'room-create-1',
    };
    const first = await json('/v1/rooms', 'POST', { title: 'Local AI Room' }, headers);
    const replay = await json('/v1/rooms', 'POST', { title: 'Local AI Room' }, headers);
    const conflict = await json('/v1/rooms', 'POST', { title: 'Different Room' }, headers);
    assert.equal(first.response.status, 201);
    assert.equal(replay.response.status, 201);
    assert.equal(replay.body.id, first.body.id);
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.error.code, 'idempotency_conflict');
    assert.equal(first.body.lastSeq, 0);
    assert.equal(first.body.historyVisibility, 'after_join');
  });

  it('accepts a limited invite and enforces expiry, revocation, and use count', async () => {
    const room = (await request('/v1/rooms', {
      headers: { Authorization: `Bearer ${users.alice.accessToken}` },
    })).body.items[0];
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const invite = await json(`/v1/rooms/${room.id}/invites`, 'POST', {
      expectedRoomRevision: room.revision,
      expiresAt,
      maxUses: 1,
    }, {
      Authorization: `Bearer ${users.alice.accessToken}`,
      'Idempotency-Key': 'invite-create-1',
    });
    assert.equal(invite.response.status, 201);
    assert.equal(typeof invite.body.inviteToken, 'string');

    const preview = await request(
      `/v1/invites/preview?token=${encodeURIComponent(invite.body.inviteToken)}`,
      { headers: { Authorization: `Bearer ${users.bob.accessToken}` } },
    );
    assert.equal(preview.response.status, 200);
    assert.equal(preview.body.roomTitle, room.title);
    assert.equal(preview.body.inviterDisplayName, 'Alice');
    assert.equal(preview.body.expiresAt, expiresAt);
    assert.equal(preview.body.remainingUses, 1);

    const accepted = await json('/v1/invites/accept', 'POST', {
      inviteToken: invite.body.inviteToken,
    }, {
      Authorization: `Bearer ${users.bob.accessToken}`,
      'Operation-Id': 'invite-accept-bob',
    });
    assert.equal(accepted.response.status, 200);
    assert.equal(accepted.body.membership.role, 'member');
    assert.equal(accepted.body.membership.joinedSeq, 1);

    const exhausted = await json('/v1/invites/accept', 'POST', {
      inviteToken: invite.body.inviteToken,
    }, {
      Authorization: `Bearer ${users.charlie.accessToken}`,
      'Operation-Id': 'invite-accept-charlie',
    });
    assert.equal(exhausted.response.status, 409);
    assert.equal(exhausted.body.error.code, 'conflict');

    const roomAfterJoin = accepted.body.room;
    const secondInvite = await json(`/v1/rooms/${roomAfterJoin.id}/invites`, 'POST', {
      expectedRoomRevision: roomAfterJoin.revision,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      maxUses: 1,
    }, {
      Authorization: `Bearer ${users.alice.accessToken}`,
      'Idempotency-Key': 'invite-create-revoke',
    });
    const revoked = await request(`/v1/rooms/${roomAfterJoin.id}/invites/${secondInvite.body.id}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${users.alice.accessToken}`,
        'Operation-Id': 'invite-revoke-1',
      },
    });
    assert.equal(revoked.response.status, 204);
    const revokedAccept = await json('/v1/invites/accept', 'POST', {
      inviteToken: secondInvite.body.inviteToken,
    }, {
      Authorization: `Bearer ${users.charlie.accessToken}`,
      'Operation-Id': 'invite-accept-revoked',
    });
    assert.equal(revokedAccept.response.status, 409);

    const expired = await json(`/v1/rooms/${roomAfterJoin.id}/invites`, 'POST', {
      expectedRoomRevision: roomAfterJoin.revision,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      maxUses: 1,
    }, {
      Authorization: `Bearer ${users.alice.accessToken}`,
      'Idempotency-Key': 'invite-expired',
    });
    assert.equal(expired.response.status, 400);
    assert.equal(expired.body.error.code, 'invalid_request');
  });

  it('keeps messages append-only and clamps new members to their joined sequence', async () => {
    const room = (await json('/v1/rooms', 'POST', { title: 'History Boundary Room' }, {
      Authorization: `Bearer ${users.alice.accessToken}`,
      'Idempotency-Key': 'room-history-boundary',
    })).body;
    const beforeJoin = await json(`/v1/rooms/${room.id}/messages`, 'POST', {
      clientMessageId: 'message-before-join',
      content: { schemaVersion: 1, type: 'text', text: 'Before Bob joined' },
    }, {
      Authorization: `Bearer ${users.alice.accessToken}`,
      'Idempotency-Key': 'message-before-join',
    });
    assert.equal(beforeJoin.response.status, 201);

    const invite = await json(`/v1/rooms/${room.id}/invites`, 'POST', {
      expectedRoomRevision: room.revision,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      maxUses: 1,
    }, {
      Authorization: `Bearer ${users.alice.accessToken}`,
      'Idempotency-Key': 'invite-history-boundary',
    });
    const joined = await json('/v1/invites/accept', 'POST', { inviteToken: invite.body.inviteToken }, {
      Authorization: `Bearer ${users.charlie.accessToken}`,
      'Operation-Id': 'invite-history-accept',
    });
    const hiddenHistory = await request(`/v1/rooms/${room.id}/messages?afterSeq=0`, {
      headers: { Authorization: `Bearer ${users.charlie.accessToken}` },
    });
    assert.equal(joined.body.membership.joinedSeq, 2);
    assert.equal(hiddenHistory.response.status, 200);
    assert.deepEqual(hiddenHistory.body.items, []);

    const afterJoin = await json(`/v1/rooms/${room.id}/messages`, 'POST', {
      clientMessageId: 'message-after-join',
      content: { schemaVersion: 1, type: 'text', text: 'Visible to Charlie' },
      mentions: [{ kind: 'user', targetId: users.charlie.user.userId }],
    }, {
      Authorization: `Bearer ${users.alice.accessToken}`,
      'Idempotency-Key': 'message-after-join',
    });
    assert.equal(afterJoin.response.status, 201);
    const visible = await request(`/v1/rooms/${room.id}/messages?afterSeq=0&limit=1`, {
      headers: { Authorization: `Bearer ${users.charlie.accessToken}` },
    });
    assert.equal(visible.body.items.length, 1);
    assert.equal(visible.body.items[0].seq, 2);
    assert.equal(visible.body.highWaterSeq, 2);
  });

  it('authenticates realtime connections and broadcasts each new message once', async () => {
    const unauthorized = new WebSocket(realtimeUrl());
    unauthorized.on('error', () => {});
    const [, unauthorizedResponse] = await once(unauthorized, 'unexpected-response');
    assert.equal(unauthorizedResponse.statusCode, 401);
    unauthorizedResponse.resume();

    const queryToken = new WebSocket(
      `${realtimeUrl()}?access_token=${users.alice.accessToken}`,
    );
    queryToken.on('error', () => {});
    const [, queryTokenResponse] = await once(queryToken, 'unexpected-response');
    assert.equal(queryTokenResponse.statusCode, 404);
    queryTokenResponse.resume();

    const room = (await json('/v1/rooms', 'POST', { title: 'Realtime Room' }, {
      Authorization: `Bearer ${users.alice.accessToken}`,
      'Idempotency-Key': 'room-realtime',
    })).body;
    const invite = await json(`/v1/rooms/${room.id}/invites`, 'POST', {
      expectedRoomRevision: room.revision,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      maxUses: 1,
    }, {
      Authorization: `Bearer ${users.alice.accessToken}`,
      'Idempotency-Key': 'invite-realtime',
    });
    await json('/v1/invites/accept', 'POST', {
      inviteToken: invite.body.inviteToken,
    }, {
      Authorization: `Bearer ${users.bob.accessToken}`,
      'Operation-Id': 'invite-realtime-bob',
    });

    const aliceSocket = await openRealtime(users.alice.accessToken);
    const bobSocket = await openRealtime(users.bob.accessToken);
    try {
      const aliceEvent = waitForRealtimeEvent(aliceSocket, 'message.created');
      const bobEvent = waitForRealtimeEvent(bobSocket, 'message.created');
      const created = await json(`/v1/rooms/${room.id}/messages`, 'POST', {
        clientMessageId: 'message-realtime',
        content: { schemaVersion: 1, type: 'text', text: 'Realtime hello' },
      }, {
        Authorization: `Bearer ${users.alice.accessToken}`,
        'Idempotency-Key': 'message-realtime',
      });

      const [receivedByAlice, receivedByBob] = await Promise.all([aliceEvent, bobEvent]);
      for (const event of [receivedByAlice, receivedByBob]) {
        assert.equal(event.protocolVersion, 1);
        assert.equal(event.type, 'message.created');
        assert.equal(event.roomId, room.id);
        assert.equal(event.payload.id, created.body.id);
        assert.equal(event.payload.roomId, room.id);
        assert.equal(typeof event.eventId, 'string');
        assert.equal(typeof event.occurredAt, 'string');
      }

      const duplicate = waitForRealtimeEvent(aliceSocket, 'message.created', 150);
      const replay = await json(`/v1/rooms/${room.id}/messages`, 'POST', {
        clientMessageId: 'message-realtime',
        content: { schemaVersion: 1, type: 'text', text: 'Realtime hello' },
      }, {
        Authorization: `Bearer ${users.alice.accessToken}`,
        'Idempotency-Key': 'message-realtime',
      });
      assert.equal(replay.body.id, created.body.id);
      await assert.rejects(duplicate, /Timed out waiting for message\.created/);
    } finally {
      await Promise.all([closeRealtime(aliceSocket), closeRealtime(bobSocket)]);
    }
  });

  it('stops realtime delivery when the connected device session is revoked', async () => {
    const realtimeStore = new MemoryGroupChatStore();
    const realtimeServer = createLocalServer({
      devAuthEnabled: true,
      store: realtimeStore,
      logger: { warn() {}, error() {} },
      outboxPollIntervalMs: 5,
    });
    realtimeServer.listen(0, '127.0.0.1');
    await once(realtimeServer, 'listening');
    const realtimeBaseUrl = `http://127.0.0.1:${realtimeServer.address().port}`;
    const session = await realtimeStore.createGuestSession({
      deviceId: 'revoked-realtime-device',
      displayName: 'Revoked Realtime User',
    });
    const room = await realtimeStore.createRoom({
      userId: session.user.userId,
      title: 'Revoked realtime room',
      key: 'revoked-realtime-room',
      requestFingerprint: 'revoked-realtime-room-fingerprint',
    });
    const socket = new WebSocket(
      `${realtimeBaseUrl.replace('http://', 'ws://')}/v1/realtime`,
      { headers: { Authorization: `Bearer ${session.accessToken}` } },
    );
    const ready = waitForRealtimeEvent(socket, 'connection.ready');
    await Promise.all([once(socket, 'open'), ready]);

    try {
      const outcome = new Promise((resolve) => {
        socket.once('message', () => resolve('message'));
        socket.once('close', (code) => resolve({ code }));
      });
      realtimeStore.sessions.clear();
      await realtimeStore.createHumanMessage({
        user: session.user,
        roomId: room.body.id,
        clientMessageId: 'revoked-realtime-message',
        text: 'This event must not be delivered',
        mentions: [],
        replyToMessageId: null,
        key: 'revoked-realtime-message',
        requestFingerprint: 'revoked-realtime-message-fingerprint',
      });

      assert.deepEqual(await outcome, { code: 1008 });
    } finally {
      await closeRealtime(socket);
      await realtimeServer.shutdown();
    }
  });

  it('keeps generation pagination valid when the cursor item changes status', async () => {
    const paginationStore = new MemoryGroupChatStore();
    const baseRequest = {
      roomId: 'pagination-room',
      bindingId: 'pagination-binding',
      ownerUserId: 'pagination-user',
      creatorDeviceId: 'pagination-device',
      source: 'manual',
      triggerMessageIds: [],
      triggerFromSeq: 1,
      triggerThroughSeq: 1,
      contextThroughSeq: 1,
      minVisibleSeq: 1,
      historyPolicyRevision: 1,
      bindingPolicyRevision: 1,
      status: 'queued',
      requestVersion: 1,
      leaseEpoch: 0,
      attempt: 1,
    };
    paginationStore.generationRequests.set('generation-newer', {
      ...baseRequest,
      id: 'generation-newer',
      createdAt: '2026-08-04T02:00:00.000Z',
      updatedAt: '2026-08-04T02:00:00.000Z',
    });
    paginationStore.generationRequests.set('generation-older', {
      ...baseRequest,
      id: 'generation-older',
      createdAt: '2026-08-04T01:00:00.000Z',
      updatedAt: '2026-08-04T01:00:00.000Z',
    });
    const user = { userId: 'pagination-user', deviceId: 'pagination-device' };
    const firstPage = await paginationStore.listGenerationRequests({
      user,
      statuses: ['queued'],
      pageToken: null,
      limit: 1,
    });
    assert.deepEqual(firstPage.items.map((item) => item.id), ['generation-newer']);
    assert.equal(firstPage.nextPageToken, 'generation-newer');

    paginationStore.generationRequests.get('generation-newer').status = 'claimed';
    const secondPage = await paginationStore.listGenerationRequests({
      user,
      statuses: ['queued'],
      pageToken: firstPage.nextPageToken,
      limit: 1,
    });
    assert.deepEqual(secondPage.items.map((item) => item.id), ['generation-older']);
    assert.equal(secondPage.nextPageToken, null);
  });

  it('rejects stale room revisions and preserves private membership fields', async () => {
    const room = (await request('/v1/rooms', {
      headers: { Authorization: `Bearer ${users.alice.accessToken}` },
    })).body.items[0];
    const staleInvite = await json(`/v1/rooms/${room.id}/invites`, 'POST', {
      expectedRoomRevision: room.revision - 1,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      maxUses: 1,
    }, {
      Authorization: `Bearer ${users.alice.accessToken}`,
      'Idempotency-Key': 'invite-stale-revision',
    });
    assert.equal(staleInvite.response.status, 409);
    assert.equal(staleInvite.body.error.code, 'request_version_conflict');

    const members = await request(`/v1/rooms/${room.id}/members`, {
      headers: { Authorization: `Bearer ${users.alice.accessToken}` },
    });
    assert.equal(members.response.status, 200);
    assert.equal('readSeq' in members.body.items[0], false);
    const mine = await request(`/v1/rooms/${room.id}/members/me`, {
      headers: { Authorization: `Bearer ${users.alice.accessToken}` },
    });
    assert.equal(mine.response.status, 200);
    assert.equal(typeof mine.body.readSeq, 'number');
  });

  it('keeps agent profiles public while restricting mutations to the owner', async () => {
    const headers = {
      Authorization: `Bearer ${users.alice.accessToken}`,
      'Idempotency-Key': 'agent-profile-create-alice',
    };
    const profileBody = {
      displayName: 'Alice Assistant',
      shortBio: 'A public description only.',
    };
    const created = await json('/v1/agent-profiles', 'POST', profileBody, headers);
    const replay = await json('/v1/agent-profiles', 'POST', profileBody, headers);
    const conflict = await json('/v1/agent-profiles', 'POST', {
      ...profileBody,
      shortBio: 'Different input',
    }, headers);

    assert.equal(created.response.status, 201);
    assert.equal(created.body.ownerUserId, users.alice.user.userId);
    assert.equal(created.body.avatarResourceId, null);
    assert.equal(created.body.profileRevision, 1);
    assert.deepEqual(replay.body, created.body);
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.error.code, 'idempotency_conflict');

    const publicRead = await request(`/v1/agent-profiles/${created.body.id}`, {
      headers: { Authorization: `Bearer ${users.bob.accessToken}` },
    });
    assert.equal(publicRead.response.status, 200);
    assert.deepEqual(publicRead.body, created.body);

    const forbiddenUpdate = await json(
      `/v1/agent-profiles/${created.body.id}`,
      'PATCH',
      { expectedProfileRevision: 1, shortBio: 'Not mine' },
      {
        Authorization: `Bearer ${users.bob.accessToken}`,
        'Operation-Id': 'agent-profile-update-not-owner',
      },
    );
    assert.equal(forbiddenUpdate.response.status, 403);
    assert.equal(forbiddenUpdate.body.error.code, 'forbidden');

    const privateField = await json('/v1/agent-profiles', 'POST', {
      ...profileBody,
      localAssistantId: 'private-local-id',
    }, {
      Authorization: `Bearer ${users.alice.accessToken}`,
      'Idempotency-Key': 'agent-profile-private-field',
    });
    assert.equal(privateField.response.status, 400);
    assert.equal(privateField.body.error.code, 'invalid_request');

    const blankName = await json('/v1/agent-profiles', 'POST', {
      displayName: '   ',
      shortBio: '',
    }, {
      Authorization: `Bearer ${users.alice.accessToken}`,
      'Idempotency-Key': 'agent-profile-blank-name',
    });
    assert.equal(blankName.response.status, 400);

    const longBio = await json('/v1/agent-profiles', 'POST', {
      displayName: 'Too Much Biography',
      shortBio: 'x'.repeat(501),
    }, {
      Authorization: `Bearer ${users.alice.accessToken}`,
      'Idempotency-Key': 'agent-profile-long-bio',
    });
    assert.equal(longBio.response.status, 400);

    const unverifiedAvatar = await json('/v1/agent-profiles', 'POST', {
      ...profileBody,
      avatarResourceId: 'unverified-avatar',
    }, {
      Authorization: `Bearer ${users.alice.accessToken}`,
      'Idempotency-Key': 'agent-profile-unverified-avatar',
    });
    assert.equal(unverifiedAvatar.response.status, 403);
    assert.equal(unverifiedAvatar.body.error.code, 'forbidden');

    const updateHeaders = {
      Authorization: `Bearer ${users.alice.accessToken}`,
      'Operation-Id': 'agent-profile-update-alice',
    };
    const updateBody = {
      expectedProfileRevision: 1,
      displayName: 'Alice AI',
      shortBio: 'Updated public description.',
    };
    const updated = await json(
      `/v1/agent-profiles/${created.body.id}`,
      'PATCH',
      updateBody,
      updateHeaders,
    );
    const updateReplay = await json(
      `/v1/agent-profiles/${created.body.id}`,
      'PATCH',
      updateBody,
      updateHeaders,
    );
    const stale = await json(
      `/v1/agent-profiles/${created.body.id}`,
      'PATCH',
      { expectedProfileRevision: 1, shortBio: 'Stale' },
      {
        Authorization: `Bearer ${users.alice.accessToken}`,
        'Operation-Id': 'agent-profile-update-stale',
      },
    );
    assert.equal(updated.response.status, 200);
    assert.equal(updated.body.profileRevision, 2);
    assert.deepEqual(updateReplay.body, updated.body);
    assert.equal(stale.response.status, 409);
    assert.equal(stale.body.error.code, 'request_version_conflict');
  });

  it('separates authoritative room bindings from member-visible snapshots', async () => {
    const aliceProfile = await json('/v1/agent-profiles', 'POST', {
      displayName: 'Alice Room AI',
      shortBio: 'Visible to room members.',
    }, {
      Authorization: `Bearer ${users.alice.accessToken}`,
      'Idempotency-Key': 'binding-profile-alice',
    });
    const bobProfile = await json('/v1/agent-profiles', 'POST', {
      displayName: 'Bob Room AI',
      shortBio: 'Owned by Bob.',
    }, {
      Authorization: `Bearer ${users.bob.accessToken}`,
      'Idempotency-Key': 'binding-profile-bob',
    });
    const room = await json('/v1/rooms', 'POST', { title: 'Agent binding room' }, {
      Authorization: `Bearer ${users.alice.accessToken}`,
      'Idempotency-Key': 'binding-room-create',
    });
    const invite = await json(`/v1/rooms/${room.body.id}/invites`, 'POST', {
      expectedRoomRevision: room.body.revision,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      maxUses: 1,
    }, {
      Authorization: `Bearer ${users.alice.accessToken}`,
      'Idempotency-Key': 'binding-room-invite',
    });
    await json('/v1/invites/accept', 'POST', {
      inviteToken: invite.body.inviteToken,
    }, {
      Authorization: `Bearer ${users.bob.accessToken}`,
      'Operation-Id': 'binding-room-join-bob',
    });

    const nonMemberList = await request(
      `/v1/rooms/${room.body.id}/agent-bindings`,
      { headers: { Authorization: `Bearer ${users.charlie.accessToken}` } },
    );
    assert.equal(nonMemberList.response.status, 403);

    const bindingBody = {
      agentProfileId: aliceProfile.body.id,
      participationMode: 'manual',
      publishMode: 'reviewRequired',
      triggerScope: 'mentionsOnly',
      preferredRuntimeDeviceId: 'device-alice',
      generationLimitPer24h: 20,
      expectedPolicyRevision: null,
    };
    const putHeaders = {
      Authorization: `Bearer ${users.alice.accessToken}`,
      'Operation-Id': 'binding-create-alice',
    };
    const created = await json(
      `/v1/rooms/${room.body.id}/my-agent`,
      'PUT',
      bindingBody,
      putHeaders,
    );
    const replay = await json(
      `/v1/rooms/${room.body.id}/my-agent`,
      'PUT',
      bindingBody,
      putHeaders,
    );
    assert.equal(created.response.status, 201);
    assert.equal(created.body.policyRevision, 1);
    assert.equal(created.body.preferredRuntimeDeviceId, 'device-alice');
    assert.equal(created.body.generationLimitPer24h, 20);
    assert.deepEqual(replay.body, created.body);

    const mine = await request(`/v1/rooms/${room.body.id}/my-agent`, {
      headers: { Authorization: `Bearer ${users.alice.accessToken}` },
    });
    assert.deepEqual(mine.body, created.body);
    const bobMine = await request(`/v1/rooms/${room.body.id}/my-agent`, {
      headers: { Authorization: `Bearer ${users.bob.accessToken}` },
    });
    assert.equal(bobMine.response.status, 404);

    const publicList = await request(`/v1/rooms/${room.body.id}/agent-bindings`, {
      headers: { Authorization: `Bearer ${users.bob.accessToken}` },
    });
    assert.equal(publicList.response.status, 200);
    assert.equal(publicList.body.items.length, 1);
    assert.deepEqual(
      Object.keys(publicList.body.items[0]).sort(),
      [
        'agentProfileId',
        'agentProfileRevision',
        'avatarResourceId',
        'bindingId',
        'displayName',
        'ownerUserId',
        'participationMode',
        'policyRevision',
        'publishMode',
        'roomId',
        'triggerScope',
        'updatedAt',
      ].sort(),
    );
    assert.equal(publicList.body.items[0].agentProfileRevision, 1);

    const invalidPolicy = await json(
      `/v1/rooms/${room.body.id}/my-agent`,
      'PUT',
      { ...bindingBody, participationMode: 'sometimes', expectedPolicyRevision: 1 },
      {
        Authorization: `Bearer ${users.alice.accessToken}`,
        'Operation-Id': 'binding-invalid-policy',
      },
    );
    assert.equal(invalidPolicy.response.status, 400);

    const invalidLimit = await json(
      `/v1/rooms/${room.body.id}/my-agent`,
      'PUT',
      { ...bindingBody, generationLimitPer24h: 0, expectedPolicyRevision: 1 },
      {
        Authorization: `Bearer ${users.alice.accessToken}`,
        'Operation-Id': 'binding-invalid-limit',
      },
    );
    assert.equal(invalidLimit.response.status, 400);

    const privateBindingField = await json(
      `/v1/rooms/${room.body.id}/my-agent`,
      'PUT',
      {
        ...bindingBody,
        expectedPolicyRevision: 1,
        localAssistantId: 'private-local-id',
      },
      {
        Authorization: `Bearer ${users.alice.accessToken}`,
        'Operation-Id': 'binding-private-field',
      },
    );
    assert.equal(privateBindingField.response.status, 400);

    const wrongDevice = await json(
      `/v1/rooms/${room.body.id}/my-agent`,
      'PUT',
      { ...bindingBody, preferredRuntimeDeviceId: 'device-bob', expectedPolicyRevision: 1 },
      {
        Authorization: `Bearer ${users.alice.accessToken}`,
        'Operation-Id': 'binding-wrong-device',
      },
    );
    assert.equal(wrongDevice.response.status, 403);

    const otherOwnersProfile = await json(
      `/v1/rooms/${room.body.id}/my-agent`,
      'PUT',
      { ...bindingBody, agentProfileId: bobProfile.body.id, expectedPolicyRevision: 1 },
      {
        Authorization: `Bearer ${users.alice.accessToken}`,
        'Operation-Id': 'binding-wrong-profile-owner',
      },
    );
    assert.equal(otherOwnersProfile.response.status, 403);

    const profileUpdate = await json(
      `/v1/agent-profiles/${aliceProfile.body.id}`,
      'PATCH',
      { expectedProfileRevision: 1, shortBio: 'New public profile revision.' },
      {
        Authorization: `Bearer ${users.alice.accessToken}`,
        'Operation-Id': 'binding-profile-revision-update',
      },
    );
    assert.equal(profileUpdate.body.profileRevision, 2);
    const projected = await request(`/v1/rooms/${room.body.id}/agent-bindings`, {
      headers: { Authorization: `Bearer ${users.bob.accessToken}` },
    });
    assert.equal(projected.body.items[0].agentProfileRevision, 2);

    const replaced = await json(
      `/v1/rooms/${room.body.id}/my-agent`,
      'PUT',
      {
        ...bindingBody,
        preferredRuntimeDeviceId: null,
        generationLimitPer24h: 30,
        expectedPolicyRevision: 1,
      },
      {
        Authorization: `Bearer ${users.alice.accessToken}`,
        'Operation-Id': 'binding-replace-alice',
      },
    );
    assert.equal(replaced.response.status, 200);
    assert.equal(replaced.body.bindingId, created.body.bindingId);
    assert.equal(replaced.body.policyRevision, 2);

    const stale = await json(
      `/v1/rooms/${room.body.id}/my-agent`,
      'PUT',
      { ...bindingBody, expectedPolicyRevision: 1 },
      {
        Authorization: `Bearer ${users.alice.accessToken}`,
        'Operation-Id': 'binding-replace-stale',
      },
    );
    assert.equal(stale.response.status, 409);
    assert.equal(stale.body.error.code, 'request_version_conflict');

    const deleteHeaders = {
      Authorization: `Bearer ${users.alice.accessToken}`,
      'Operation-Id': 'binding-delete-alice',
    };
    const deleted = await request(
      `/v1/rooms/${room.body.id}/my-agent?expectedPolicyRevision=2`,
      { method: 'DELETE', headers: deleteHeaders },
    );
    const deleteReplay = await request(
      `/v1/rooms/${room.body.id}/my-agent?expectedPolicyRevision=2`,
      { method: 'DELETE', headers: deleteHeaders },
    );
    assert.equal(deleted.response.status, 204);
    assert.equal(deleteReplay.response.status, 204);
    const afterDelete = await request(`/v1/rooms/${room.body.id}/my-agent`, {
      headers: { Authorization: `Bearer ${users.alice.accessToken}` },
    });
    assert.equal(afterDelete.response.status, 404);
    const publicAfterDelete = await request(
      `/v1/rooms/${room.body.id}/agent-bindings`,
      { headers: { Authorization: `Bearer ${users.bob.accessToken}` } },
    );
    assert.deepEqual(publicAfterDelete.body.items, []);
  });

  it('registers only the authenticated runtime and creates manual requests idempotently', async () => {
    const fixture = await createManualGenerationFixture('generation-create', { ready: false });
    const runtimePath = `/v1/rooms/${fixture.room.id}/my-agent/runtimes`;
    const wrongDevice = await json(`${runtimePath}/device-bob`, 'PUT', {
      readiness: 'ready',
      readyForBindingPolicyRevision: 1,
      runtimeCapabilitiesVersion: 1,
      localConfigRevision: 1,
    }, {
      ...fixture.auth,
      'Operation-Id': 'generation-runtime-wrong-device',
    });
    assert.equal(wrongDevice.response.status, 403);

    const staleRuntime = await json(`${runtimePath}/device-alice`, 'PUT', {
      readiness: 'ready',
      readyForBindingPolicyRevision: 2,
      runtimeCapabilitiesVersion: 1,
      localConfigRevision: 1,
    }, {
      ...fixture.auth,
      'Operation-Id': 'generation-runtime-stale-policy',
    });
    assert.equal(staleRuntime.response.status, 409);
    assert.equal(staleRuntime.body.error.code, 'request_version_conflict');

    const notReadyClaim = await json(
      `/v1/generation-requests/${fixture.generation.id}/claim`,
      'POST',
      { expectedRequestVersion: 1 },
      { ...fixture.auth, 'Operation-Id': 'generation-claim-not-ready' },
    );
    assert.equal(notReadyClaim.response.status, 409);
    assert.equal(notReadyClaim.body.error.code, 'runtime_not_ready');

    const readyRuntime = await json(`${runtimePath}/device-alice`, 'PUT', {
      readiness: 'ready',
      readyForBindingPolicyRevision: 1,
      runtimeCapabilitiesVersion: 1,
      localConfigRevision: 3,
    }, {
      ...fixture.auth,
      'Operation-Id': 'generation-runtime-ready',
    });
    assert.equal(readyRuntime.response.status, 200);
    assert.deepEqual(Object.keys(readyRuntime.body).sort(), [
      'bindingId',
      'deviceId',
      'localConfigRevision',
      'readiness',
      'readyForBindingPolicyRevision',
      'runtimeCapabilitiesVersion',
      'updatedAt',
    ].sort());

    const replay = await json(
      `/v1/rooms/${fixture.room.id}/generation-requests`,
      'POST',
      fixture.generationBody,
      fixture.generationHeaders,
    );
    assert.deepEqual(replay.body, fixture.generation);
    const conflict = await json(
      `/v1/rooms/${fixture.room.id}/generation-requests`,
      'POST',
      { ...fixture.generationBody, triggerMessageIds: ['missing-message'] },
      fixture.generationHeaders,
    );
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.error.code, 'idempotency_conflict');

    const missingTrigger = await json(
      `/v1/rooms/${fixture.room.id}/generation-requests`,
      'POST',
      {
        clientGenerationRequestId: 'generation-create-missing-trigger',
        triggerMessageIds: ['missing-message'],
        expectedBindingPolicyRevision: 1,
      },
      {
        ...fixture.auth,
        'Idempotency-Key': 'generation-create-missing-trigger',
      },
    );
    assert.equal(missingTrigger.response.status, 404);
    assert.equal(missingTrigger.body.error.code, 'resource_not_found');

    const wrongKey = await json(
      `/v1/rooms/${fixture.room.id}/generation-requests`,
      'POST',
      { ...fixture.generationBody, clientGenerationRequestId: 'different-id' },
      fixture.generationHeaders,
    );
    assert.equal(wrongKey.response.status, 409);
    assert.equal(wrongKey.body.error.code, 'idempotency_conflict');

    assert.equal(fixture.generation.status, 'queued');
    assert.equal(fixture.generation.requestVersion, 1);
    assert.deepEqual(fixture.generation.triggerMessageIds, [fixture.trigger.id]);
    assert.equal(fixture.generation.contextThroughSeq, fixture.trigger.seq);
    assert.equal('creatorDeviceId' in fixture.generation, false);

    const listed = await request('/v1/generation-requests?status=queued&limit=1', {
      headers: fixture.auth,
    });
    assert.equal(listed.response.status, 200);
    assert.equal(listed.body.items[0].id, fixture.generation.id);
    assert.equal(listed.body.nextPageToken, null);
    const fetched = await request(`/v1/generation-requests/${fixture.generation.id}`, {
      headers: fixture.auth,
    });
    assert.deepEqual(fetched.body, fixture.generation);
    const forbidden = await request(`/v1/generation-requests/${fixture.generation.id}`, {
      headers: { Authorization: `Bearer ${users.bob.accessToken}` },
    });
    assert.equal(forbidden.response.status, 403);
  });

  it('claims, starts, reviews, and publishes one immutable agent message', async () => {
    const fixture = await createManualGenerationFixture('generation-publish');
    const basePath = `/v1/generation-requests/${fixture.generation.id}`;
    const operationHeaders = (operationId) => ({
      ...fixture.auth,
      'Operation-Id': operationId,
    });

    const staleClaim = await json(`${basePath}/claim`, 'POST', {
      expectedRequestVersion: 0,
    }, operationHeaders('generation-claim-stale'));
    assert.equal(staleClaim.response.status, 409);
    assert.equal(staleClaim.body.error.code, 'request_version_conflict');

    const claimBody = { expectedRequestVersion: 1 };
    const claimed = await json(
      `${basePath}/claim`,
      'POST',
      claimBody,
      operationHeaders('generation-claim'),
    );
    const claimReplay = await json(
      `${basePath}/claim`,
      'POST',
      claimBody,
      operationHeaders('generation-claim'),
    );
    assert.equal(claimed.body.status, 'claimed');
    assert.equal(claimed.body.requestVersion, 2);
    assert.equal(claimed.body.claimedDeviceId, 'device-alice');
    assert.equal(claimed.body.leaseEpoch, 1);
    assert.deepEqual(claimReplay.body, claimed.body);

    const wrongLease = await json(`${basePath}/start`, 'POST', {
      expectedRequestVersion: 2,
      leaseId: 'wrong-lease',
      leaseEpoch: 1,
    }, operationHeaders('generation-start-wrong-lease'));
    assert.equal(wrongLease.response.status, 409);
    assert.equal(wrongLease.body.error.code, 'lease_conflict');

    const leaseBody = {
      expectedRequestVersion: 2,
      leaseId: claimed.body.leaseId,
      leaseEpoch: claimed.body.leaseEpoch,
    };
    const started = await json(
      `${basePath}/start`,
      'POST',
      leaseBody,
      operationHeaders('generation-start'),
    );
    const startReplay = await json(
      `${basePath}/start`,
      'POST',
      leaseBody,
      operationHeaders('generation-start'),
    );
    assert.equal(started.body.status, 'generating');
    assert.equal(started.body.requestVersion, 3);
    assert.equal(started.body.attempt, 1);
    assert.deepEqual(startReplay.body, started.body);

    const draftLeak = await json(`${basePath}/review-pending`, 'POST', {
      expectedRequestVersion: 3,
      leaseId: claimed.body.leaseId,
      leaseEpoch: claimed.body.leaseEpoch,
      draft: 'private draft must stay local',
    }, operationHeaders('generation-review-draft-leak'));
    assert.equal(draftLeak.response.status, 400);

    const review = await json(`${basePath}/review-pending`, 'POST', {
      expectedRequestVersion: 3,
      leaseId: claimed.body.leaseId,
      leaseEpoch: claimed.body.leaseEpoch,
    }, operationHeaders('generation-review'));
    assert.equal(review.body.status, 'review_pending');
    assert.equal(review.body.requestVersion, 4);
    assert.equal(review.body.draftDeviceId, 'device-alice');
    assert.equal('leaseId' in review.body, false);
    assert.equal('leaseExpiresAt' in review.body, false);
    assert.equal('draft' in review.body, false);

    const publishBody = {
      expectedRequestVersion: 4,
      expectedBindingPolicyRevision: 1,
      clientMessageId: 'generation-publish-message',
      content: { schemaVersion: 1, type: 'text', text: 'Final reviewed answer.' },
    };
    const published = await json(
      `${basePath}/publish`,
      'POST',
      publishBody,
      operationHeaders('generation-publish-operation'),
    );
    const publishReplay = await json(
      `${basePath}/publish`,
      'POST',
      publishBody,
      operationHeaders('generation-publish-operation'),
    );
    assert.equal(published.body.generationRequest.status, 'published');
    assert.equal(published.body.generationRequest.requestVersion, 5);
    assert.equal(published.body.message.sender.kind, 'agent');
    assert.equal(published.body.message.sender.agentProfileId, fixture.profile.id);
    assert.equal(published.body.message.generationRequestId, fixture.generation.id);
    assert.equal(published.body.message.triggerThroughSeq, fixture.trigger.seq);
    assert.deepEqual(publishReplay.body, published.body);

    const duplicatePublish = await json(
      `${basePath}/publish`,
      'POST',
      { ...publishBody, expectedRequestVersion: 5, clientMessageId: 'another-message' },
      operationHeaders('generation-publish-second-operation'),
    );
    assert.equal(duplicatePublish.response.status, 409);
    assert.equal(duplicatePublish.body.error.code, 'generation_state_conflict');

    const messages = await request(`/v1/rooms/${fixture.room.id}/messages?afterSeq=0`, {
      headers: fixture.auth,
    });
    assert.equal(
      messages.body.items.filter(
        (message) => message.generationRequestId === fixture.generation.id,
      ).length,
      1,
    );
  });

  it('keeps failed and discarded requests terminal and rejects stale-policy publication', async () => {
    const failFixture = await createManualGenerationFixture('generation-fail');
    const failBase = `/v1/generation-requests/${failFixture.generation.id}`;
    const failHeaders = (operationId) => ({
      ...failFixture.auth,
      'Operation-Id': operationId,
    });
    const claimed = await json(
      `${failBase}/claim`,
      'POST',
      { expectedRequestVersion: 1 },
      failHeaders('generation-fail-claim'),
    );
    await json(`${failBase}/start`, 'POST', {
      expectedRequestVersion: 2,
      leaseId: claimed.body.leaseId,
      leaseEpoch: claimed.body.leaseEpoch,
    }, failHeaders('generation-fail-start'));
    const failed = await json(`${failBase}/fail`, 'POST', {
      expectedRequestVersion: 3,
      leaseId: claimed.body.leaseId,
      leaseEpoch: claimed.body.leaseEpoch,
    }, failHeaders('generation-fail-command'));
    assert.equal(failed.body.status, 'failed');
    const reviveFailed = await json(`${failBase}/review-pending`, 'POST', {
      expectedRequestVersion: 4,
      leaseId: claimed.body.leaseId,
      leaseEpoch: claimed.body.leaseEpoch,
    }, failHeaders('generation-fail-revive'));
    assert.equal(reviveFailed.response.status, 409);
    assert.equal(reviveFailed.body.error.code, 'generation_state_conflict');

    const discardFixture = await createManualGenerationFixture('generation-discard');
    const discardBase = `/v1/generation-requests/${discardFixture.generation.id}`;
    const discardHeaders = (operationId) => ({
      ...discardFixture.auth,
      'Operation-Id': operationId,
    });
    const discardClaim = await json(
      `${discardBase}/claim`,
      'POST',
      { expectedRequestVersion: 1 },
      discardHeaders('generation-discard-claim'),
    );
    await json(`${discardBase}/start`, 'POST', {
      expectedRequestVersion: 2,
      leaseId: discardClaim.body.leaseId,
      leaseEpoch: discardClaim.body.leaseEpoch,
    }, discardHeaders('generation-discard-start'));
    await json(`${discardBase}/review-pending`, 'POST', {
      expectedRequestVersion: 3,
      leaseId: discardClaim.body.leaseId,
      leaseEpoch: discardClaim.body.leaseEpoch,
    }, discardHeaders('generation-discard-review'));
    const discarded = await json(
      `${discardBase}/discard`,
      'POST',
      { expectedRequestVersion: 4 },
      discardHeaders('generation-discard-command'),
    );
    assert.equal(discarded.body.status, 'discarded');
    const reviveDiscarded = await json(
      `${discardBase}/discard`,
      'POST',
      { expectedRequestVersion: 5 },
      discardHeaders('generation-discard-revive'),
    );
    assert.equal(reviveDiscarded.response.status, 409);
    assert.equal(reviveDiscarded.body.error.code, 'generation_state_conflict');

    const staleFixture = await createManualGenerationFixture('generation-stale-policy');
    const staleBase = `/v1/generation-requests/${staleFixture.generation.id}`;
    const staleHeaders = (operationId) => ({
      ...staleFixture.auth,
      'Operation-Id': operationId,
    });
    const staleClaim = await json(
      `${staleBase}/claim`,
      'POST',
      { expectedRequestVersion: 1 },
      staleHeaders('generation-stale-claim'),
    );
    await json(`${staleBase}/start`, 'POST', {
      expectedRequestVersion: 2,
      leaseId: staleClaim.body.leaseId,
      leaseEpoch: staleClaim.body.leaseEpoch,
    }, staleHeaders('generation-stale-start'));
    await json(`${staleBase}/review-pending`, 'POST', {
      expectedRequestVersion: 3,
      leaseId: staleClaim.body.leaseId,
      leaseEpoch: staleClaim.body.leaseEpoch,
    }, staleHeaders('generation-stale-review'));
    await json(`/v1/rooms/${staleFixture.room.id}/my-agent`, 'PUT', {
      ...staleFixture.bindingBody,
      expectedPolicyRevision: 1,
    }, staleHeaders('generation-stale-binding-update'));
    const stalePublish = await json(`${staleBase}/publish`, 'POST', {
      expectedRequestVersion: 4,
      expectedBindingPolicyRevision: 1,
      clientMessageId: 'generation-stale-message',
      content: { schemaVersion: 1, type: 'text', text: 'Must be rejected.' },
    }, staleHeaders('generation-stale-publish'));
    assert.equal(stalePublish.response.status, 409);
    assert.equal(stalePublish.body.error.code, 'request_version_conflict');
  });

  it('regenerates only by superseding an eligible terminal request', async () => {
    const fixture = await createManualGenerationFixture('generation-regenerate');
    const basePath = `/v1/generation-requests/${fixture.generation.id}`;
    const headers = (operationId) => ({
      ...fixture.auth,
      'Operation-Id': operationId,
    });
    const claimed = await json(
      `${basePath}/claim`,
      'POST',
      { expectedRequestVersion: 1 },
      headers('generation-regenerate-claim'),
    );
    await json(`${basePath}/start`, 'POST', {
      expectedRequestVersion: 2,
      leaseId: claimed.body.leaseId,
      leaseEpoch: claimed.body.leaseEpoch,
    }, headers('generation-regenerate-start'));
    await json(`${basePath}/review-pending`, 'POST', {
      expectedRequestVersion: 3,
      leaseId: claimed.body.leaseId,
      leaseEpoch: claimed.body.leaseEpoch,
    }, headers('generation-regenerate-review'));

    const prematureBody = {
      ...fixture.generationBody,
      clientGenerationRequestId: 'generation-regenerate-premature',
      supersedesRequestId: fixture.generation.id,
    };
    const premature = await json(
      `/v1/rooms/${fixture.room.id}/generation-requests`,
      'POST',
      prematureBody,
      {
        ...fixture.auth,
        'Idempotency-Key': prematureBody.clientGenerationRequestId,
      },
    );
    assert.equal(premature.response.status, 409);
    assert.equal(premature.body.error.code, 'generation_state_conflict');

    const discarded = await json(
      `${basePath}/discard`,
      'POST',
      { expectedRequestVersion: 4 },
      headers('generation-regenerate-discard'),
    );
    assert.equal(discarded.body.status, 'discarded');

    const replacementBody = {
      ...fixture.generationBody,
      clientGenerationRequestId: 'generation-regenerate-replacement',
      supersedesRequestId: fixture.generation.id,
    };
    const replacement = await json(
      `/v1/rooms/${fixture.room.id}/generation-requests`,
      'POST',
      replacementBody,
      {
        ...fixture.auth,
        'Idempotency-Key': replacementBody.clientGenerationRequestId,
      },
    );
    assert.equal(replacement.response.status, 201);
    assert.equal(replacement.body.status, 'queued');
    assert.equal(replacement.body.supersedesRequestId, fixture.generation.id);
    assert.deepEqual(replacement.body.triggerMessageIds, fixture.generationBody.triggerMessageIds);
  });
});
