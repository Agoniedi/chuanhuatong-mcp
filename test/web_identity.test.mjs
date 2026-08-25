import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, describe, it } from 'node:test';

import { createLocalServer } from '../src/server.mjs';

const MCP_VERSION = '2025-11-25';
let server;
let baseUrl;

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  return {
    response,
    body: text.length === 0 ? null : JSON.parse(text),
  };
}

async function mcp(path, method, params, headers = {}) {
  return request(path, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': MCP_VERSION,
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

before(async () => {
  server = createLocalServer({
    publicRegistration: true,
    logger: { warn() {}, error() {} },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await server.shutdown();
});

describe('MCP identity and optional Web account', () => {
  it('exposes only registration before authentication and accepts URL tokens afterwards', async () => {
    const tools = await mcp('/mcp', 'tools/list', {});
    assert.equal(tools.response.status, 200);
    assert.deepEqual(tools.body.result.tools.map((tool) => tool.name), ['group_register']);

    const registered = await mcp('/mcp', 'tools/call', {
      name: 'group_register',
      arguments: {
        clientRequestId: 'web-identity-registration-1',
        displayName: '同名用户',
        deviceLabel: 'Android phone',
      },
    });
    assert.equal(registered.response.status, 200);
    const identity = registered.body.result.structuredContent;
    assert.match(identity.token, /^ct_/);
    assert.match(identity.bindingCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(identity.label, 'Android phone');

    const authenticatedTools = await mcp(
      `/mcp?token=${encodeURIComponent(identity.token)}`,
      'tools/list',
      {},
    );
    assert.equal(authenticatedTools.response.status, 200);
    assert.ok(authenticatedTools.body.result.tools.some(
      (tool) => tool.name === 'group_create_web_binding_code',
    ));

    const duplicateName = await mcp('/mcp', 'tools/call', {
      name: 'group_register',
      arguments: {
        clientRequestId: 'web-identity-registration-2',
        displayName: '同名用户',
        deviceLabel: 'Second phone',
      },
    });
    assert.equal(duplicateName.response.status, 200);

    const webRegistration = await request('/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        username: 'reader_01',
        displayName: '网页读者',
        password: 'secret6',
        passwordConfirmation: 'secret6',
        bindingCode: identity.bindingCode,
      }),
    });
    assert.equal(webRegistration.response.status, 201);
    assert.equal(webRegistration.body.handle, 'reader_01');
    const cookie = webRegistration.response.headers.get('set-cookie').split(';')[0];

    const me = await request('/v1/me', { headers: { Cookie: cookie } });
    assert.equal(me.response.status, 200);
    assert.equal(me.body.userId, identity.userId);
    assert.equal(me.body.displayName, '网页读者');

    const cookieRoomWrite = await request('/v1/rooms', {
      method: 'POST',
      headers: { Cookie: cookie, 'Idempotency-Key': 'cookie-room-write' },
      body: JSON.stringify({ title: 'Cookie must not create this room' }),
    });
    assert.equal(cookieRoomWrite.response.status, 403);
    assert.equal(cookieRoomWrite.body.error.code, 'web_read_only');

    const bearerRoomWrite = await request('/v1/rooms', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${identity.token}`,
        'Idempotency-Key': 'bearer-room-write',
      },
      body: JSON.stringify({ title: 'MCP-created room' }),
    });
    assert.equal(bearerRoomWrite.response.status, 201);
    const cookieMessageWrite = await request(
      `/v1/rooms/${bearerRoomWrite.body.id}/messages`,
      {
        method: 'POST',
        headers: { Cookie: cookie, 'Idempotency-Key': 'cookie-message-write' },
        body: JSON.stringify({
          clientMessageId: 'cookie-message-write',
          content: { schemaVersion: 1, type: 'text', text: 'Must remain writable' },
        }),
      },
    );
    assert.equal(cookieMessageWrite.response.status, 201);
    assert.equal(cookieMessageWrite.body.sender.kind, 'human');
    assert.equal(cookieMessageWrite.body.sender.userId, identity.userId);
    assert.equal(cookieMessageWrite.body.content.text, 'Must remain writable');
    const cookieRecall = await request(
      `/v1/rooms/${bearerRoomWrite.body.id}/messages/${cookieMessageWrite.body.id}/recall`,
      { method: 'POST', headers: { Cookie: cookie }, body: '{}' },
    );
    assert.equal(cookieRecall.response.status, 200);
    assert.equal(cookieRecall.body.content.text, '');
    assert.equal(typeof cookieRecall.body.recalledAt, 'string');
    assert.equal((await request('/v1/rooms', {
      headers: { Cookie: cookie },
    })).body.items[0].id, bearerRoomWrite.body.id);
    const markedRead = await request(`/v1/rooms/${bearerRoomWrite.body.id}/read`, {
      method: 'PUT',
      headers: { Cookie: cookie },
      body: JSON.stringify({ readSeq: 0 }),
    });
    assert.equal(markedRead.response.status, 200);
    const ownerLeave = await request(`/v1/rooms/${bearerRoomWrite.body.id}/members/me`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    assert.equal(ownerLeave.response.status, 409);
    assert.equal(ownerLeave.body.error.code, 'room_owner_cannot_leave');

    const cookieAgent = await request('/v1/agent-profiles', {
      method: 'POST',
      headers: { Cookie: cookie, 'Idempotency-Key': 'cookie-agent-create' },
      body: JSON.stringify({
        displayName: '网页 AI',
        shortBio: '用于验证网页删除权限',
      }),
    });
    assert.equal(cookieAgent.response.status, 201);
    const boundAgent = await request(`/v1/rooms/${bearerRoomWrite.body.id}/my-agent`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${identity.token}`,
        'Operation-Id': 'cookie-agent-binding',
      },
      body: JSON.stringify({
        agentProfileId: cookieAgent.body.id,
        participationMode: 'manual',
        publishMode: 'reviewRequired',
        triggerScope: 'mentionsOnly',
        preferredRuntimeDeviceId: null,
        generationLimitPer24h: 20,
        expectedPolicyRevision: null,
      }),
    });
    assert.equal(boundAgent.response.status, 201);

    const cookieAgentDelete = await request(`/v1/agent-profiles/${cookieAgent.body.id}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    assert.equal(cookieAgentDelete.response.status, 204);
    const bindingsAfterDelete = await request(
      `/v1/rooms/${bearerRoomWrite.body.id}/agent-bindings`,
      { headers: { Authorization: `Bearer ${identity.token}` } },
    );
    assert.equal(bindingsAfterDelete.response.status, 200);
    assert.equal(bindingsAfterDelete.body.items.length, 0);

    const badLogin = await request('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'READER_01', password: 'wrong66' }),
    });
    assert.equal(badLogin.response.status, 401);
    assert.equal(badLogin.body.error.code, 'invalid_credentials');

    const login = await request('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'READER_01', password: 'secret6' }),
    });
    assert.equal(login.response.status, 200);
    assert.match(login.response.headers.get('set-cookie'), /HttpOnly/);
    const loginCookie = login.response.headers.get('set-cookie').split(';')[0];

    const changedPassword = await request('/v1/auth/change-password', {
      method: 'POST',
      headers: { Cookie: loginCookie },
      body: JSON.stringify({
        currentPassword: 'secret6',
        newPassword: 'changed6',
        passwordConfirmation: 'changed6',
      }),
    });
    assert.equal(changedPassword.response.status, 204);
    assert.equal(
      (await request('/v1/me', { headers: { Cookie: loginCookie } })).response.status,
      200,
    );
    assert.equal(
      (await request('/v1/me', { headers: { Cookie: cookie } })).response.status,
      401,
    );
    assert.equal((await request('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'reader_01', password: 'secret6' }),
    })).response.status, 401);
    assert.equal((await request('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'reader_01', password: 'changed6' }),
    })).response.status, 200);

    const reset = await mcp(
      '/mcp',
      'tools/call',
      { name: 'group_create_web_password_reset_code', arguments: {} },
      { Authorization: `Bearer ${identity.token}` },
    );
    const resetCode = reset.body.result.structuredContent.resetCode;
    const resetResult = await request('/v1/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({
        username: 'reader_01',
        newPassword: 'newpass6',
        passwordConfirmation: 'newpass6',
        resetCode,
      }),
    });
    assert.equal(resetResult.response.status, 204);

    const relogin = await request('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'reader_01', password: 'newpass6' }),
    });
    assert.equal(relogin.response.status, 200);
  });
});
