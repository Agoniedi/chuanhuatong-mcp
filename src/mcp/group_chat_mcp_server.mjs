import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import { HttpError } from '../errors.mjs';

const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});
const WRITE_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});
const WAIT_MESSAGE_LIMIT = 200;
const WAIT_POLL_INTERVAL_MS = 250;
const MCP_RUNTIME_CAPABILITIES_VERSION = 1;

const idSchema = z.string().min(1).max(128);
const timestampSchema = z.string().min(20).max(30);
const nullableResourceIdSchema = z.string().min(1).max(128).nullable();

const roomSchema = z.object({
  id: idSchema,
  ownerUserId: idSchema,
  title: z.string().min(1).max(120),
  lastSeq: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
  historyVisibility: z.literal('after_join'),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();

const inviteSchema = z.object({
  id: idSchema,
  roomId: idSchema,
  createdByUserId: idSchema,
  expiresAt: timestampSchema,
  maxUses: z.number().int().min(1).max(100),
  remainingUses: z.number().int().min(0).max(100),
  createdAt: timestampSchema,
  inviteCode: z.string().min(22).max(256),
}).strict();

const memberSchema = z.object({
  userId: idSchema,
  role: z.enum(['owner', 'admin', 'member']),
  joinedSeq: z.number().int().nonnegative(),
  displayName: z.string().min(1).max(80),
  avatarResourceId: nullableResourceIdSchema,
}).strict();

const ownMembershipSchema = memberSchema.extend({
  readSeq: z.number().int().nonnegative(),
}).strict();

const agentProfileSchema = z.object({
  id: idSchema,
  ownerUserId: idSchema,
  displayName: z.string().min(1).max(80),
  avatarResourceId: nullableResourceIdSchema,
  shortBio: z.string().max(500),
  profileRevision: z.number().int().positive(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();

const publicAgentBindingSchema = z.object({
  bindingId: idSchema,
  roomId: idSchema,
  ownerUserId: idSchema,
  agentProfileId: idSchema,
  agentProfileRevision: z.number().int().positive(),
  participationMode: z.enum(['off', 'manual', 'automatic']),
  publishMode: z.enum(['reviewRequired', 'automatic']),
  triggerScope: z.enum(['mentionsOnly', 'allHumanMessages', 'allMessages']),
  policyRevision: z.number().int().positive(),
  updatedAt: timestampSchema,
}).strict();

const contextAgentBindingSchema = z.object({
  binding: publicAgentBindingSchema,
  agentProfile: agentProfileSchema,
}).strict();

const mentionSchema = z.object({
  kind: z.enum(['user', 'agent']),
  targetId: idSchema,
}).strict();
const mentionsSchema = z.array(mentionSchema).max(32).superRefine((mentions, context) => {
  const keys = new Set();
  for (const mention of mentions) {
    const key = `${mention.kind}:${mention.targetId}`;
    if (keys.has(key)) {
      context.addIssue({ code: 'custom', message: 'mentions must not contain duplicates' });
      return;
    }
    keys.add(key);
  }
});
const triggerMessageIdsSchema = z.array(idSchema).min(1).max(128).superRefine(
  (messageIds, context) => {
    if (new Set(messageIds).size !== messageIds.length) {
      context.addIssue({ code: 'custom', message: 'triggerMessageIds must be unique' });
    }
  },
);

const humanSenderSchema = z.object({
  kind: z.literal('human'),
  userId: idSchema,
  displayNameSnapshot: z.string().min(1).max(80),
  avatarResourceIdSnapshot: nullableResourceIdSchema,
}).strict();

const agentSenderSchema = z.object({
  kind: z.literal('agent'),
  userId: idSchema,
  agentProfileId: idSchema,
  displayNameSnapshot: z.string().min(1).max(80),
  avatarResourceIdSnapshot: nullableResourceIdSchema,
}).strict();

const messageSchema = z.object({
  id: idSchema,
  roomId: idSchema,
  seq: z.number().int().positive(),
  clientMessageId: idSchema,
  senderType: z.enum(['human', 'agent']),
  senderDisplayName: z.string().min(1).max(80),
  sender: z.union([humanSenderSchema, agentSenderSchema]),
  content: z.object({
    schemaVersion: z.literal(1),
    type: z.literal('text'),
    text: z.string().min(1).max(32768),
  }).strict(),
  mentions: z.array(mentionSchema),
  replyToMessageId: idSchema.nullable(),
  generationRequestId: idSchema.optional(),
  triggerThroughSeq: z.number().int().nonnegative().optional(),
  createdAt: timestampSchema,
}).strict();

const listRoomsOutputSchema = z.object({
  rooms: z.array(roomSchema),
  nextCursor: z.string().nullable(),
}).strict();

const joinRoomOutputSchema = z.object({
  room: roomSchema,
  membership: ownMembershipSchema,
}).strict();

const roomContextOutputSchema = z.object({
  room: roomSchema,
  members: z.array(memberSchema),
  agentBindings: z.array(contextAgentBindingSchema),
}).strict();

const readMessagesOutputSchema = z.object({
  messages: z.array(messageSchema),
  nextSeq: z.number().int().nonnegative(),
  highWaterSeq: z.number().int().nonnegative(),
  hasMore: z.boolean(),
}).strict();

const publishAgentReplyOutputSchema = z.object({
  generationRequestId: idSchema,
  triggerBatchId: idSchema,
  status: z.literal('published'),
  nextAction: z.literal('stop_current_turn'),
  message: messageSchema,
}).strict();

const publicProfileInputSchema = z.object({
  displayName: z.string().min(1).max(80).refine(
    (value) => value.trim().length > 0,
    'displayName must not be blank',
  ),
  avatarResourceId: nullableResourceIdSchema.default(null),
  shortBio: z.string().max(500).default(''),
}).strict();

const agentActivationOutputSchema = z.object({
  roomId: idSchema,
  bindingId: idSchema,
  agentProfileId: idSchema,
  profileRevision: z.number().int().positive(),
  policyRevision: z.number().int().positive(),
  deviceId: idSchema,
  leaseId: idSchema,
  leaseEpoch: z.number().int().positive(),
  leaseExpiresAt: timestampSchema,
}).strict();

const agentDeactivationOutputSchema = z.object({
  roomId: idSchema,
  bindingId: idSchema,
  deviceId: idSchema,
  leaseEpoch: z.number().int().positive(),
  status: z.literal('deactivated'),
}).strict();

function encodeRoomCursor(roomId) {
  return Buffer.from(JSON.stringify({ version: 1, roomId }), 'utf8').toString('base64url');
}

function decodeRoomCursor(cursor) {
  if (cursor === undefined) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('invalid base64url');
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== cursor) {
      throw new Error('non-canonical base64url');
    }
    const value = JSON.parse(decoded);
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'roomId,version' ||
      value.version !== 1 ||
      typeof value.roomId !== 'string' ||
      value.roomId.length < 1 ||
      value.roomId.length > 128
    ) {
      throw new Error('invalid cursor payload');
    }
    return value.roomId;
  } catch {
    throw new HttpError(400, 'invalid_request', 'cursor is not valid');
  }
}

function successResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
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

function toolFingerprint(name, args) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize({ name, args })))
    .digest('hex');
}

