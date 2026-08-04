import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { MemoryGroupChatStore } from '../../src/group_chat_store.mjs';
import { createLocalServer } from '../../src/server.mjs';

const MCP_PROTOCOL_VERSION = '2025-11-25';
const MCP_ACCEPT = 'application/json, text/event-stream';
const ALLOWED_ORIGIN = 'https://mcp-client.example';

let server;
let baseUrl;
let users;
let contextRoom;
let contextBinding;
let contextMessages;
let store;

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

async function json(path, method, body, headers = {}) {
  return request(path, { method, body: JSON.stringify(body), headers });
}

async function mcp(body, {
  accessToken = users.alice.accessToken,
  accept = MCP_ACCEPT,
  origin,
  protocolVersion,
} = {}) {
  return json('/mcp', 'POST', body, {
    ...(accessToken === null ? {} : { Authorization: `Bearer ${accessToken}` }),
    Accept: accept,
    ...(origin === undefined ? {} : { Origin: origin }),
    ...(protocolVersion === undefined
      ? {}
      : { 'MCP-Protocol-Version': protocolVersion }),
  });
}

function callTool(name, args, options = {}) {
  return mcp({
    jsonrpc: '2.0',
    id: options.id ?? 1,
    method: 'tools/call',
    params: { name, arguments: args },
  }, {
    ...options,
    protocolVersion: options.protocolVersion ?? MCP_PROTOCOL_VERSION,
  });
}

function provisionAdditionalMemoryDeviceSession(userId, deviceId) {
  const accessToken = `test-token-${deviceId}`;
  store.userDevices.add(`${userId}:${deviceId}`);
  store.sessions.set(
    createHash('sha256').update(accessToken).digest('hex'),
    { userId, deviceId },
  );
  return accessToken;
}

async function createRoom(title, key) {
  return json('/v1/rooms', 'POST', { title }, {
    Authorization: `Bearer ${users.alice.accessToken}`,
    'Idempotency-Key': key,
  });
}