function toolHandler(action, logger) {
  return async (args, extra) => {
    try {
      return successResult(await action(args, extra));
    } catch (error) {
      if (
        !(error instanceof HttpError) &&
        !(extra.signal.aborted && error?.name === 'AbortError')
      ) {
        logger.error?.('[mcp] tool execution failed', error);
      }
      const isTerminalAgentLoopError = error instanceof HttpError &&
        error.code === 'agent_loop_limit_reached';
      const payload = {
        error: {
          code: error instanceof HttpError ? error.code : 'internal_error',
          message: error instanceof HttpError
            ? error.message
            : 'Unexpected server error',
          ...(isTerminalAgentLoopError
            ? { retryable: false, nextAction: 'stop_current_turn' }
            : {}),
        },
      };
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      };
    }
  };
}

function toMcpMessage(message) {
  return {
    senderType: message.sender.kind,
    senderDisplayName: message.sender.displayNameSnapshot,
    ...message,
  };
}

async function readMessagesPage({ store, userId, roomId, afterSeq, limit }) {
  const page = await store.listMessages({ userId, roomId, afterSeq, limit });
  if (afterSeq > page.highWaterSeq) {
    throw new HttpError(400, 'invalid_request', 'afterSeq is ahead of the room high-water mark');
  }
  return {
    messages: page.items.map(toMcpMessage),
    nextSeq: page.items.length === 0
      ? afterSeq
      : page.items[page.items.length - 1].seq,
    highWaterSeq: page.highWaterSeq,
    hasMore: page.hasMore,
  };
}

async function waitForMessages({ store, userId, roomId, afterSeq, timeoutMs, signal }) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const page = await readMessagesPage({
      store,
      userId,
      roomId,
      afterSeq,
      limit: WAIT_MESSAGE_LIMIT,
    });
    const remainingMs = deadline - Date.now();
    if (page.messages.length > 0 || remainingMs <= 0) return page;
    await delay(Math.min(WAIT_POLL_INTERVAL_MS, remainingMs), undefined, { signal });
  }
}

async function publishAutomaticAgentReply({ store, user, args }) {
  const requestFingerprint = toolFingerprint('group_publish_agent_reply', args);
  const created = await store.createAutomaticGenerationRequest({
    user,
    roomId: args.roomId,
    triggerBatchId: args.triggerBatchId,
    triggerMessageIds: args.triggerMessageIds,
    key: args.triggerBatchId,
    requestFingerprint,
    humanTriggersOnly: true,
  });
  let generationRequest = await store.getGenerationRequest({
    userId: user.userId,
    generationRequestId: created.body.id,
  });

  if (generationRequest.status === 'queued') {
    const claimed = await store.claimGenerationRequest({
      user,
      generationRequestId: generationRequest.id,
      expectedRequestVersion: generationRequest.requestVersion,
      key: args.triggerBatchId,
      requestFingerprint,
    });
    generationRequest = claimed.body;
  }
  if (generationRequest.status === 'claimed') {
    const started = await store.startGenerationRequest({
      user,
      generationRequestId: generationRequest.id,
      expectedRequestVersion: generationRequest.requestVersion,
      leaseId: generationRequest.leaseId,
      leaseEpoch: generationRequest.leaseEpoch,
      key: args.triggerBatchId,
      requestFingerprint,
    });
    generationRequest = started.body;
  }
  if (!['generating', 'published'].includes(generationRequest.status)) {
    throw new HttpError(
      409,
      'generation_state_conflict',
      `Generation request cannot be published from ${generationRequest.status}`,
    );
  }

  const published = await store.publishAutomaticGenerationRequest({
    user,
    generationRequestId: generationRequest.id,
    expectedRequestVersion: generationRequest.requestVersion,
    expectedBindingPolicyRevision: generationRequest.bindingPolicyRevision,
    clientMessageId: args.clientMessageId,
    text: args.text,
    mentions: args.mentions,
    replyToMessageId: args.replyToMessageId,
    leaseId: generationRequest.leaseId ?? null,
    leaseEpoch: generationRequest.leaseId ? generationRequest.leaseEpoch : null,
    key: args.triggerBatchId,
    requestFingerprint,
  });
  return {
    generationRequestId: published.body.generationRequest.id,
    triggerBatchId: args.triggerBatchId,
    status: 'published',
    nextAction: 'stop_current_turn',
    message: toMcpMessage(published.body.message),
  };
}

async function publishAgentReplyWithRuntimeRecovery({ store, user, args }) {
  if (args.publicProfile !== undefined) {
    try {
      await store.getMyRoomAgentBinding({ userId: user.userId, roomId: args.roomId });
    } catch (error) {
      if (!(error instanceof HttpError) || error.code !== 'resource_not_found') throw error;
      await store.activateMyAgent({
        user,
        roomId: args.roomId,
        publicProfile: args.publicProfile,
        runtimeCapabilitiesVersion: MCP_RUNTIME_CAPABILITIES_VERSION,
        localConfigRevision: 0,
      });
    }
  }
  try {
    return await publishAutomaticAgentReply({ store, user, args });
  } catch (error) {
    if (!(error instanceof HttpError) || error.code !== 'runtime_not_ready') throw error;
    await store.recoverMyAgentRuntime({ user, roomId: args.roomId });
    return publishAutomaticAgentReply({ store, user, args });
  }
}