before(async () => {
  store = new MemoryGroupChatStore();
  server = createLocalServer({
    devAuthEnabled: true,
    store,
    logger: { warn() {}, error() {} },
    mcpAllowedOrigins: [ALLOWED_ORIGIN],
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const alice = await json('/__dev/guest-session', 'POST', {
    deviceId: 'mcp-device-alice',
    displayName: 'MCP Alice',
  });
  const bob = await json('/__dev/guest-session', 'POST', {
    deviceId: 'mcp-device-bob',
    displayName: 'MCP Bob',
  });
  const charlie = await json('/__dev/guest-session', 'POST', {
    deviceId: 'mcp-device-charlie',
    displayName: 'MCP Charlie',
  });
  const diana = await json('/__dev/guest-session', 'POST', {
    deviceId: 'mcp-device-diana',
    displayName: 'MCP Diana',
  });
  users = {
    alice: alice.body,
    bob: bob.body,
    charlie: charlie.body,
    diana: diana.body,
  };

  contextRoom = (await createRoom('MCP Context Room', 'mcp-room-context')).body;
  await createRoom('MCP Pagination Room A', 'mcp-room-page-a');
  await createRoom('MCP Pagination Room B', 'mcp-room-page-b');

  const profile = await json('/v1/agent-profiles', 'POST', {
    displayName: 'MCP Alice Agent',
    shortBio: 'Public profile for MCP context tests.',
  }, {
    Authorization: `Bearer ${users.alice.accessToken}`,
    'Idempotency-Key': 'mcp-agent-profile',
  });
  assert.equal(profile.response.status, 201);
  const binding = await json(`/v1/rooms/${contextRoom.id}/my-agent`, 'PUT', {
    agentProfileId: profile.body.id,
    participationMode: 'automatic',
    publishMode: 'automatic',
    triggerScope: 'mentionsOnly',
    preferredRuntimeDeviceId: 'mcp-device-alice',
    generationLimitPer24h: 20,
    expectedPolicyRevision: null,
  }, {
    Authorization: `Bearer ${users.alice.accessToken}`,
    'Operation-Id': 'mcp-agent-binding',
  });
  assert.equal(binding.response.status, 201);
  contextBinding = binding.body;

  const runtime = await json(
    `/v1/rooms/${contextRoom.id}/my-agent/runtimes/mcp-device-alice`,
    'PUT',
    {
      readiness: 'ready',
      readyForBindingPolicyRevision: contextBinding.policyRevision,
      runtimeCapabilitiesVersion: 1,
      localConfigRevision: 1,
    },
    {
      Authorization: `Bearer ${users.alice.accessToken}`,
      'Operation-Id': 'mcp-agent-runtime',
    },
  );
  assert.equal(runtime.response.status, 200);

  const invite = await json(`/v1/rooms/${contextRoom.id}/invites`, 'POST', {
    expectedRoomRevision: contextRoom.revision,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    maxUses: 1,
  }, {
    Authorization: `Bearer ${users.alice.accessToken}`,
    'Idempotency-Key': 'mcp-room-invite',
  });
  assert.equal(invite.response.status, 201);
  const accepted = await json('/v1/invites/accept', 'POST', {
    inviteToken: invite.body.inviteToken,
  }, {
    Authorization: `Bearer ${users.bob.accessToken}`,
    'Operation-Id': 'mcp-room-accept-bob',
  });
  assert.equal(accepted.response.status, 200);

  contextMessages = [];
  for (let index = 1; index <= 3; index += 1) {
    const message = await json(`/v1/rooms/${contextRoom.id}/messages`, 'POST', {
      clientMessageId: `mcp-message-${index}`,
      content: {
        schemaVersion: 1,
        type: 'text',
        text: `MCP message ${index}`,
      },
      mentions: [{ kind: 'agent', targetId: profile.body.id }],
    }, {
      Authorization: `Bearer ${users.alice.accessToken}`,
      'Idempotency-Key': `mcp-message-${index}`,
    });
    assert.equal(message.response.status, 201);
    contextMessages.push(message.body);
  }
});

after(async () => {
  await server.shutdown();
});

describe('stateless Group Chat MCP read loop', () => {
  it('initializes without allocating an MCP session', async () => {
    const result = await mcp({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'chuanhuatong-mcp-test', version: '1.0.0' },
      },
    });

    assert.equal(result.response.status, 200);
    assert.equal(result.response.headers.get('mcp-session-id'), null);
    assert.equal(result.body.result.protocolVersion, MCP_PROTOCOL_VERSION);
    assert.equal(result.body.result.serverInfo.name, 'chuanhuatong-mcp');
    assert.deepEqual(result.body.result.capabilities.tools, { listChanged: true });
  });

  it('advertises strict schemas, structured outputs, and read-only annotations', async () => {
    const result = await mcp({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    }, { protocolVersion: MCP_PROTOCOL_VERSION });

    assert.equal(result.response.status, 200);
    assert.equal(result.response.headers.get('mcp-session-id'), null);
    assert.deepEqual(
      result.body.result.tools.map((tool) => tool.name).sort(),
      [
        'group_activate_agent',
        'group_create_invite',
        'group_create_room',
        'group_deactivate_agent',
        'group_get_room_context',
        'group_handoff_to_room',
        'group_heartbeat_agent',
        'group_join_room',
        'group_list_rooms',
        'group_publish_agent_reply',
        'group_read_messages',
        'group_send_message',
        'group_set_display_name',
        'group_wait_for_messages',
      ],
    );
    const writeTools = [
      'group_activate_agent',
      'group_create_invite',
      'group_create_room',
      'group_deactivate_agent',
      'group_handoff_to_room',
      'group_heartbeat_agent',
      'group_join_room',
      'group_publish_agent_reply',
      'group_send_message',
      'group_set_display_name',
    ];
    for (const tool of result.body.result.tools.filter(
      (candidate) => !writeTools.includes(candidate.name))) {
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.equal(tool.outputSchema.additionalProperties, false);
      assert.deepEqual(tool.annotations, {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
    for (const name of writeTools) {
      const sendTool = result.body.result.tools.find((tool) => tool.name === name);
      assert.equal(sendTool.inputSchema.additionalProperties, false);
      assert.equal(sendTool.outputSchema.additionalProperties, false);
      assert.deepEqual(sendTool.annotations, {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
    const waitTool = result.body.result.tools.find(
      (tool) => tool.name === 'group_wait_for_messages',
    );
    assert.equal(waitTool.inputSchema.properties.timeoutMs.maximum, 5000);
    assert.match(waitTool.description, /at most once per assistant turn/i);
    const humanSendTool = result.body.result.tools.find(
      (tool) => tool.name === 'group_send_message',
    );
    assert.match(humanSendTool.description, /human identity/i);
    assert.match(humanSendTool.description, /not.*agent/i);
    const displayNameTool = result.body.result.tools.find(
      (tool) => tool.name === 'group_set_display_name',
    );
    assert.match(displayNameTool.description, /explicitly requests/i);
    assert.match(displayNameTool.description, /existing message snapshots do not change/i);
    const readTool = result.body.result.tools.find(
      (tool) => tool.name === 'group_read_messages',
    );
    assert.match(readTool.description, /senderType.*authoritative/i);
    assert.deepEqual(
      readTool.outputSchema.properties.messages.items.properties.senderType.enum,
      ['human', 'agent'],
    );
    const activateTool = result.body.result.tools.find(
      (tool) => tool.name === 'group_activate_agent',
    );
    assert.match(activateTool.description, /first-time setup/i);
    assert.match(activateTool.description, /do not call before each reply/i);
    assert.equal(activateTool.inputSchema.properties.triggerScope.default, 'allMessages');
    const agentReplyTool = result.body.result.tools.find(
      (tool) => tool.name === 'group_publish_agent_reply',
    );
    assert.match(agentReplyTool.description, /automatically recovers/i);
    assert.match(agentReplyTool.description, /first reply.*publicProfile/i);
    assert.match(agentReplyTool.description, /not group_send_message/i);
    assert.match(agentReplyTool.description, /stop the current assistant turn/i);
    assert.deepEqual(agentReplyTool.inputSchema.properties.triggerScope.enum, [
      'mentionsOnly',
      'allHumanMessages',
      'allMessages',
    ]);
    assert.deepEqual(
      agentReplyTool.outputSchema.properties.nextAction.const,
      'stop_current_turn',
    );
  });

  it('works through the official Streamable HTTP client transport', async () => {
    const client = new Client({ name: 'chuanhuatong-sdk-client-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: {
        headers: { Authorization: `Bearer ${users.alice.accessToken}` },
      },
    });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.deepEqual(
        tools.tools.map((tool) => tool.name).sort(),
        [
          'group_activate_agent',
          'group_create_invite',
          'group_create_room',
          'group_deactivate_agent',
          'group_get_room_context',
          'group_handoff_to_room',
          'group_heartbeat_agent',
          'group_join_room',
          'group_list_rooms',
          'group_publish_agent_reply',
          'group_read_messages',
          'group_send_message',
          'group_set_display_name',
          'group_wait_for_messages',
        ],
      );
      const rooms = await client.callTool({
        name: 'group_list_rooms',
        arguments: { limit: 2 },
      });
      assert.equal(rooms.isError, undefined);
      assert.equal(rooms.structuredContent.rooms.length, 2);
    } finally {
      await client.close();
    }
  });

  it('paginates rooms with an opaque cursor and no duplicates', async () => {
    const roomIds = [];
    let cursor;
    do {
      const result = await callTool('group_list_rooms', {
        limit: 1,
        ...(cursor === undefined ? {} : { cursor }),
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.body.result.isError, undefined);
      assert.deepEqual(
        JSON.parse(result.body.result.content[0].text),
        result.body.result.structuredContent,
      );
      assert.equal(result.body.result.structuredContent.rooms.length, 1);
      roomIds.push(result.body.result.structuredContent.rooms[0].id);
      cursor = result.body.result.structuredContent.nextCursor ?? undefined;
    } while (cursor !== undefined);

    assert.equal(roomIds.length, 3);
    assert.equal(new Set(roomIds).size, 3);
    assert.ok(roomIds.includes(contextRoom.id));
  });

  it('creates a room, issues an invite, and joins once through MCP', async () => {
    const createArgs = {
      clientRequestId: 'mcp-create-room-charlie',
      title: 'MCP Self-service Room',
    };
    const created = await callTool('group_create_room', createArgs, {
      accessToken: users.charlie.accessToken,
    });
    const replayedCreate = await callTool('group_create_room', createArgs, {
      accessToken: users.charlie.accessToken,
    });
    const room = created.body.result.structuredContent;

    assert.equal(room.ownerUserId, users.charlie.user.userId);
    assert.deepEqual(replayedCreate.body.result.structuredContent, room);

    const createConflict = await callTool('group_create_room', {
      ...createArgs,
      title: 'Changed title',
    }, { accessToken: users.charlie.accessToken });
    assert.equal(createConflict.body.result.isError, true);
    assert.equal(
      JSON.parse(createConflict.body.result.content[0].text).error.code,
      'idempotency_conflict',
    );

    const inviteArgs = {
      roomId: room.id,
      clientRequestId: 'mcp-create-invite-charlie',
      expiresInSeconds: 3600,
      maxUses: 1,
    };
    const invited = await callTool('group_create_invite', inviteArgs, {
      accessToken: users.charlie.accessToken,
    });
    const replayedInvite = await callTool('group_create_invite', inviteArgs, {
      accessToken: users.charlie.accessToken,
    });
    const invite = invited.body.result.structuredContent;

    assert.equal(invite.roomId, room.id);
    assert.equal(invite.remainingUses, 1);
    assert.equal(typeof invite.inviteCode, 'string');
    assert.deepEqual(replayedInvite.body.result.structuredContent, invite);

    const forbiddenInvite = await callTool('group_create_invite', {
      ...inviteArgs,
      clientRequestId: 'mcp-create-invite-forbidden',
    }, { accessToken: users.alice.accessToken });
    assert.equal(forbiddenInvite.body.result.isError, true);
    assert.equal(
      JSON.parse(forbiddenInvite.body.result.content[0].text).error.code,
      'forbidden',
    );

    const joinArgs = {
      clientRequestId: 'mcp-join-room-bob',
      inviteCode: invite.inviteCode,
    };
    const joined = await callTool('group_join_room', joinArgs, {
      accessToken: users.bob.accessToken,
    });
    const replayedJoin = await callTool('group_join_room', joinArgs, {
      accessToken: users.bob.accessToken,
    });
    const membership = joined.body.result.structuredContent.membership;

    assert.equal(membership.userId, users.bob.user.userId);
    assert.equal(membership.role, 'member');
    assert.deepEqual(
      replayedJoin.body.result.structuredContent,
      joined.body.result.structuredContent,
    );

    const consumed = await callTool('group_join_room', {
      clientRequestId: 'mcp-join-room-diana',
      inviteCode: invite.inviteCode,
    }, { accessToken: users.diana.accessToken });
    assert.equal(consumed.body.result.isError, true);
    assert.equal(
      JSON.parse(consumed.body.result.content[0].text).error.code,
      'conflict',
    );
  });

  it('atomically creates a room, seeds handoff context, and returns a joinable invite', async () => {
    const args = {
      clientRequestId: 'mcp-handoff-alice',
      title: '方案讨论',
      contextSummary: '我们在规划传话筒的拉群协作交接功能。',
      decisions: ['新增 group_handoff_to_room 原子工具'],
      openQuestions: ['邀请码默认过期时间是否合适'],
    };
    const created = await callTool('group_handoff_to_room', args, {
      accessToken: users.alice.accessToken,
    });
    const replayed = await callTool('group_handoff_to_room', args, {
      accessToken: users.alice.accessToken,
    });
    const replayedWithExplicitDefaults = await callTool('group_handoff_to_room', {
      ...args,
      inviteOptions: {
        expiresInSeconds: 7 * 24 * 60 * 60,
        maxUses: 10,
      },
    }, { accessToken: users.alice.accessToken });
    const result = created.body.result.structuredContent;

    assert.equal(created.body.result.isError, undefined);
    assert.deepEqual(replayed.body.result.structuredContent, result);
    assert.deepEqual(replayedWithExplicitDefaults.body.result.structuredContent, result);

    const room = result.room;
    assert.equal(room.ownerUserId, users.alice.user.userId);
    assert.equal(room.title, '方案讨论');
    assert.equal(room.lastSeq, 1);
    assert.equal(room.historyVisibility, 'from_start');

    const message = result.message;
    assert.equal(message.roomId, room.id);
    assert.equal(message.seq, 1);
    assert.equal(message.senderType, 'human');
    assert.equal(message.senderDisplayName, users.alice.user.displayName);
    assert.ok(message.content.text.includes('# 背景'));
    assert.ok(message.content.text.includes(args.contextSummary));
    assert.ok(message.content.text.includes('# 已确认结论'));
    assert.ok(message.content.text.includes('- 新增 group_handoff_to_room 原子工具'));
    assert.ok(message.content.text.includes('# 待讨论事项'));

    const invite = result.invite;
    assert.equal(invite.roomId, room.id);
    assert.equal(invite.maxUses, 10);
    assert.equal(invite.remainingUses, 10);
    assert.ok(typeof invite.inviteCode === 'string' && invite.inviteCode.length >= 22);

    const conflict = await callTool('group_handoff_to_room', {
      ...args,
      contextSummary: '不同的背景',
    }, { accessToken: users.alice.accessToken });
    assert.equal(conflict.body.result.isError, true);
    assert.equal(
      JSON.parse(conflict.body.result.content[0].text).error.code,
      'idempotency_conflict',
    );

    const joined = await callTool('group_join_room', {
      clientRequestId: 'mcp-handoff-join-bob',
      inviteCode: invite.inviteCode,
    }, { accessToken: users.bob.accessToken });
    assert.equal(joined.body.result.isError, undefined);
    assert.equal(
      joined.body.result.structuredContent.room.historyVisibility,
      'from_start',
    );
    const membership = joined.body.result.structuredContent.membership;
    assert.equal(membership.readSeq, 0);
    const roomContext = await callTool('group_get_room_context', { roomId: room.id }, {
      accessToken: users.bob.accessToken,
    });
    assert.equal(roomContext.body.result.isError, undefined);
    assert.equal(roomContext.body.result.structuredContent.members.length, 2);
    const messages = await callTool('group_read_messages', {
      roomId: room.id,
      afterSeq: membership.readSeq,
      limit: 5,
    }, { accessToken: users.bob.accessToken });
    const items = messages.body.result.structuredContent.messages;
    assert.equal(items.length, 1);
    assert.equal(items[0].content.text, message.content.text);
  });

  it('keeps the derived handoff message ID valid for a maximum-length request ID', async () => {
    const created = await callTool('group_handoff_to_room', {
      clientRequestId: 'x'.repeat(128),
      title: 'Boundary handoff',
      contextSummary: 'Boundary context',
    }, { accessToken: users.alice.accessToken });

    assert.equal(created.body.result.isError, undefined);
    assert.ok(
      created.body.result.structuredContent.message.clientMessageId.length <= 128,
    );
  });

  it('rejects invalid handoff inputs and unknown fields', async () => {
    const base = {
      title: 'Handoff',
      contextSummary: 'Background',
    };
    for (const args of [
      { ...base, clientRequestId: 'handoff-blank-title', title: '   ' },
      { ...base, clientRequestId: 'handoff-long-summary', contextSummary: 'x'.repeat(32769) },
      {
        ...base,
        clientRequestId: 'handoff-overlong-assembly',
        contextSummary: 'y'.repeat(32000),
        decisions: ['z'.repeat(2000)],
      },
      { ...base, clientRequestId: 'handoff-unknown-field', extra: true },
    ]) {
      const result = await callTool('group_handoff_to_room', args, {
        accessToken: users.alice.accessToken,
      });
      assert.equal(result.body.result.isError, true);
    }
  });

  it('rejects invalid self-service room inputs and unknown fields', async () => {
    for (const [name, args] of [
      ['group_create_room', { clientRequestId: 'blank-room', title: '   ' }],
      ['group_create_invite', {
        roomId: contextRoom.id,
        clientRequestId: 'short-expiry',
        expiresInSeconds: 59,
      }],
      ['group_join_room', {
        clientRequestId: 'short-code',
        inviteCode: 'too-short',
      }],
      ['group_create_room', {
        clientRequestId: 'unknown-field',
        title: 'Strict room',
        ownerUserId: users.charlie.user.userId,
      }],
    ]) {
      const result = await callTool(name, args);
      assert.equal(result.body.result.isError, true);
    }
  });

  it('returns only public room context fields to room members', async () => {
    const result = await callTool('group_get_room_context', {
      roomId: contextRoom.id,
    }, { accessToken: users.bob.accessToken });

    assert.equal(result.response.status, 200);
    const context = result.body.result.structuredContent;
    assert.equal(context.room.id, contextRoom.id);
    assert.equal(context.members.length, 2);
    assert.equal(context.agentBindings.length, 1);
    assert.equal(context.agentBindings[0].agentProfile.displayName, 'MCP Alice Agent');
    assert.equal('preferredRuntimeDeviceId' in context.agentBindings[0].binding, false);
    assert.equal('modelId' in context.agentBindings[0].agentProfile, false);
    assert.equal('systemPrompt' in context.agentBindings[0].agentProfile, false);
  });

  it('advances nextSeq only through messages returned on the current page', async () => {
    const first = await callTool('group_read_messages', {
      roomId: contextRoom.id,
      afterSeq: 0,
      limit: 2,
    }, { accessToken: users.bob.accessToken });
    const firstPage = first.body.result.structuredContent;

    assert.deepEqual(firstPage.messages.map((message) => message.seq), [1, 2]);
    assert.equal(firstPage.nextSeq, 2);
    assert.equal(firstPage.highWaterSeq, 3);
    assert.equal(firstPage.hasMore, true);

    const second = await callTool('group_read_messages', {
      roomId: contextRoom.id,
      afterSeq: firstPage.nextSeq,
      limit: 2,
    }, { accessToken: users.bob.accessToken });
    const secondPage = second.body.result.structuredContent;

    assert.deepEqual(secondPage.messages.map((message) => message.seq), [3]);
    assert.equal(secondPage.nextSeq, 3);
    assert.equal(secondPage.highWaterSeq, 3);
    assert.equal(secondPage.hasMore, false);

    const empty = await callTool('group_read_messages', {
      roomId: contextRoom.id,
      afterSeq: secondPage.nextSeq,
      limit: 2,
    }, { accessToken: users.bob.accessToken });
    assert.deepEqual(empty.body.result.structuredContent.messages, []);
    assert.equal(empty.body.result.structuredContent.nextSeq, 3);
  });

  it('changes the authenticated human display name through MCP', async () => {
    const session = await json('/__dev/guest-session', 'POST', {
      deviceId: 'mcp-device-profile-update',
      displayName: 'MCP Profile Before',
    });
    const accessToken = session.body.accessToken;
    const room = await callTool('group_create_room', {
      clientRequestId: 'mcp-profile-update-room',
      title: 'MCP Profile Update Room',
    }, { accessToken });
    const roomId = room.body.result.structuredContent.id;
    const oldMessage = await callTool('group_send_message', {
      roomId,
      clientMessageId: 'mcp-profile-message-before',
      text: 'Before rename',
    }, { accessToken });
    const args = {
      clientRequestId: 'mcp-profile-update-name',
      displayName: 'MCP Profile After',
    };
    const updated = await callTool('group_set_display_name', args, { accessToken });
    const replay = await callTool('group_set_display_name', args, { accessToken });
    const changedReplay = await callTool('group_set_display_name', {
      ...args,
      displayName: 'Different Replay Name',
    }, { accessToken });
    const duplicate = await callTool('group_set_display_name', {
      clientRequestId: 'mcp-profile-update-duplicate',
      displayName: 'ＭＣＰ Ｂｏｂ',
    }, { accessToken });
    const blank = await callTool('group_set_display_name', {
      clientRequestId: 'mcp-profile-update-blank',
      displayName: '   ',
    }, { accessToken });
    const newMessage = await callTool('group_send_message', {
      roomId,
      clientMessageId: 'mcp-profile-message-after',
      text: 'After rename',
    }, { accessToken });
    const profile = updated.body.result.structuredContent;

    assert.equal(updated.body.result.isError, undefined);
    assert.equal(profile.userId, session.body.user.userId);
    assert.equal(profile.displayName, 'MCP Profile After');
    assert.equal(profile.profileRevision, session.body.user.profileRevision + 1);
    assert.deepEqual(replay.body.result.structuredContent, profile);
    assert.equal(changedReplay.body.result.isError, true);
    assert.equal(
      JSON.parse(changedReplay.body.result.content[0].text).error.code,
      'idempotency_conflict',
    );
    assert.equal(duplicate.body.result.isError, true);
    assert.equal(
      JSON.parse(duplicate.body.result.content[0].text).error.code,
      'conflict',
    );
    assert.equal(blank.body.result.isError, true);
    assert.equal(
      oldMessage.body.result.structuredContent.senderDisplayName,
      'MCP Profile Before',
    );
    assert.equal(
      newMessage.body.result.structuredContent.senderDisplayName,
      'MCP Profile After',
    );
  });

  it('sends one human message idempotently and rejects forged or invalid sends', async () => {
    const args = {
      roomId: contextRoom.id,
      clientMessageId: 'mcp-human-send',
      text: 'Sent through MCP',
      mentions: [{ kind: 'user', targetId: users.bob.user.userId }],
    };
    const first = await callTool('group_send_message', args);
    const replay = await callTool('group_send_message', args);

    assert.equal(first.body.result.isError, undefined);
    assert.deepEqual(replay.body.result.structuredContent, first.body.result.structuredContent);
    assert.equal(first.body.result.structuredContent.sender.kind, 'human');
    assert.equal(first.body.result.structuredContent.senderType, 'human');
    assert.equal(first.body.result.structuredContent.senderDisplayName, 'MCP Alice');
    assert.equal(
      first.body.result.structuredContent.sender.userId,
      users.alice.user.userId,
    );
    assert.deepEqual(
      JSON.parse(first.body.result.content[0].text),
      first.body.result.structuredContent,
    );

    const listed = await callTool('group_read_messages', {
      roomId: contextRoom.id,
      afterSeq: 3,
      limit: 10,
    });
    assert.deepEqual(
      listed.body.result.structuredContent.messages.map((message) => message.id),
      [first.body.result.structuredContent.id],
    );
    assert.equal(listed.body.result.structuredContent.messages[0].senderType, 'human');

    const conflict = await callTool('group_send_message', {
      ...args,
      text: 'Different text with the same id',
    });
    assert.equal(conflict.body.result.isError, true);
    assert.equal(
      JSON.parse(conflict.body.result.content[0].text).error.code,
      'idempotency_conflict',
    );

    const forgedSender = await callTool('group_send_message', {
      ...args,
      clientMessageId: 'mcp-forged-sender',
      sender: { kind: 'agent' },
    });
    assert.equal(forgedSender.body.result.isError, true);

    const blank = await callTool('group_send_message', {
      roomId: contextRoom.id,
      clientMessageId: 'mcp-blank-message',
      text: '',
    });
    assert.equal(blank.body.result.isError, true);

    const invalidAgentMention = await callTool('group_send_message', {
      roomId: contextRoom.id,
      clientMessageId: 'mcp-invalid-agent-mention',
      text: 'Do not accept an unknown agent mention',
      mentions: [{ kind: 'agent', targetId: 'missing-agent-profile' }],
    });
    assert.equal(invalidAgentMention.body.result.isError, true);
    assert.equal(
      JSON.parse(invalidAgentMention.body.result.content[0].text).error.code,
      'invalid_request',
    );

    const forbidden = await callTool('group_send_message', {
      roomId: contextRoom.id,
      clientMessageId: 'mcp-forbidden-message',
      text: 'Not a room member',
    }, { accessToken: users.charlie.accessToken });
    assert.equal(forbidden.body.result.isError, true);
    assert.equal(
      JSON.parse(forbidden.body.result.content[0].text).error.code,
      'forbidden',
    );
  });

  it('publishes one automatic agent reply idempotently with server-derived identity', async () => {
    const args = {
      roomId: contextRoom.id,
      triggerBatchId: 'mcp-agent-batch',
      triggerMessageIds: [contextMessages[2].id],
      clientMessageId: 'mcp-agent-reply',
      text: 'Automatic reply through MCP',
      mentions: [{ kind: 'user', targetId: users.bob.user.userId }],
      replyToMessageId: contextMessages[2].id,
    };
    const first = await callTool('group_publish_agent_reply', args);
    const replay = await callTool('group_publish_agent_reply', args);

    assert.equal(first.body.result.isError, undefined);
    assert.deepEqual(replay.body.result.structuredContent, first.body.result.structuredContent);
    assert.equal(first.body.result.structuredContent.status, 'published');
    assert.equal(first.body.result.structuredContent.nextAction, 'stop_current_turn');
    assert.equal(first.body.result.structuredContent.triggerBatchId, args.triggerBatchId);
    assert.equal(first.body.result.structuredContent.message.sender.kind, 'agent');
    assert.equal(first.body.result.structuredContent.message.senderType, 'agent');
    assert.equal(
      first.body.result.structuredContent.message.senderDisplayName,
      'MCP Alice Agent',
    );
    assert.equal(
      first.body.result.structuredContent.message.sender.userId,
      users.alice.user.userId,
    );
    assert.equal(
      first.body.result.structuredContent.message.sender.displayNameSnapshot,
      'MCP Alice Agent',
    );
    assert.equal(
      first.body.result.structuredContent.message.generationRequestId,
      first.body.result.structuredContent.generationRequestId,
    );

    const listed = await callTool('group_read_messages', {
      roomId: contextRoom.id,
      afterSeq: 0,
      limit: 20,
    });
    assert.equal(
      listed.body.result.structuredContent.messages.filter(
        (message) => message.clientMessageId === args.clientMessageId,
      ).length,
      1,
    );

    const conflict = await callTool('group_publish_agent_reply', {
      ...args,
      text: 'Different reply with the same batch ID',
    });
    assert.equal(conflict.body.result.isError, true);
    assert.equal(
      JSON.parse(conflict.body.result.content[0].text).error.code,
      'idempotency_conflict',
    );

    const forgedIdentity = await callTool('group_publish_agent_reply', {
      ...args,
      triggerBatchId: 'mcp-forged-agent-batch',
      clientMessageId: 'mcp-forged-agent-reply',
      sender: { kind: 'agent', agentProfileId: 'forged' },
    });
    assert.equal(forgedIdentity.body.result.isError, true);

    const noBinding = await callTool('group_publish_agent_reply', {
      ...args,
      triggerBatchId: 'mcp-bob-agent-batch',
      clientMessageId: 'mcp-bob-agent-reply',
    }, { accessToken: users.bob.accessToken });
    assert.equal(noBinding.body.result.isError, true);
    assert.equal(
      JSON.parse(noBinding.body.result.content[0].text).error.code,
      'resource_not_found',
    );

    const nonMember = await callTool('group_publish_agent_reply', {
      ...args,
      triggerBatchId: 'mcp-charlie-agent-batch',
      clientMessageId: 'mcp-charlie-agent-reply',
    }, { accessToken: users.charlie.accessToken });
    assert.equal(nonMember.body.result.isError, true);
    assert.equal(
      JSON.parse(nonMember.body.result.content[0].text).error.code,
      'forbidden',
    );
  });

  it('configures an agent profile inside the first publish call', async () => {
    const room = (await createRoom(
      'MCP Inline Agent Room',
      'mcp-inline-agent-room',
    )).body;
    const trigger = await callTool('group_send_message', {
      roomId: room.id,
      clientMessageId: 'mcp-inline-agent-trigger',
      text: 'Configure and reply without a separate activation call',
    });
    const args = {
      roomId: room.id,
      triggerBatchId: 'mcp-inline-agent-batch',
      triggerMessageIds: [trigger.body.result.structuredContent.id],
      clientMessageId: 'mcp-inline-agent-reply',
      text: 'Configured and published in one MCP call',
      publicProfile: {
        displayName: 'Inline Agent',
        avatarResourceId: null,
        shortBio: 'Configured by the first publish call',
      },
    };

    const published = await callTool('group_publish_agent_reply', args);
    const replay = await callTool('group_publish_agent_reply', args);

    assert.equal(published.body.result.isError, undefined);
    assert.equal(
      published.body.result.structuredContent.message.senderDisplayName,
      'Inline Agent',
    );
    assert.deepEqual(replay.body.result.structuredContent, published.body.result.structuredContent);
    const context = await callTool('group_get_room_context', { roomId: room.id });
    assert.equal(
      context.body.result.structuredContent.agentBindings[0].agentProfile.displayName,
      'Inline Agent',
    );
  });

  it('recovers its runtime automatically and resumes after an interrupted publish', async () => {
    const runtimePath = `/v1/rooms/${contextRoom.id}/my-agent/runtimes/mcp-device-alice`;
    const notReady = await json(runtimePath, 'PUT', {
      readiness: 'notReady',
      readyForBindingPolicyRevision: null,
      runtimeCapabilitiesVersion: 1,
      localConfigRevision: 2,
    }, {
      Authorization: `Bearer ${users.alice.accessToken}`,
      'Operation-Id': 'mcp-agent-runtime-not-ready',
    });
    assert.equal(notReady.response.status, 200);

    const unavailableTrigger = await callTool('group_send_message', {
      roomId: contextRoom.id,
      clientMessageId: 'mcp-runtime-not-ready-trigger',
      text: 'Recover the unavailable runtime before replying',
      mentions: [{ kind: 'agent', targetId: contextBinding.agentProfileId }],
    });
    assert.equal(unavailableTrigger.body.result.isError, undefined);
    const unavailableArgs = {
      roomId: contextRoom.id,
      triggerBatchId: 'mcp-runtime-not-ready-batch',
      triggerMessageIds: [unavailableTrigger.body.result.structuredContent.id],
      clientMessageId: 'mcp-runtime-not-ready-reply',
      text: 'This must wait for the runtime',
    };
    const unavailable = await callTool('group_publish_agent_reply', unavailableArgs);
    assert.equal(unavailable.body.result.isError, undefined);
    assert.equal(unavailable.body.result.structuredContent.status, 'published');

    const nextCycle = await callTool('group_send_message', {
      roomId: contextRoom.id,
      clientMessageId: 'mcp-interrupted-cycle-reset',
      text: 'Start a new cycle before testing interrupted publication',
      mentions: [{ kind: 'agent', targetId: contextBinding.agentProfileId }],
    });
    assert.equal(nextCycle.body.result.isError, undefined);

    const originalPublish = store.publishAutomaticGenerationRequest.bind(store);
    let shouldFail = true;
    store.publishAutomaticGenerationRequest = async (parameters) => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error('Injected interruption before automatic publication');
      }
      return originalPublish(parameters);
    };
    const interruptedArgs = {
      roomId: contextRoom.id,
      triggerBatchId: 'mcp-interrupted-batch',
      triggerMessageIds: [nextCycle.body.result.structuredContent.id],
      clientMessageId: 'mcp-interrupted-reply',
      text: 'Recovered automatic reply',
    };
    try {
      const interrupted = await callTool('group_publish_agent_reply', interruptedArgs);
      assert.equal(interrupted.body.result.isError, true);
      assert.equal(
        JSON.parse(interrupted.body.result.content[0].text).error.code,
        'internal_error',
      );

      const recovered = await callTool('group_publish_agent_reply', interruptedArgs);
      assert.equal(recovered.body.result.structuredContent.status, 'published');
    } finally {
      store.publishAutomaticGenerationRequest = originalPublish;
    }

    const staleRuntimeTrigger = await callTool('group_send_message', {
      roomId: contextRoom.id,
      clientMessageId: 'mcp-stale-runtime-trigger',
      text: 'Recover the stale runtime policy before replying',
      mentions: [{ kind: 'agent', targetId: contextBinding.agentProfileId }],
    });
    assert.equal(staleRuntimeTrigger.body.result.isError, undefined);
    const currentContext = await callTool('group_get_room_context', {
      roomId: contextRoom.id,
    });
    const currentBinding = currentContext.body.result.structuredContent.agentBindings.find(
      ({ binding }) => binding.ownerUserId === users.alice.user.userId,
    ).binding;
    const staleBinding = await json(`/v1/rooms/${contextRoom.id}/my-agent`, 'PUT', {
      agentProfileId: contextBinding.agentProfileId,
      participationMode: 'automatic',
      publishMode: 'automatic',
      triggerScope: 'allHumanMessages',
      preferredRuntimeDeviceId: 'mcp-device-alice',
      generationLimitPer24h: 20,
      expectedPolicyRevision: currentBinding.policyRevision,
    }, {
      Authorization: `Bearer ${users.alice.accessToken}`,
      'Operation-Id': 'mcp-agent-binding-revision-two',
    });
    assert.equal(staleBinding.response.status, 200);
    const staleRuntime = await callTool('group_publish_agent_reply', {
      roomId: contextRoom.id,
      triggerBatchId: 'mcp-stale-runtime-batch',
      triggerMessageIds: [staleRuntimeTrigger.body.result.structuredContent.id],
      clientMessageId: 'mcp-stale-runtime-reply',
      text: 'The runtime revision is stale',
    });
    assert.equal(staleRuntime.body.result.isError, undefined);
    assert.equal(staleRuntime.body.result.structuredContent.status, 'published');

    const recoveredContext = await callTool('group_get_room_context', {
      roomId: contextRoom.id,
    });
    const recoveredBinding = recoveredContext.body.result.structuredContent.agentBindings.find(
      ({ binding }) => binding.ownerUserId === users.alice.user.userId,
    ).binding;

    const nullDeviceBinding = await json(`/v1/rooms/${contextRoom.id}/my-agent`, 'PUT', {
      agentProfileId: contextBinding.agentProfileId,
      participationMode: 'automatic',
      publishMode: 'automatic',
      triggerScope: 'allHumanMessages',
      preferredRuntimeDeviceId: null,
      generationLimitPer24h: 20,
      expectedPolicyRevision: recoveredBinding.policyRevision,
    }, {
      Authorization: `Bearer ${users.alice.accessToken}`,
      'Operation-Id': 'mcp-agent-binding-no-device',
    });
    assert.equal(nullDeviceBinding.response.status, 200);
    const readyWithoutPreferredDevice = await json(runtimePath, 'PUT', {
      readiness: 'ready',
      readyForBindingPolicyRevision: nullDeviceBinding.body.policyRevision,
      runtimeCapabilitiesVersion: 1,
      localConfigRevision: 4,
    }, {
      Authorization: `Bearer ${users.alice.accessToken}`,
      'Operation-Id': 'mcp-agent-runtime-no-preferred-device',
    });
    assert.equal(readyWithoutPreferredDevice.response.status, 200);
    const noPreferredTrigger = await callTool('group_send_message', {
      roomId: contextRoom.id,
      clientMessageId: 'mcp-no-preferred-device-trigger',
      text: 'Recover the current device before replying',
    });
    assert.equal(noPreferredTrigger.body.result.isError, undefined);
    const ineligibleDevice = await callTool('group_publish_agent_reply', {
      roomId: contextRoom.id,
      triggerBatchId: 'mcp-ineligible-device-batch',
      triggerMessageIds: [noPreferredTrigger.body.result.structuredContent.id],
      clientMessageId: 'mcp-ineligible-device-reply',
      text: 'No preferred device is eligible',
    });
    assert.equal(ineligibleDevice.body.result.isError, undefined);
    assert.equal(ineligibleDevice.body.result.structuredContent.status, 'published');

    const eligibleContext = await callTool('group_get_room_context', {
      roomId: contextRoom.id,
    });
    const eligibleBinding = eligibleContext.body.result.structuredContent.agentBindings.find(
      ({ binding }) => binding.ownerUserId === users.alice.user.userId,
    ).binding;

    const disabledBinding = await json(`/v1/rooms/${contextRoom.id}/my-agent`, 'PUT', {
      agentProfileId: contextBinding.agentProfileId,
      participationMode: 'off',
      publishMode: 'automatic',
      triggerScope: 'allHumanMessages',
      preferredRuntimeDeviceId: 'mcp-device-alice',
      generationLimitPer24h: 20,
      expectedPolicyRevision: eligibleBinding.policyRevision,
    }, {
      Authorization: `Bearer ${users.alice.accessToken}`,
      'Operation-Id': 'mcp-agent-binding-disabled',
    });
    assert.equal(disabledBinding.response.status, 200);
    const disabled = await callTool('group_publish_agent_reply', {
      roomId: contextRoom.id,
      triggerBatchId: 'mcp-disabled-binding-batch',
      triggerMessageIds: [contextMessages[0].id],
      clientMessageId: 'mcp-disabled-binding-reply',
      text: 'Disabled bindings cannot publish',
    });
    assert.equal(disabled.body.result.isError, true);
    assert.equal(
      JSON.parse(disabled.body.result.content[0].text).error.code,
      'generation_state_conflict',
    );
  });

  it('waits for new messages, returns immediately when caught up data exists, and times out', async () => {
    const caughtUp = await callTool('group_read_messages', {
      roomId: contextRoom.id,
      afterSeq: 0,
      limit: 200,
    }, { accessToken: users.bob.accessToken });
    const initialHighWaterSeq = caughtUp.body.result.structuredContent.highWaterSeq;

    const waiting = callTool('group_wait_for_messages', {
      roomId: contextRoom.id,
      afterSeq: initialHighWaterSeq,
      timeoutMs: 1000,
    }, { accessToken: users.bob.accessToken });
    await delay(50);
    const sent = await callTool('group_send_message', {
      roomId: contextRoom.id,
      clientMessageId: 'mcp-wait-wakeup-message',
      text: 'Wake the bounded long poll',
    });
    const waited = await waiting;

    assert.equal(sent.body.result.isError, undefined);
    assert.deepEqual(
      waited.body.result.structuredContent.messages.map((message) => message.id),
      [sent.body.result.structuredContent.id],
    );
    assert.equal(waited.body.result.structuredContent.nextSeq, initialHighWaterSeq + 1);
    assert.equal(waited.body.result.structuredContent.hasMore, false);

    const immediateStartedAt = Date.now();
    const immediate = await callTool('group_wait_for_messages', {
      roomId: contextRoom.id,
      afterSeq: initialHighWaterSeq,
      timeoutMs: 5000,
    }, { accessToken: users.bob.accessToken });
    assert.ok(Date.now() - immediateStartedAt < 2000);
    assert.deepEqual(
      immediate.body.result.structuredContent,
      waited.body.result.structuredContent,
    );

    const timeoutStartedAt = Date.now();
    const timedOut = await callTool('group_wait_for_messages', {
      roomId: contextRoom.id,
      afterSeq: initialHighWaterSeq + 1,
      timeoutMs: 50,
    }, { accessToken: users.bob.accessToken });
    assert.ok(Date.now() - timeoutStartedAt >= 30);
    assert.deepEqual(timedOut.body.result.structuredContent.messages, []);
    assert.equal(timedOut.body.result.structuredContent.nextSeq, initialHighWaterSeq + 1);
    assert.equal(timedOut.body.result.structuredContent.highWaterSeq, initialHighWaterSeq + 1);
    assert.equal(timedOut.body.result.structuredContent.hasMore, false);

    const compensated = await callTool('group_read_messages', {
      roomId: contextRoom.id,
      afterSeq: initialHighWaterSeq,
      limit: 200,
    }, { accessToken: users.bob.accessToken });
    assert.deepEqual(
      compensated.body.result.structuredContent.messages.map((message) => message.id),
      [sent.body.result.structuredContent.id],
    );
  });

  it('rejects invalid wait cursors, bounds, and room access', async () => {
    const current = await callTool('group_read_messages', {
      roomId: contextRoom.id,
      afterSeq: 0,
      limit: 200,
    });
    const highWaterSeq = current.body.result.structuredContent.highWaterSeq;

    const futureCursor = await callTool('group_wait_for_messages', {
      roomId: contextRoom.id,
      afterSeq: highWaterSeq + 1,
      timeoutMs: 0,
    });
    assert.equal(futureCursor.body.result.isError, true);
    assert.equal(
      JSON.parse(futureCursor.body.result.content[0].text).error.code,
      'invalid_request',
    );

    const futureReadCursor = await callTool('group_read_messages', {
      roomId: contextRoom.id,
      afterSeq: highWaterSeq + 1,
      limit: 1,
    });
    assert.equal(futureReadCursor.body.result.isError, true);
    assert.equal(
      JSON.parse(futureReadCursor.body.result.content[0].text).error.code,
      'invalid_request',
    );

    for (const timeoutMs of [-1, 5001]) {
      const invalidTimeout = await callTool('group_wait_for_messages', {
        roomId: contextRoom.id,
        afterSeq: highWaterSeq,
        timeoutMs,
      });
      assert.equal(invalidTimeout.body.result.isError, true);
    }

    const forbidden = await callTool('group_wait_for_messages', {
      roomId: contextRoom.id,
      afterSeq: highWaterSeq,
      timeoutMs: 0,
    }, { accessToken: users.charlie.accessToken });
    assert.equal(forbidden.body.result.isError, true);
    assert.equal(
      JSON.parse(forbidden.body.result.content[0].text).error.code,
      'forbidden',
    );
  });

  it('activates, fences, transfers, heartbeats, and deactivates one agent lease', async () => {
    const lifecycleRoom = (await createRoom(
      'MCP Lifecycle Room',
      'mcp-lifecycle-room',
    )).body;
    const originalClock = store.clock;
    let nowMs = Date.now();
    store.clock = () => new Date(nowMs);
    const secondDeviceToken = provisionAdditionalMemoryDeviceSession(
      users.alice.user.userId,
      'mcp-device-alice-second',
    );
    const activateArgs = {
      roomId: lifecycleRoom.id,
      publicProfile: {
        displayName: 'Lifecycle Agent',
        avatarResourceId: null,
        shortBio: 'Public lifecycle profile',
      },
      triggerScope: 'allHumanMessages',
      runtimeCapabilitiesVersion: 1,
      localConfigRevision: 7,
    };

    try {
      const activated = await callTool('group_activate_agent', activateArgs);
      const activation = activated.body.result.structuredContent;
      assert.equal(activated.body.result.isError, undefined);
      assert.equal(activation.roomId, lifecycleRoom.id);
      assert.equal(activation.deviceId, 'mcp-device-alice');
      assert.equal(activation.leaseEpoch, 1);
      assert.match(activation.leaseId, /^agent-lease_/);
      assert.ok(Date.parse(activation.leaseExpiresAt) > nowMs);

      const replay = await callTool('group_activate_agent', activateArgs);
      assert.deepEqual(replay.body.result.structuredContent, activation);

      nowMs += 10_000;
      const heartbeat = await callTool('group_heartbeat_agent', {
        roomId: lifecycleRoom.id,
        leaseId: activation.leaseId,
        leaseEpoch: activation.leaseEpoch,
      });
      const renewed = heartbeat.body.result.structuredContent;
      assert.equal(renewed.leaseId, activation.leaseId);
      assert.equal(renewed.leaseEpoch, activation.leaseEpoch);
      assert.ok(Date.parse(renewed.leaseExpiresAt) > Date.parse(activation.leaseExpiresAt));

      const conflict = await callTool('group_activate_agent', activateArgs, {
        accessToken: secondDeviceToken,
      });
      assert.equal(conflict.body.result.isError, true);
      assert.equal(
        JSON.parse(conflict.body.result.content[0].text).error.code,
        'lease_conflict',
      );

      const expiredLeaseTrigger = await callTool('group_send_message', {
        roomId: lifecycleRoom.id,
        clientMessageId: 'mcp-expired-lease-trigger',
        text: 'Recover the expired lease inside the publish call',
      });
      nowMs = Date.parse(renewed.leaseExpiresAt) + 1;
      const recoveredPublish = await callTool('group_publish_agent_reply', {
        roomId: lifecycleRoom.id,
        triggerBatchId: 'mcp-expired-lease-batch',
        triggerMessageIds: [expiredLeaseTrigger.body.result.structuredContent.id],
        clientMessageId: 'mcp-expired-lease-reply',
        text: 'Published after automatic lease recovery',
      });
      assert.equal(recoveredPublish.body.result.isError, undefined);
      const recoveredBinding = store.roomAgentBindings.get(
        `${lifecycleRoom.id}:${users.alice.user.userId}`,
      );
      assert.equal(recoveredBinding.runtimeLeaseEpoch, activation.leaseEpoch + 1);
      assert.notEqual(recoveredBinding.runtimeLeaseId, activation.leaseId);
      const recoveredLeaseEpoch = recoveredBinding.runtimeLeaseEpoch;
      const recoveredLeaseId = recoveredBinding.runtimeLeaseId;
      const recoveredLeaseExpiresAt = recoveredBinding.runtimeLeaseExpiresAt;

      nowMs = Date.parse(recoveredLeaseExpiresAt) + 1;
      const takeover = await callTool('group_activate_agent', activateArgs, {
        accessToken: secondDeviceToken,
      });
      const transferred = takeover.body.result.structuredContent;
      assert.equal(transferred.deviceId, 'mcp-device-alice-second');
      assert.equal(transferred.leaseEpoch, recoveredLeaseEpoch + 1);
      assert.notEqual(transferred.leaseId, recoveredLeaseId);

      const trigger = await callTool('group_send_message', {
        roomId: lifecycleRoom.id,
        clientMessageId: 'mcp-lifecycle-trigger',
        text: 'Only the lease holder may publish',
      });
      const publishArgs = {
        roomId: lifecycleRoom.id,
        triggerBatchId: 'mcp-lifecycle-publish-batch',
        triggerMessageIds: [trigger.body.result.structuredContent.id],
        clientMessageId: 'mcp-lifecycle-agent-reply',
        text: 'Published by the active device',
      };
      const stalePublish = await callTool('group_publish_agent_reply', publishArgs);
      assert.equal(stalePublish.body.result.isError, true);
      assert.equal(
        JSON.parse(stalePublish.body.result.content[0].text).error.code,
        'lease_conflict',
      );
      const activePublish = await callTool('group_publish_agent_reply', publishArgs, {
        accessToken: secondDeviceToken,
      });
      assert.equal(activePublish.body.result.structuredContent.status, 'published');

      for (const toolName of ['group_heartbeat_agent', 'group_deactivate_agent']) {
        const stale = await callTool(toolName, {
          roomId: lifecycleRoom.id,
          leaseId: activation.leaseId,
          leaseEpoch: activation.leaseEpoch,
        });
        assert.equal(stale.body.result.isError, true);
        assert.equal(
          JSON.parse(stale.body.result.content[0].text).error.code,
          'lease_conflict',
        );
      }

      const deactivated = await callTool('group_deactivate_agent', {
        roomId: lifecycleRoom.id,
        leaseId: transferred.leaseId,
        leaseEpoch: transferred.leaseEpoch,
      }, { accessToken: secondDeviceToken });
      assert.deepEqual(deactivated.body.result.structuredContent, {
        roomId: lifecycleRoom.id,
        bindingId: transferred.bindingId,
        deviceId: 'mcp-device-alice-second',
        leaseEpoch: transferred.leaseEpoch,
        status: 'deactivated',
      });
      const deactivateReplay = await callTool('group_deactivate_agent', {
        roomId: lifecycleRoom.id,
        leaseId: transferred.leaseId,
        leaseEpoch: transferred.leaseEpoch,
      }, { accessToken: secondDeviceToken });
      assert.deepEqual(
        deactivateReplay.body.result.structuredContent,
        deactivated.body.result.structuredContent,
      );

      const context = await callTool('group_get_room_context', {
        roomId: lifecycleRoom.id,
      });
      const lifecycleBinding = context.body.result.structuredContent.agentBindings[0];
      assert.equal(lifecycleBinding.agentProfile.displayName, 'Lifecycle Agent');
      assert.equal(lifecycleBinding.binding.triggerScope, 'allHumanMessages');

      nowMs += 10_000;
      const changedPolicy = await json(`/v1/rooms/${lifecycleRoom.id}/my-agent`, 'PUT', {
        agentProfileId: activation.agentProfileId,
        participationMode: 'automatic',
        publishMode: 'automatic',
        triggerScope: 'allMessages',
        preferredRuntimeDeviceId: 'mcp-device-alice',
        generationLimitPer24h: 1000,
        expectedPolicyRevision: activation.policyRevision,
      }, {
        Authorization: `Bearer ${users.alice.accessToken}`,
        'Operation-Id': 'mcp-lifecycle-policy-change',
      });
      assert.equal(changedPolicy.response.status, 200);

      nowMs += 10_000;
      const reactivated = await callTool('group_activate_agent', activateArgs);
      assert.equal(
        reactivated.body.result.structuredContent.policyRevision,
        changedPolicy.body.policyRevision + 1,
      );
      const reactivatedContext = await callTool('group_get_room_context', {
        roomId: lifecycleRoom.id,
      });
      assert.equal(
        reactivatedContext.body.result.structuredContent.agentBindings[0].binding.updatedAt,
        new Date(nowMs).toISOString(),
      );
      assert.equal(
        reactivatedContext.body.result.structuredContent.agentBindings[0].binding.triggerScope,
        'allHumanMessages',
      );

      const forgedIdentity = await callTool('group_activate_agent', {
        ...activateArgs,
        deviceId: 'forged-device',
      });
      assert.equal(forgedIdentity.body.result.isError, true);

      const blankProfile = await callTool('group_activate_agent', {
        ...activateArgs,
        publicProfile: { ...activateArgs.publicProfile, displayName: '   ' },
      });
      assert.equal(blankProfile.body.result.isError, true);

      const nonMember = await callTool('group_activate_agent', activateArgs, {
        accessToken: users.charlie.accessToken,
      });
      assert.equal(nonMember.body.result.isError, true);
      assert.equal(
        JSON.parse(nonMember.body.result.content[0].text).error.code,
        'forbidden',
      );
    } finally {
      store.clock = originalClock;
    }
  });

  it('allows agent-triggered replies by default and preserves strict human-only mode', async () => {
    const room = (await createRoom('MCP Agent Trigger Room', 'mcp-agent-trigger-room')).body;
    const activated = await callTool('group_activate_agent', {
      roomId: room.id,
      publicProfile: {
        displayName: 'Agent Trigger Agent',
        avatarResourceId: null,
        shortBio: 'Can participate in multi-agent discussion.',
      },
      runtimeCapabilitiesVersion: 1,
      localConfigRevision: 1,
    });
    assert.equal(activated.body.result.isError, undefined);
    const binding = store.roomAgentBindings.get(`${room.id}:${users.alice.user.userId}`);
    assert.equal(binding.triggerScope, 'allMessages');

    const human = await callTool('group_send_message', {
      roomId: room.id,
      clientMessageId: 'mcp-human-trigger-message',
      text: 'Reply once to this human message.',
    });
    const firstReply = await callTool('group_publish_agent_reply', {
      roomId: room.id,
      triggerBatchId: 'mcp-human-trigger-batch',
      triggerMessageIds: [human.body.result.structuredContent.id],
      clientMessageId: 'mcp-human-trigger-reply',
      text: 'One agent reply.',
    });
    assert.equal(firstReply.body.result.isError, undefined);

    const agentTriggered = await callTool('group_publish_agent_reply', {
      roomId: room.id,
      triggerBatchId: 'mcp-self-trigger-batch',
      triggerMessageIds: [firstReply.body.result.structuredContent.message.id],
      clientMessageId: 'mcp-self-trigger-reply',
      text: 'Continue the discussion from the previous agent message.',
    });
    assert.equal(agentTriggered.body.result.isError, undefined);

    const duplicateTrigger = await callTool('group_publish_agent_reply', {
      roomId: room.id,
      triggerBatchId: 'mcp-duplicate-agent-trigger-batch',
      triggerMessageIds: [firstReply.body.result.structuredContent.message.id],
      clientMessageId: 'mcp-duplicate-agent-trigger-reply',
      text: 'Do not answer the same trigger twice.',
    });
    assert.equal(duplicateTrigger.body.result.isError, true);
    assert.equal(
      JSON.parse(duplicateTrigger.body.result.content[0].text).error.code,
      'agent_loop_limit_reached',
    );

    const strictHumanOnly = await callTool('group_publish_agent_reply', {
      roomId: room.id,
      triggerBatchId: 'mcp-strict-human-trigger-batch',
      triggerMessageIds: [agentTriggered.body.result.structuredContent.message.id],
      clientMessageId: 'mcp-strict-human-trigger-reply',
      text: 'Strict mode must still reject this agent trigger.',
      triggerScope: 'allHumanMessages',
    });
    assert.equal(strictHumanOnly.body.result.isError, true);
    assert.equal(
      JSON.parse(strictHumanOnly.body.result.content[0].text).error.code,
      'trigger_not_eligible',
    );

    const switchedBackToAgentTriggers = await callTool('group_publish_agent_reply', {
      roomId: room.id,
      triggerBatchId: 'mcp-explicit-agent-trigger-batch',
      triggerMessageIds: [agentTriggered.body.result.structuredContent.message.id],
      clientMessageId: 'mcp-explicit-agent-trigger-reply',
      text: 'An explicit allMessages policy change allows this agent trigger.',
      triggerScope: 'allMessages',
    });
    assert.equal(switchedBackToAgentTriggers.body.result.isError, undefined);
    assert.equal(binding.triggerScope, 'allMessages');
  });

  it('enforces per-agent, dynamic room, absolute AI loop limits, and human resets', async () => {
    const loopRoom = (await createRoom('MCP Loop Room', 'mcp-loop-room')).body;
    const activated = await callTool('group_activate_agent', {
      roomId: loopRoom.id,
      publicProfile: {
        displayName: 'Loop Agent',
        avatarResourceId: null,
        shortBio: 'Loop limit test profile',
      },
      triggerScope: 'allHumanMessages',
      runtimeCapabilitiesVersion: 1,
      localConfigRevision: 1,
    });
    assert.equal(activated.body.result.isError, undefined);

    let humanIndex = 0;
    let replyIndex = 0;
    const sendHuman = async () => {
      humanIndex += 1;
      const sent = await callTool('group_send_message', {
        roomId: loopRoom.id,
        clientMessageId: `mcp-loop-human-${humanIndex}`,
        text: `Human cycle ${humanIndex}`,
      });
      return sent.body.result.structuredContent;
    };
    const publish = async (triggerMessageId) => {
      replyIndex += 1;
      return callTool('group_publish_agent_reply', {
        roomId: loopRoom.id,
        triggerBatchId: `mcp-loop-batch-${replyIndex}`,
        triggerMessageIds: [triggerMessageId],
        clientMessageId: `mcp-loop-reply-${replyIndex}`,
        text: `Agent reply ${replyIndex}`,
      });
    };
    const seedAgentMessages = (count, prefix) => {
      const room = store.rooms.get(loopRoom.id);
      const messages = store.messagesByRoom.get(loopRoom.id);
      let lastMessage;
      for (let index = 0; index < count; index += 1) {
        room.lastSeq += 1;
        lastMessage = {
          id: `${prefix}-message-${index}`,
          roomId: loopRoom.id,
          seq: room.lastSeq,
          clientMessageId: `${prefix}-client-${index}`,
          sender: {
            kind: 'agent',
            userId: `${prefix}-user-${index}`,
            agentProfileId: `${prefix}-agent-${index}`,
            displayNameSnapshot: `${prefix} agent ${index}`,
            avatarResourceIdSnapshot: null,
          },
          content: { schemaVersion: 1, type: 'text', text: `${prefix} ${index}` },
          mentions: [],
          replyToMessageId: null,
          createdAt: store.clock().toISOString(),
        };
        messages.push(lastMessage);
      }
      return lastMessage;
    };

    const firstHuman = await sendHuman();
    const firstReply = await publish(firstHuman.id);
    assert.equal(firstReply.body.result.isError, undefined);
    const duplicateReply = await publish(firstHuman.id);
    assert.equal(duplicateReply.body.result.isError, true);
    assert.deepEqual(
      JSON.parse(duplicateReply.body.result.content[0].text).error,
      {
        code: 'agent_loop_limit_reached',
        message: 'Agent reply already published for the current human cycle; stop the current assistant turn',
        retryable: false,
        nextAction: 'stop_current_turn',
      },
    );
    assert.equal(
      store.messagesByRoom.get(loopRoom.id).filter(
        (message) => message.sender.kind === 'agent',
      ).length,
      1,
    );
    const firstReplyReplay = await callTool('group_publish_agent_reply', {
      roomId: loopRoom.id,
      triggerBatchId: 'mcp-loop-batch-1',
      triggerMessageIds: [firstHuman.id],
      clientMessageId: 'mcp-loop-reply-1',
      text: 'Agent reply 1',
    });
    assert.deepEqual(
      firstReplyReplay.body.result.structuredContent,
      firstReply.body.result.structuredContent,
    );

    const resetHuman = await sendHuman();
    assert.equal((await publish(resetHuman.id)).body.result.isError, undefined);

    store.roomAgentBindings.set(`${loopRoom.id}:dynamic-second-agent`, {
      roomId: loopRoom.id,
      participationMode: 'automatic',
    });
    const dynamicHuman = await sendHuman();
    const secondDynamicMessage = seedAgentMessages(2, 'dynamic-limit');
    assert.equal(secondDynamicMessage.sender.kind, 'agent');
    const dynamicLimit = await publish(dynamicHuman.id);
    assert.equal(dynamicLimit.body.result.isError, true);
    assert.equal(
      JSON.parse(dynamicLimit.body.result.content[0].text).error.code,
      'agent_loop_limit_reached',
    );

    for (let index = 0; index < 19; index += 1) {
      store.roomAgentBindings.set(`${loopRoom.id}:absolute-agent-${index}`, {
        roomId: loopRoom.id,
        participationMode: 'automatic',
      });
    }
    const absoluteHuman = await sendHuman();
    const twentiethMessage = seedAgentMessages(20, 'absolute-limit');
    assert.equal(twentiethMessage.sender.kind, 'agent');
    const absoluteLimit = await publish(absoluteHuman.id);
    assert.equal(absoluteLimit.body.result.isError, true);
    assert.equal(
      JSON.parse(absoluteLimit.body.result.content[0].text).error.code,
      'agent_loop_limit_reached',
    );

    const finalReset = await sendHuman();
    assert.equal((await publish(finalReset.id)).body.result.isError, undefined);
  });

  it('rejects malformed tool input, cursors, unknown tools, and ACL violations', async () => {
    const unknownField = await callTool('group_read_messages', {
      roomId: contextRoom.id,
      afterSeq: 0,
      limit: 2,
      extra: true,
    });
    assert.equal(unknownField.body.result.isError, true);

    const malformedCursor = await callTool('group_list_rooms', {
      limit: 1,
      cursor: 'not-a-valid-cursor',
    });
    assert.equal(malformedCursor.body.result.isError, true);
    assert.equal(
      JSON.parse(malformedCursor.body.result.content[0].text).error.code,
      'invalid_request',
    );

    const unknownTool = await callTool('group_does_not_exist', {});
    assert.equal(unknownTool.body.result.isError, true);
    assert.match(unknownTool.body.result.content[0].text, /not found/);

    const forbidden = await callTool('group_get_room_context', {
      roomId: contextRoom.id,
    }, { accessToken: users.charlie.accessToken });
    assert.equal(forbidden.body.result.isError, true);
    assert.equal(
      JSON.parse(forbidden.body.result.content[0].text).error.code,
      'forbidden',
    );
  });

  it('enforces authentication, Origin, Accept, and protocol version', async () => {
    const initialize = {
      jsonrpc: '2.0',
      id: 3,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'chuanhuatong-mcp-test', version: '1.0.0' },
      },
    };
    const missingAuth = await mcp(initialize, { accessToken: null });
    assert.equal(missingAuth.response.status, 401);
    assert.equal(missingAuth.body.error.code, 'authentication_required');

    const invalidAuth = await mcp(initialize, { accessToken: 'invalid-token' });
    assert.equal(invalidAuth.response.status, 401);
    assert.equal(invalidAuth.body.error.code, 'session_revoked');

    const invalidOrigin = await mcp(initialize, { origin: 'https://evil.example' });
    assert.equal(invalidOrigin.response.status, 403);
    assert.equal(invalidOrigin.body.error.code, 'invalid_origin');

    const allowedOrigin = await mcp(initialize, { origin: ALLOWED_ORIGIN });
    assert.equal(allowedOrigin.response.status, 200);

    const invalidAccept = await mcp(initialize, { accept: 'application/json' });
    assert.equal(invalidAccept.response.status, 406);

    const invalidVersion = await callTool('group_list_rooms', {}, {
      protocolVersion: '2099-01-01',
    });
    assert.equal(invalidVersion.response.status, 400);
  });

  it('returns 405 for authenticated GET and DELETE requests', async () => {
    for (const method of ['GET', 'DELETE']) {
      const result = await request('/mcp', {
        method,
        headers: {
          Authorization: `Bearer ${users.alice.accessToken}`,
          Accept: MCP_ACCEPT,
          'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
        },
      });
      assert.equal(result.response.status, 405);
      assert.equal(result.response.headers.get('allow'), 'POST');
      assert.equal(result.response.headers.get('mcp-session-id'), null);
    }
  });

  it('rate limits authenticated MCP POST requests', async () => {
    const limitedServer = createLocalServer({
      devAuthEnabled: true,
      logger: { warn() {}, error() {} },
      mcpRateLimitPerMinute: 1,
    });
    limitedServer.listen(0, '127.0.0.1');
    await once(limitedServer, 'listening');
    const limitedUrl = `http://127.0.0.1:${limitedServer.address().port}`;
    try {
      const sessionResponse = await fetch(`${limitedUrl}/__dev/guest-session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          deviceId: 'mcp-rate-limit-device',
          displayName: 'MCP Rate Limit User',
        }),
      });
      const session = await sessionResponse.json();
      const initialize = {
        jsonrpc: '2.0',
        id: 10,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'chuanhuatong-mcp-test', version: '1.0.0' },
        },
      };
      const headers = {
        Authorization: `Bearer ${session.accessToken}`,
        Accept: MCP_ACCEPT,
        'content-type': 'application/json',
      };
      const first = await fetch(`${limitedUrl}/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify(initialize),
      });
      const limited = await fetch(`${limitedUrl}/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...initialize, id: 11 }),
      });
      const limitedBody = await limited.json();

      assert.equal(first.status, 200);
      assert.equal(limited.status, 429);
      assert.equal(limitedBody.error.code, 'rate_limited');
      const retryAfter = Number(limited.headers.get('retry-after'));
      assert.ok(retryAfter >= 1 && retryAfter <= 60);
    } finally {
      await limitedServer.shutdown();
    }
  });

  it('rejects invalid MCP security configuration', () => {
    assert.throws(
      () => createLocalServer({ mcpAllowedOrigins: ['*'] }),
      /MCP_ALLOWED_ORIGINS contains an invalid origin/,
    );
    assert.throws(
      () => createLocalServer({ mcpRateLimitPerMinute: 0 }),
      /MCP_RATE_LIMIT_PER_MINUTE must be a positive integer/,
    );
  });
});