export function createGroupChatMcpServer({
  store,
  user,
  logger = console,
  onMessageCreated = () => {},
}) {
  const server = new McpServer({
    name: 'chuanhuatong-mcp',
    version: '0.1.0',
  });

  server.registerTool('group_create_room', {
    description: 'Create a group-chat room owned by the authenticated identity.',
    inputSchema: z.object({
      clientRequestId: idSchema,
      title: z.string().min(1).max(120).refine(
        (value) => value.trim().length > 0,
        'title must not be blank',
      ),
    }).strict(),
    outputSchema: roomSchema,
    annotations: WRITE_ANNOTATIONS,
  }, toolHandler(async (args) => {
    const result = await store.createRoom({
      userId: user.userId,
      title: args.title,
      key: args.clientRequestId,
      requestFingerprint: toolFingerprint('group_create_room', args),
    });
    return result.body;
  }, logger));

  server.registerTool('group_create_invite', {
    description: 'Create a bounded invite code for a room owned or administered by the caller.',
    inputSchema: z.object({
      roomId: idSchema,
      clientRequestId: idSchema,
      expiresInSeconds: z.number().int().min(60).max(30 * 24 * 60 * 60),
      maxUses: z.number().int().min(1).max(100).default(1),
    }).strict(),
    outputSchema: inviteSchema,
    annotations: WRITE_ANNOTATIONS,
  }, toolHandler(async (args) => {
    const room = await store.getRoom({ userId: user.userId, roomId: args.roomId });
    const result = await store.createInvite({
      userId: user.userId,
      roomId: args.roomId,
      expectedRoomRevision: room.revision,
      expiresAt: new Date(Date.now() + args.expiresInSeconds * 1000).toISOString(),
      maxUses: args.maxUses,
      key: args.clientRequestId,
      requestFingerprint: toolFingerprint('group_create_invite', args),
    });
    const { inviteToken, ...invite } = result.body;
    return { ...invite, inviteCode: inviteToken };
  }, logger));

  server.registerTool('group_join_room', {
    description: 'Join a group-chat room using an active invite code.',
    inputSchema: z.object({
      clientRequestId: idSchema,
      inviteCode: z.string().min(22).max(256),
    }).strict(),
    outputSchema: joinRoomOutputSchema,
    annotations: WRITE_ANNOTATIONS,
  }, toolHandler(async (args) => {
    const result = await store.acceptInvite({
      userId: user.userId,
      inviteToken: args.inviteCode,
      key: args.clientRequestId,
      requestFingerprint: toolFingerprint('group_join_room', args),
    });
    return result.body;
  }, logger));

  server.registerTool('group_list_rooms', {
    description: 'List rooms visible to the authenticated group-chat identity.',
    inputSchema: z.object({
      limit: z.number().int().min(1).max(100).default(20),
      cursor: z.string().min(1).max(512).optional(),
    }).strict(),
    outputSchema: listRoomsOutputSchema,
    annotations: READ_ONLY_ANNOTATIONS,
  }, toolHandler(async ({ limit, cursor }) => {
    const page = await store.listRoomsPage({
      userId: user.userId,
      afterRoomId: decodeRoomCursor(cursor),
      limit,
    });
    return {
      rooms: page.items,
      nextCursor: page.nextRoomId === null
        ? null
        : encodeRoomCursor(page.nextRoomId),
    };
  }, logger));

  server.registerTool('group_get_room_context', {
    description: 'Get the public room, member, and agent profile context visible to the caller.',
    inputSchema: z.object({
      roomId: idSchema,
    }).strict(),
    outputSchema: roomContextOutputSchema,
    annotations: READ_ONLY_ANNOTATIONS,
  }, toolHandler(async ({ roomId }) => store.getRoomContext({
    userId: user.userId,
    roomId,
  }), logger));

  server.registerTool('group_read_messages', {
    description: 'Read one bounded page of visible room messages after a sequence cursor. senderType is the authoritative human-or-agent identity; never infer sender type from the display name. Use nextSeq in a later user-initiated turn. If messages is empty, stop the current assistant turn instead of polling again.',
    inputSchema: z.object({
      roomId: idSchema,
      afterSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      limit: z.number().int().min(1).max(200),
    }).strict(),
    outputSchema: readMessagesOutputSchema,
    annotations: READ_ONLY_ANNOTATIONS,
  }, toolHandler(async ({ roomId, afterSeq, limit }) => {
    return readMessagesPage({
      store,
      userId: user.userId,
      roomId,
      afterSeq,
      limit,
    });
  }, logger));

  server.registerTool('group_wait_for_messages', {
    description: 'Perform one bounded long-poll for visible room messages. senderType is the authoritative human-or-agent identity; never infer sender type from the display name. Call at most once per assistant turn. Standard MCP tool calls cannot monitor indefinitely: when messages is empty, stop the current assistant turn and do not call this tool again in the same turn.',
    inputSchema: z.object({
      roomId: idSchema,
      afterSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      timeoutMs: z.number().int().min(0).max(5000),
    }).strict(),
    outputSchema: readMessagesOutputSchema,
    annotations: READ_ONLY_ANNOTATIONS,
  }, toolHandler(async ({ roomId, afterSeq, timeoutMs }, extra) => waitForMessages({
    store,
    userId: user.userId,
    roomId,
    afterSeq,
    timeoutMs,
    signal: extra.signal,
  }), logger));

  server.registerTool('group_activate_agent', {
    description: 'Configure the authenticated user\'s public room-agent profile and perform initial activation. Use only for first-time setup or an explicit profile change. Do not call before each reply or to renew an expired lease; group_publish_agent_reply recovers this device\'s runtime automatically.',
    inputSchema: z.object({
      roomId: idSchema,
      publicProfile: publicProfileInputSchema,
      runtimeCapabilitiesVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      localConfigRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    }).strict(),
    outputSchema: agentActivationOutputSchema,
    annotations: WRITE_ANNOTATIONS,
  }, toolHandler(async (args) => store.activateMyAgent({
    user,
    roomId: args.roomId,
    publicProfile: args.publicProfile,
    runtimeCapabilitiesVersion: args.runtimeCapabilitiesVersion,
    localConfigRevision: args.localConfigRevision,
  }), logger));

  server.registerTool('group_heartbeat_agent', {
    description: 'Advanced lifecycle tool that explicitly renews the authenticated device\'s current room-agent lease. Normal MCP replies do not need it because group_publish_agent_reply recovers the runtime automatically.',
    inputSchema: z.object({
      roomId: idSchema,
      leaseId: idSchema,
      leaseEpoch: z.number().int().positive(),
    }).strict(),
    outputSchema: agentActivationOutputSchema,
    annotations: WRITE_ANNOTATIONS,
  }, toolHandler(async (args) => store.heartbeatMyAgent({
    user,
    roomId: args.roomId,
    leaseId: args.leaseId,
    leaseEpoch: args.leaseEpoch,
  }), logger));

  server.registerTool('group_deactivate_agent', {
    description: 'Deactivate the authenticated device\'s current room agent runtime lease.',
    inputSchema: z.object({
      roomId: idSchema,
      leaseId: idSchema,
      leaseEpoch: z.number().int().positive(),
    }).strict(),
    outputSchema: agentDeactivationOutputSchema,
    annotations: WRITE_ANNOTATIONS,
  }, toolHandler(async (args) => store.deactivateMyAgent({
    user,
    roomId: args.roomId,
    leaseId: args.leaseId,
    leaseEpoch: args.leaseEpoch,
  }), logger));

  server.registerTool('group_send_message', {
    description: 'Send one message as the authenticated human identity. Use only when the user explicitly asks to post on their own behalf. This does not send an agent reply; after success, stop the current assistant turn.',
    inputSchema: z.object({
      roomId: idSchema,
      clientMessageId: idSchema,
      text: z.string().min(1).max(32768),
      mentions: mentionsSchema.default([]),
      replyToMessageId: idSchema.nullable().default(null),
    }).strict(),
    outputSchema: messageSchema,
    annotations: WRITE_ANNOTATIONS,
  }, toolHandler(async (args) => {
    const result = await store.createHumanMessage({
      user,
      roomId: args.roomId,
      clientMessageId: args.clientMessageId,
      text: args.text,
      mentions: args.mentions,
      replyToMessageId: args.replyToMessageId,
      key: args.clientMessageId,
      requestFingerprint: toolFingerprint('group_send_message', args),
    });
    onMessageCreated();
    return toMcpMessage(result.body);
  }, logger));

  server.registerTool('group_publish_agent_reply', {
    description: 'Publish exactly one AI agent reply to eligible unseen human messages. The server allows at most one agent reply per human-message cycle: never retry with new IDs after success or agent_loop_limit_reached. For the first reply in a room, include publicProfile to configure and activate the agent in this same call; omit it after the binding exists, and reuse the exact value only for an idempotent retry after a lost response. This tool automatically recovers an existing room-agent runtime, so do not call group_activate_agent or group_heartbeat_agent before it. Use this, not group_send_message, when speaking as the AI agent. Never use an agent message as a trigger. After success, obey nextAction=stop_current_turn: stop the current assistant turn without reading or publishing again.',
    inputSchema: z.object({
      roomId: idSchema,
      triggerBatchId: idSchema,
      triggerMessageIds: triggerMessageIdsSchema,
      clientMessageId: idSchema,
      text: z.string().min(1).max(32768),
      publicProfile: publicProfileInputSchema.optional(),
      mentions: mentionsSchema.default([]),
      replyToMessageId: idSchema.nullable().default(null),
    }).strict(),
    outputSchema: publishAgentReplyOutputSchema,
    annotations: WRITE_ANNOTATIONS,
  }, toolHandler(async (args) => {
    const result = await publishAgentReplyWithRuntimeRecovery({ store, user, args });
    onMessageCreated();
    return result;
  }, logger));

  return server;
}
