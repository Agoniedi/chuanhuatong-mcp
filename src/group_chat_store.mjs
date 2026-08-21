import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';

import { HttpError } from './errors.mjs';
import { runMigrations } from './migrations.mjs';

const GENERATION_LEASE_DURATION_MS = 2 * 60 * 1000;
const AGENT_RUNTIME_LEASE_DURATION_MS = 60 * 1000;
const AGENT_MESSAGES_PER_CYCLE_LIMIT = 1;
const ABSOLUTE_CONSECUTIVE_AI_LIMIT = 20;
const PUBLIC_REGISTRATION_PRINCIPAL_ID = 'public-registration';
const ONE_TIME_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const WEB_BINDING_CODE_TTL_MS = 24 * 60 * 60 * 1000;
const WEB_RESET_CODE_TTL_MS = 30 * 60 * 1000;
const MESSAGE_RECALL_WINDOW_MS = 5 * 60 * 1000;
const WORLD_INVITE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const WORLD_INVITE_MAX_USES = 100;
const REGENERATABLE_GENERATION_STATUSES = new Set([
  'discarded',
  'failed',
  'cancelled',
  'expired',
]);

function newId(prefix) {
  return `${prefix}_${randomBytes(12).toString('base64url')}`;
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function newOneTimeCode() {
  const bytes = randomBytes(8);
  let value = '';
  for (const byte of bytes) value += ONE_TIME_CODE_ALPHABET[byte % ONE_TIME_CODE_ALPHABET.length];
  return `${value.slice(0, 4)}-${value.slice(4)}`;
}

function normalizeOneTimeCode(value) {
  return value.replaceAll('-', '').toUpperCase();
}

function handoffMessageId(key) {
  return `handoff_${hash(key)}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function safeInteger(value, label) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} is outside JavaScript's safe integer range`);
  }
  return parsed;
}

function publicUser(user) {
  return {
    userId: user.id,
    handle: user.handle,
    displayName: user.displayName,
    avatarResourceId: user.avatarResourceId,
    profileRevision: user.profileRevision,
  };
}

function authenticatedUser(user, deviceId = user.deviceId) {
  return { ...publicUser(user), deviceId };
}

function roomSnapshot(room, includeWorld = false) {
  return {
    id: room.id,
    ownerUserId: room.ownerUserId,
    title: room.title,
    lastSeq: room.lastSeq,
    revision: room.revision,
    historyVisibility: room.historyVisibility,
    ...(includeWorld ? {
      worldPublished: room.worldPublished ?? false,
      worldSummary: room.worldSummary ?? '',
    } : {}),
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
  };
}

function webRoomSnapshot(room) {
  return roomSnapshot(room, true);
}

function worldRoomSnapshot(room, ownerDisplayName, invite, includeInvite = true) {
  const snapshot = {
    id: room.id,
    title: room.title,
    ownerUserId: room.ownerUserId,
    ownerDisplayName,
    summary: room.worldSummary ?? '',
    publishedAt: room.worldPublishedAt ?? null,
  };
  if (includeInvite) {
    Object.assign(snapshot, {
      inviteToken: invite?.token ?? null,
      inviteExpiresAt: invite?.expiresAt ?? null,
      remainingUses: invite?.remainingUses ?? 0,
    });
  }
  return snapshot;
}

function membershipSnapshot(user, membership, includeReadSeq) {
  return {
    userId: membership.userId,
    role: membership.role,
    joinedSeq: membership.joinedSeq,
    ...(includeReadSeq ? { readSeq: membership.readSeq } : {}),
    displayName: user.displayName,
    avatarResourceId: user.avatarResourceId,
  };
}

function inviteSummary(invite) {
  return {
    id: invite.id,
    roomId: invite.roomId,
    createdByUserId: invite.createdByUserId,
    expiresAt: invite.expiresAt,
    maxUses: invite.maxUses,
    remainingUses: invite.remainingUses,
    createdAt: invite.createdAt,
  };
}

function assembleHandoffMessage({ contextSummary, decisions = [], openQuestions = [] }) {
  const sections = [`# 背景\n${contextSummary}`];
  if (decisions.length > 0) {
    sections.push(`# 已确认结论\n${decisions.map((item) => `- ${item}`).join('\n')}`);
  }
  if (openQuestions.length > 0) {
    sections.push(`# 待讨论事项\n${openQuestions.map((item) => `- ${item}`).join('\n')}`);
  }
  const text = sections.join('\n\n');
  if (text.length > 32768) {
    throw new HttpError(
      400,
      'invalid_request',
      'Assembled handoff context must be at most 32768 characters',
    );
  }
  return text;
}

function agentProfileSnapshot(profile) {
  return {
    id: profile.id,
    ownerUserId: profile.ownerUserId,
    displayName: profile.displayName,
    avatarResourceId: profile.avatarResourceId,
    shortBio: profile.shortBio,
    profileRevision: profile.profileRevision,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function roomAgentBindingSnapshot(binding) {
  return {
    bindingId: binding.id,
    roomId: binding.roomId,
    ownerUserId: binding.ownerUserId,
    agentProfileId: binding.agentProfileId,
    participationMode: binding.participationMode,
    publishMode: binding.publishMode,
    triggerScope: binding.triggerScope,
    preferredRuntimeDeviceId: binding.preferredRuntimeDeviceId,
    generationLimitPer24h: binding.generationLimitPer24h,
    policyRevision: binding.policyRevision,
    updatedAt: binding.updatedAt,
  };
}

function publicRoomAgentBindingSnapshot(binding, profile) {
  return {
    bindingId: binding.id,
    roomId: binding.roomId,
    ownerUserId: binding.ownerUserId,
    agentProfileId: binding.agentProfileId,
    agentProfileRevision: profile.profileRevision,
    displayName: profile.displayName,
    avatarResourceId: profile.avatarResourceId,
    participationMode: binding.participationMode,
    publishMode: binding.publishMode,
    triggerScope: binding.triggerScope,
    policyRevision: binding.policyRevision,
    updatedAt: binding.updatedAt,
  };
}

function agentRuntimeSnapshot(runtime) {
  return {
    bindingId: runtime.bindingId,
    deviceId: runtime.deviceId,
    readiness: runtime.readiness,
    readyForBindingPolicyRevision: runtime.readyForBindingPolicyRevision,
    runtimeCapabilitiesVersion: runtime.runtimeCapabilitiesVersion,
    localConfigRevision: runtime.localConfigRevision,
    updatedAt: runtime.updatedAt,
  };
}

function agentActivationSnapshot(binding, profile) {
  return {
    roomId: binding.roomId,
    bindingId: binding.id,
    agentProfileId: profile.id,
    profileRevision: profile.profileRevision,
    policyRevision: binding.policyRevision,
    deviceId: binding.runtimeLeaseDeviceId,
    leaseId: binding.runtimeLeaseId,
    leaseEpoch: binding.runtimeLeaseEpoch,
    leaseExpiresAt: binding.runtimeLeaseExpiresAt,
  };
}

function activeRuntimeLease(binding, now) {
  return Boolean(
    binding.runtimeLeaseDeviceId &&
    binding.runtimeLeaseId &&
    binding.runtimeLeaseExpiresAt &&
    Date.parse(binding.runtimeLeaseExpiresAt) > now.getTime()
  );
}

function acquireRuntimeLease(binding, user, now) {
  if (activeRuntimeLease(binding, now) && binding.runtimeLeaseDeviceId !== user.deviceId) {
    throw new HttpError(409, 'lease_conflict', 'Agent runtime lease is held by another device');
  }
  if (!activeRuntimeLease(binding, now)) {
    binding.runtimeLeaseDeviceId = user.deviceId;
    binding.runtimeLeaseId = newId('agent-lease');
    binding.runtimeLeaseEpoch += 1;
  }
  binding.preferredRuntimeDeviceId = user.deviceId;
  binding.runtimeLeaseExpiresAt = new Date(
    now.getTime() + AGENT_RUNTIME_LEASE_DURATION_MS,
  ).toISOString();
}

function requireRuntimeLease(binding, user, leaseId, leaseEpoch, now, { active = true } = {}) {
  if (
    binding.runtimeLeaseDeviceId !== user.deviceId ||
    binding.runtimeLeaseId !== leaseId ||
    binding.runtimeLeaseEpoch !== leaseEpoch ||
    (active && !activeRuntimeLease(binding, now))
  ) {
    throw new HttpError(409, 'lease_conflict', 'Agent runtime lease is not current');
  }
}

function requireEligibleAutomaticTriggers({
  triggerScope,
  agentProfileId,
  triggers,
  humanTriggersOnly = false,
}) {
  const ineligible = triggers.find((message) => {
    if (humanTriggersOnly && message.sender?.kind !== 'human') return true;
    if (triggerScope === 'allMessages') return false;
    if (message.sender?.kind !== 'human') return true;
    if (triggerScope === 'allHumanMessages') return false;
    return !message.mentions?.some(
      (mention) => mention.kind === 'agent' && mention.targetId === agentProfileId,
    );
  });
  if (ineligible) {
    throw new HttpError(
      409,
      'trigger_not_eligible',
      'Trigger message is not eligible for this agent policy; stop and wait for a new eligible human message',
    );
  }
}

function requireAgentLoopCapacity({
  messages,
  bindings,
  roomId,
  ownerUserId,
  triggerScope,
}) {
  let cycleStartIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].sender.kind === 'human') {
      cycleStartIndex = index;
      break;
    }
  }
  const cycleAgentMessages = messages.slice(cycleStartIndex + 1).filter(
    (message) => message.sender.kind === 'agent',
  );
  if (triggerScope === 'allMessages') {
    if (cycleAgentMessages.length >= ABSOLUTE_CONSECUTIVE_AI_LIMIT) {
      throw new HttpError(
        409,
        'agent_loop_limit_reached',
        'Room consecutive AI message limit reached; wait for a human message',
      );
    }
    return;
  }
  const ownerMessageCount = cycleAgentMessages.filter(
    (message) => message.sender.userId === ownerUserId,
  ).length;
  if (ownerMessageCount >= AGENT_MESSAGES_PER_CYCLE_LIMIT) {
    throw new HttpError(
      409,
      'agent_loop_limit_reached',
      'Agent reply already published for the current human cycle; stop the current assistant turn',
    );
  }
  const enabledAgentCount = [...bindings.values()].filter(
    (binding) =>
      binding.roomId === roomId && binding.participationMode === 'automatic',
  ).length;
  const roomLimit = Math.min(
    Math.max(enabledAgentCount, 1) * AGENT_MESSAGES_PER_CYCLE_LIMIT,
    ABSOLUTE_CONSECUTIVE_AI_LIMIT,
  );
  if (cycleAgentMessages.length >= roomLimit) {
    throw new HttpError(
      409,
      'agent_loop_limit_reached',
      'Room AI message limit reached for the current human cycle',
    );
  }
}

function generationRequestSnapshot(request) {
  return {
    id: request.id,
    roomId: request.roomId,
    bindingId: request.bindingId,
    ownerUserId: request.ownerUserId,
    source: request.source,
    ...(request.clientGenerationRequestId
      ? { clientGenerationRequestId: request.clientGenerationRequestId }
      : {}),
    ...(request.triggerBatchId ? { triggerBatchId: request.triggerBatchId } : {}),
    triggerMessageIds: clone(request.triggerMessageIds),
    triggerFromSeq: request.triggerFromSeq,
    triggerThroughSeq: request.triggerThroughSeq,
    contextThroughSeq: request.contextThroughSeq,
    minVisibleSeq: request.minVisibleSeq,
    historyPolicyRevision: request.historyPolicyRevision,
    bindingPolicyRevision: request.bindingPolicyRevision,
    status: request.status,
    requestVersion: request.requestVersion,
    ...(request.claimedDeviceId
      ? { claimedDeviceId: request.claimedDeviceId }
      : {}),
    ...(request.leaseId ? { leaseId: request.leaseId } : {}),
    leaseEpoch: request.leaseEpoch,
    ...(request.leaseExpiresAt
      ? { leaseExpiresAt: request.leaseExpiresAt }
      : {}),
    ...(request.draftDeviceId ? { draftDeviceId: request.draftDeviceId } : {}),
    attempt: request.attempt,
    ...(request.supersedesRequestId
      ? { supersedesRequestId: request.supersedesRequestId }
      : {}),
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
}

function activeInvite(invite, now) {
  return !invite.revokedAt && invite.remainingUses > 0 &&
    Date.parse(invite.expiresAt) > now.getTime();
}

function idempotencyConflict() {
  return new HttpError(
    409,
    'idempotency_conflict',
    'Idempotency key was reused with different input',
  );
}

function requireMembership(room, userId) {
  const membership = room.members.get(userId);
  if (!membership) throw new HttpError(403, 'forbidden', 'Room membership required');
  return membership;
}

function requireInviteManager(room, userId) {
  const membership = requireMembership(room, userId);
  if (membership.role !== 'owner' && membership.role !== 'admin') {
    throw new HttpError(403, 'forbidden', 'Owner or admin role required');
  }
  return membership;
}

function requireGenerationVersion(request, expectedRequestVersion) {
  if (request.requestVersion !== expectedRequestVersion) {
    throw new HttpError(
      409,
      'request_version_conflict',
      'Generation request version does not match',
    );
  }
}

function requireGenerationStatus(request, expectedStatus) {
  if (request.status !== expectedStatus) {
    throw new HttpError(
      409,
      'generation_state_conflict',
      `Generation request must be ${expectedStatus}`,
    );
  }
}

function requireGenerationLease(request, user, leaseId, leaseEpoch, now) {
  if (
    request.claimedDeviceId !== user.deviceId ||
    request.leaseId !== leaseId ||
    request.leaseEpoch !== leaseEpoch ||
    !request.leaseExpiresAt ||
    Date.parse(request.leaseExpiresAt) <= now.getTime()
  ) {
    throw new HttpError(409, 'lease_conflict', 'Generation lease is not current');
  }
}

export class MemoryGroupChatStore {
  constructor({ clock = () => new Date() } = {}) {
    this.clock = clock;
    this.usersByDeviceId = new Map();
    this.userDevices = new Set();
    this.deviceMetadata = new Map();
    this.userIdByNicknameKey = new Map();
    this.usersById = new Map();
    this.sessions = new Map();
    this.webAccountsByUserId = new Map();
    this.userIdByUsernameKey = new Map();
    this.webBindingCodes = new Map();
    this.webPasswordResetCodes = new Map();
    this.profileResources = new Map();
    this.webRoomReads = new Map();
    this.rooms = new Map();
    this.invites = new Map();
    this.messagesByRoom = new Map();
    this.agentProfiles = new Map();
    this.roomAgentBindings = new Map();
    this.agentRuntimes = new Map();
    this.generationRequests = new Map();
    this.idempotency = new Map();
    this.outbox = [];
    this.nextOutboxId = 1;
  }

  async health() {}

  async close() {}

  _replay(principalId, operation, key, requestFingerprint) {
    const recordKey = `${principalId}:${operation}:${key}`;
    const record = this.idempotency.get(recordKey);
    if (!record) return { recordKey };
    if (record.requestFingerprint !== requestFingerprint) throw idempotencyConflict();
    return { recordKey, response: clone(record.response) };
  }

  _saveReplay(recordKey, requestFingerprint, status, body) {
    this.idempotency.set(recordKey, {
      requestFingerprint,
      response: { status, body: body === undefined ? null : clone(body) },
    });
  }

  _room(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) throw new HttpError(404, 'resource_not_found', 'Room not found');
    return room;
  }

  _agentProfile(agentProfileId) {
    const profile = this.agentProfiles.get(agentProfileId);
    if (!profile) {
      throw new HttpError(404, 'resource_not_found', 'Agent profile not found');
    }
    return profile;
  }

  _bindingKey(roomId, ownerUserId) {
    return `${roomId}:${ownerUserId}`;
  }

  _bindingById(bindingId) {
    const binding = [...this.roomAgentBindings.values()].find(
      (candidate) => candidate.id === bindingId,
    );
    if (!binding) {
      throw new HttpError(409, 'request_version_conflict', 'Agent binding is no longer current');
    }
    return binding;
  }

  _runtimeKey(bindingId, deviceId) {
    return `${bindingId}:${deviceId}`;
  }

  _generationRequest(generationRequestId) {
    const request = this.generationRequests.get(generationRequestId);
    if (!request) {
      throw new HttpError(404, 'resource_not_found', 'Generation request not found');
    }
    return request;
  }

  _rememberDevice(userId, deviceId, kind, label) {
    this.userDevices.add(`${userId}:${deviceId}`);
    this.deviceMetadata.set(`${userId}:${deviceId}`, { userId, deviceId, kind, label });
  }

  _createSession(user, { deviceId, kind, label, prefix }) {
    this._rememberDevice(user.id, deviceId, kind, label);
    const token = `${prefix}_${randomBytes(24).toString('base64url')}`;
    this.sessions.set(hash(token), { userId: user.id, deviceId });
    return token;
  }

  _enqueueProfileUpdated(profileType, ownerUserId, profile) {
    this.outbox.push({
      id: String(this.nextOutboxId++),
      eventId: newId('evt'),
      type: 'profile.updated',
      payload: { profileType, ownerUserId, profile: clone(profile) },
      occurredAt: this.clock().toISOString(),
      dispatchedAt: null,
    });
  }

  _issueWebBindingCode(userId) {
    for (const [codeHash, entry] of this.webBindingCodes) {
      if (entry.userId === userId) this.webBindingCodes.delete(codeHash);
    }
    const code = newOneTimeCode();
    const expiresAt = new Date(this.clock().getTime() + WEB_BINDING_CODE_TTL_MS).toISOString();
    this.webBindingCodes.set(hash(normalizeOneTimeCode(code)), { userId, expiresAt });
    return { bindingCode: code, expiresAt };
  }

  _issueWebPasswordResetCode(userId) {
    if (!this.webAccountsByUserId.has(userId)) {
      throw new HttpError(409, 'web_account_required', 'Web account is not configured');
    }
    for (const [codeHash, entry] of this.webPasswordResetCodes) {
      if (entry.userId === userId) this.webPasswordResetCodes.delete(codeHash);
    }
    const code = newOneTimeCode();
    const expiresAt = new Date(this.clock().getTime() + WEB_RESET_CODE_TTL_MS).toISOString();
    this.webPasswordResetCodes.set(hash(normalizeOneTimeCode(code)), { userId, expiresAt });
    return { resetCode: code, expiresAt };
  }

  _requireReadyRuntime(binding, user) {
    const runtime = this.agentRuntimes.get(this._runtimeKey(binding.id, user.deviceId));
    if (
      !runtime ||
      runtime.readiness !== 'ready' ||
      runtime.readyForBindingPolicyRevision !== binding.policyRevision ||
      binding.preferredRuntimeDeviceId !== user.deviceId ||
      binding.runtimeLeaseDeviceId !== user.deviceId ||
      !activeRuntimeLease(binding, this.clock())
    ) {
      throw new HttpError(409, 'runtime_not_ready', 'Agent runtime is not ready');
    }
    return runtime;
  }

  _requireGenerationContext(request, user, { ready = false } = {}) {
    if (request.ownerUserId !== user.userId) {
      throw new HttpError(403, 'forbidden', 'Generation request owner required');
    }
    const room = this._room(request.roomId);
    const membership = requireMembership(room, user.userId);
    const binding = this._bindingById(request.bindingId);
    if (
      binding.roomId !== request.roomId ||
      binding.ownerUserId !== user.userId ||
      binding.participationMode === 'off'
    ) {
      throw new HttpError(409, 'generation_state_conflict', 'Agent binding is disabled');
    }
    if (binding.policyRevision !== request.bindingPolicyRevision) {
      throw new HttpError(409, 'request_version_conflict', 'Binding policy has changed');
    }
    if (ready) this._requireReadyRuntime(binding, user);
    return { room, membership, binding };
  }

  async createGuestSession({ deviceId, displayName }) {
    const nicknameKey = displayName.normalize('NFKC').toLowerCase();
    const existing = this.usersByDeviceId.get(deviceId);
    let user = existing;
    if (user) {
      if (user.displayName !== displayName) {
        this.userIdByNicknameKey.delete(user.nicknameKey);
        user.displayName = displayName;
        user.nicknameKey = nicknameKey;
        user.profileRevision += 1;
      }
    } else {
      user = {
        id: newId('usr'),
        deviceId,
        handle: `guest_${hash(deviceId).slice(0, 12)}`,
        displayName,
        nicknameKey,
        avatarResourceId: null,
        profileRevision: 1,
      };
      this.usersByDeviceId.set(deviceId, user);
      this.usersById.set(user.id, user);
    }
    this._rememberDevice(user.id, deviceId, 'legacy', 'Development session');
    this.userIdByNicknameKey.set(nicknameKey, user.id);
    const accessToken = `dev_${randomBytes(24).toString('base64url')}`;
    this.sessions.set(hash(accessToken), { userId: user.id, deviceId });
    return { accessToken, tokenType: 'Bearer', user: publicUser(user) };
  }

  async createUserRegistration({ displayName, key, requestFingerprint }) {
    const replay = this._replay(
      PUBLIC_REGISTRATION_PRINCIPAL_ID,
      'createUserRegistration',
      key,
      requestFingerprint,
    );
    if (replay.response) {
      const user = this.usersById.get(replay.response.body.userId);
      const accessToken = `ct_${randomBytes(24).toString('base64url')}`;
      this.sessions.set(hash(accessToken), { userId: user.id, deviceId: user.deviceId });
      return { token: accessToken, ...clone(replay.response.body) };
    }
    const deviceId = `web_${randomBytes(12).toString('base64url')}`;
    const nicknameKey = displayName.normalize('NFKC').toLowerCase();
    const user = {
      id: newId('usr'),
      deviceId,
      handle: `guest_${hash(deviceId).slice(0, 12)}`,
      displayName,
      nicknameKey,
      avatarResourceId: null,
      profileRevision: 1,
    };
    this.usersByDeviceId.set(deviceId, user);
    this.usersById.set(user.id, user);
    this._rememberDevice(user.id, deviceId, 'web', 'Legacy web session');
    this.userIdByNicknameKey.set(nicknameKey, user.id);
    const accessToken = `ct_${randomBytes(24).toString('base64url')}`;
    this.sessions.set(hash(accessToken), { userId: user.id, deviceId });
    const body = {
      userId: user.id,
      displayName: user.displayName,
      handle: user.handle,
    };
    this._saveReplay(replay.recordKey, requestFingerprint, 201, body);
    return { token: accessToken, ...body };
  }

  async createMcpRegistration({ displayName, deviceLabel, key, requestFingerprint }) {
    const replay = this._replay(
      PUBLIC_REGISTRATION_PRINCIPAL_ID,
      'createMcpRegistration',
      key,
      requestFingerprint,
    );
    let user;
    if (replay.response) {
      user = this.usersById.get(replay.response.body.userId);
    } else {
      const deviceId = `mcp_${randomBytes(12).toString('base64url')}`;
      const nicknameKey = displayName.normalize('NFKC').toLowerCase();
      user = {
        id: newId('usr'),
        deviceId,
        handle: `guest_${hash(deviceId).slice(0, 12)}`,
        displayName,
        nicknameKey,
        avatarResourceId: null,
        profileRevision: 1,
      };
      this.usersByDeviceId.set(deviceId, user);
      this.usersById.set(user.id, user);
      this._saveReplay(replay.recordKey, requestFingerprint, 201, {
        userId: user.id,
        displayName: user.displayName,
        handle: user.handle,
      });
    }
    const deviceId = replay.response
      ? `mcp_${randomBytes(12).toString('base64url')}`
      : user.deviceId;
    const token = this._createSession(user, {
      deviceId,
      kind: 'mcp',
      label: deviceLabel,
      prefix: 'ct',
    });
    return {
      token,
      ...publicUser(user),
      ...this._issueWebBindingCode(user.id),
    };
  }

  async issueWebBindingCode({ userId }) {
    if (!this.usersById.has(userId)) {
      throw new HttpError(404, 'resource_not_found', 'User not found');
    }
    return this._issueWebBindingCode(userId);
  }

  async registerWebAccount({ username, usernameKey, displayName, passwordSalt, passwordHash, bindingCode }) {
    if (this.userIdByUsernameKey.has(usernameKey)) {
      throw new HttpError(409, 'username_conflict', 'Username is already in use');
    }
    const codeHash = hash(normalizeOneTimeCode(bindingCode));
    const code = this.webBindingCodes.get(codeHash);
    if (!code || Date.parse(code.expiresAt) <= this.clock().getTime()) {
      throw new HttpError(400, 'invalid_binding_code', 'Binding code is invalid or expired');
    }
    if (this.webAccountsByUserId.has(code.userId)) {
      throw new HttpError(409, 'web_account_exists', 'Web account is already configured');
    }
    const user = this.usersById.get(code.userId);
    user.handle = username;
    user.displayName = displayName;
    user.nicknameKey = displayName.normalize('NFKC').toLowerCase();
    user.profileRevision += 1;
    const now = this.clock().toISOString();
    this.webAccountsByUserId.set(user.id, {
      userId: user.id,
      username,
      usernameKey,
      passwordSalt,
      passwordHash,
      createdAt: now,
      updatedAt: now,
    });
    this.userIdByUsernameKey.set(usernameKey, user.id);
    this.webBindingCodes.delete(codeHash);
    return this.createWebSession({ userId: user.id, label: 'Web browser' });
  }

  async upgradeWebAccount({ userId, username, usernameKey, passwordSalt, passwordHash }) {
    if (this.webAccountsByUserId.has(userId)) {
      throw new HttpError(409, 'web_account_exists', 'Web account is already configured');
    }
    if (this.userIdByUsernameKey.has(usernameKey)) {
      throw new HttpError(409, 'username_conflict', 'Username is already in use');
    }
    const user = this.usersById.get(userId);
    const now = this.clock().toISOString();
    user.handle = username;
    user.profileRevision += 1;
    this.webAccountsByUserId.set(userId, {
      userId,
      username,
      usernameKey,
      passwordSalt,
      passwordHash,
      createdAt: now,
      updatedAt: now,
    });
    this.userIdByUsernameKey.set(usernameKey, userId);
    return this.createWebSession({ userId, label: 'Web browser' });
  }

  async getWebLoginCredentials({ usernameKey }) {
    const userId = this.userIdByUsernameKey.get(usernameKey);
    const account = userId ? this.webAccountsByUserId.get(userId) : null;
    if (!account) throw new HttpError(401, 'invalid_credentials', 'Username or password is incorrect');
    return clone(account);
  }

  async getWebLoginCredentialsByUserId({ userId }) {
    const account = this.webAccountsByUserId.get(userId);
    if (!account) {
      throw new HttpError(409, 'web_account_required', 'Web account is not configured');
    }
    return clone(account);
  }

  async changeWebPassword({ userId, currentDeviceId, passwordSalt, passwordHash }) {
    const account = this.webAccountsByUserId.get(userId);
    if (!account) {
      throw new HttpError(409, 'web_account_required', 'Web account is not configured');
    }
    account.passwordSalt = passwordSalt;
    account.passwordHash = passwordHash;
    account.updatedAt = this.clock().toISOString();
    for (const [tokenHash, session] of this.sessions) {
      const device = this.deviceMetadata.get(`${userId}:${session.deviceId}`);
      if (
        session.userId === userId &&
        device?.kind === 'web' &&
        session.deviceId !== currentDeviceId
      ) {
        this.sessions.delete(tokenHash);
      }
    }
  }

  async createWebSession({ userId, label }) {
    const user = this.usersById.get(userId);
    const deviceId = `web_${randomBytes(12).toString('base64url')}`;
    const token = this._createSession(user, { deviceId, kind: 'web', label, prefix: 'web' });
    return { token, user: publicUser(user) };
  }

  async createMcpDeviceSession({ userId, label }) {
    const user = this.usersById.get(userId);
    const deviceId = `mcp_${randomBytes(12).toString('base64url')}`;
    const token = this._createSession(user, { deviceId, kind: 'mcp', label, prefix: 'ct' });
    return { token, deviceId, label };
  }

  async listDevices({ userId }) {
    const activeDeviceIds = new Set(
      [...this.sessions.values()]
        .filter((session) => session.userId === userId)
        .map((session) => session.deviceId),
    );
    return [...this.deviceMetadata.values()]
      .filter((device) => device.userId === userId)
      .map((device) => ({ ...device, active: activeDeviceIds.has(device.deviceId) }));
  }

  async revokeDevice({ userId, deviceId }) {
    for (const [tokenHash, session] of this.sessions) {
      if (session.userId === userId && session.deviceId === deviceId) {
        this.sessions.delete(tokenHash);
      }
    }
  }

  async issueWebPasswordResetCode({ userId }) {
    return this._issueWebPasswordResetCode(userId);
  }

  async resetWebPassword({ usernameKey, resetCode, passwordSalt, passwordHash }) {
    const userId = this.userIdByUsernameKey.get(usernameKey);
    const account = userId ? this.webAccountsByUserId.get(userId) : null;
    const codeHash = hash(normalizeOneTimeCode(resetCode));
    const code = this.webPasswordResetCodes.get(codeHash);
    if (!account || !code || code.userId !== userId || Date.parse(code.expiresAt) <= this.clock().getTime()) {
      throw new HttpError(400, 'invalid_reset_code', 'Reset code is invalid or expired');
    }
    account.passwordSalt = passwordSalt;
    account.passwordHash = passwordHash;
    account.updatedAt = this.clock().toISOString();
    this.webPasswordResetCodes.delete(codeHash);
    for (const [tokenHash, session] of this.sessions) {
      const device = this.deviceMetadata.get(`${userId}:${session.deviceId}`);
      if (session.userId === userId && device?.kind === 'web') this.sessions.delete(tokenHash);
    }
  }

  _requireOwnedAvatar(userId, avatarResourceId) {
    if (avatarResourceId === null) return;
    const resource = this.profileResources.get(avatarResourceId);
    if (!resource || resource.ownerUserId !== userId) {
      throw new HttpError(403, 'forbidden', 'Avatar resource owner required');
    }
  }

  async createProfileResource({ userId, mimeType, content }) {
    const resource = {
      id: newId('resource'),
      ownerUserId: userId,
      mimeType,
      content: Buffer.from(content),
      byteSize: content.length,
      createdAt: this.clock().toISOString(),
    };
    this.profileResources.set(resource.id, resource);
    return {
      id: resource.id,
      mimeType: resource.mimeType,
      byteSize: resource.byteSize,
      createdAt: resource.createdAt,
    };
  }

  async getProfileResource({ resourceId }) {
    const resource = this.profileResources.get(resourceId);
    if (!resource) {
      throw new HttpError(404, 'resource_not_found', 'Profile resource not found');
    }
    return { ...resource, content: Buffer.from(resource.content) };
  }

  async getMe({ userId }) {
    const user = this.usersById.get(userId);
    if (!user) throw new HttpError(404, 'resource_not_found', 'User not found');
    return publicUser(user);
  }

  async authenticate(accessToken) {
    const session = this.sessions.get(hash(accessToken));
    const user = session ? this.usersById.get(session.userId) : null;
    if (!user) throw new HttpError(401, 'session_revoked', 'Session is not valid');
    return authenticatedUser(user, session.deviceId);
  }

  async isSessionActive({ userId, deviceId }) {
    return [...this.sessions.values()].some(
      (session) => session.userId === userId && session.deviceId === deviceId,
    );
  }

  async updateMyProfile({
    userId,
    expectedProfileRevision,
    displayName,
    avatarResourceId,
    key,
    requestFingerprint,
  }) {
    const user = this.usersById.get(userId);
    const replay = this._replay(userId, 'updateMyProfile', key, requestFingerprint);
    if (replay.response) return replay.response;
    if (expectedProfileRevision !== user.profileRevision) {
      throw new HttpError(409, 'request_version_conflict', 'Profile revision does not match');
    }
    if (avatarResourceId !== undefined) {
      this._requireOwnedAvatar(userId, avatarResourceId);
    }
    if (displayName !== undefined) {
      const nicknameKey = displayName.normalize('NFKC').toLowerCase();
      this.userIdByNicknameKey.delete(user.nicknameKey);
      user.displayName = displayName;
      user.nicknameKey = nicknameKey;
      this.userIdByNicknameKey.set(nicknameKey, userId);
    }
    if (avatarResourceId !== undefined) user.avatarResourceId = avatarResourceId;
    user.profileRevision += 1;
    const body = publicUser(user);
    this._saveReplay(replay.recordKey, requestFingerprint, 200, body);
    this._enqueueProfileUpdated('human', userId, body);
    return { status: 200, body };
  }

  async listRooms(userId) {
    return [...this.rooms.values()]
      .filter((room) => room.members.has(userId))
      .map((room) => {
        const membership = room.members.get(userId);
        const defaultReadSeq = Math.max(0, membership.joinedSeq - 1);
        const webReadSeq = this.webRoomReads.get(`${userId}:${room.id}`) ?? defaultReadSeq;
        return {
          ...webRoomSnapshot(room),
          webReadSeq,
          unreadCount: Math.max(0, room.lastSeq - webReadSeq),
        };
      });
  }

  async updateWebRoomRead({ userId, roomId, readSeq }) {
    const room = this._room(roomId);
    const membership = requireMembership(room, userId);
    const minimum = Math.max(0, membership.joinedSeq - 1);
    if (readSeq < minimum || readSeq > room.lastSeq) {
      throw new HttpError(400, 'invalid_request', 'readSeq is outside visible room history');
    }
    const key = `${userId}:${roomId}`;
    const current = this.webRoomReads.get(key) ?? minimum;
    const webReadSeq = Math.max(current, readSeq);
    this.webRoomReads.set(key, webReadSeq);
    return { roomId, webReadSeq };
  }

  async listRoomsPage({ userId, afterRoomId, limit }) {
    const page = [...this.rooms.values()]
      .filter((room) => room.members.has(userId))
      .filter((room) => afterRoomId === null || room.id > afterRoomId)
      .sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
      .slice(0, limit + 1);
    const items = page.slice(0, limit).map((room) => roomSnapshot(room));
    return {
      items,
      nextRoomId: page.length > limit ? items[items.length - 1].id : null,
    };
  }

  async createAgentProfile({
    userId,
    displayName,
    avatarResourceId,
    shortBio,
    key,
    requestFingerprint,
  }) {
    this._requireOwnedAvatar(userId, avatarResourceId);
    const replay = this._replay(userId, 'createAgentProfile', key, requestFingerprint);
    if (replay.response) return replay.response;
    const createdAt = this.clock().toISOString();
    const profile = {
      id: newId('agent'),
      ownerUserId: userId,
      displayName,
      avatarResourceId,
      shortBio,
      profileRevision: 1,
      createdAt,
      updatedAt: createdAt,
    };
    this.agentProfiles.set(profile.id, profile);
    const body = agentProfileSnapshot(profile);
    this._saveReplay(replay.recordKey, requestFingerprint, 201, body);
    return { status: 201, body };
  }

  async listAgentProfiles({ userId }) {
    return [...this.agentProfiles.values()]
      .filter((profile) => profile.ownerUserId === userId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(agentProfileSnapshot);
  }

  async getAgentProfile({ agentProfileId }) {
    return agentProfileSnapshot(this._agentProfile(agentProfileId));
  }

  async updateAgentProfile({
    userId,
    agentProfileId,
    expectedProfileRevision,
    changes,
    key,
    requestFingerprint,
  }) {
    const profile = this._agentProfile(agentProfileId);
    if (profile.ownerUserId !== userId) {
      throw new HttpError(403, 'forbidden', 'Agent profile owner required');
    }
    const replay = this._replay(userId, 'updateAgentProfile', key, requestFingerprint);
    if (replay.response) return replay.response;
    if (expectedProfileRevision !== profile.profileRevision) {
      throw new HttpError(409, 'request_version_conflict', 'Profile revision does not match');
    }
    if (Object.hasOwn(changes, 'avatarResourceId')) {
      this._requireOwnedAvatar(userId, changes.avatarResourceId);
    }
    if (Object.hasOwn(changes, 'displayName')) profile.displayName = changes.displayName;
    if (Object.hasOwn(changes, 'avatarResourceId')) {
      profile.avatarResourceId = changes.avatarResourceId;
    }
    if (Object.hasOwn(changes, 'shortBio')) profile.shortBio = changes.shortBio;
    profile.profileRevision += 1;
    profile.updatedAt = this.clock().toISOString();
    const body = agentProfileSnapshot(profile);
    this._saveReplay(replay.recordKey, requestFingerprint, 200, body);
    this._enqueueProfileUpdated('agent', userId, body);
    return { status: 200, body };
  }

  async deleteAgentProfile({ userId, agentProfileId }) {
    const profile = this._agentProfile(agentProfileId);
    if (profile.ownerUserId !== userId) {
      throw new HttpError(403, 'forbidden', 'Agent profile owner required');
    }
    for (const [bindingKey, binding] of this.roomAgentBindings) {
      if (binding.agentProfileId === agentProfileId) this.roomAgentBindings.delete(bindingKey);
    }
    this.agentProfiles.delete(agentProfileId);
    return { status: 204 };
  }

  async createRoom({ userId, title, key, requestFingerprint }) {
    const replay = this._replay(userId, 'createRoom', key, requestFingerprint);
    if (replay.response) return replay.response;
    const createdAt = this.clock().toISOString();
    const room = {
      id: newId('room'),
      ownerUserId: userId,
      title,
      lastSeq: 0,
      revision: 1,
      historyVisibility: 'after_join',
      worldPublished: false,
      worldSummary: '',
      worldInviteId: null,
      worldInviteToken: null,
      worldPublishedAt: null,
      createdAt,
      updatedAt: createdAt,
      members: new Map([[userId, { userId, role: 'owner', joinedSeq: 0, readSeq: 0 }]]),
    };
    this.rooms.set(room.id, room);
    this.messagesByRoom.set(room.id, []);
    const body = roomSnapshot(room);
    this._saveReplay(replay.recordKey, requestFingerprint, 201, body);
    return { status: 201, body };
  }

  async getRoom({ userId, roomId }) {
    const room = this._room(roomId);
    requireMembership(room, userId);
    return roomSnapshot(room);
  }

  async listWorldRooms() {
    const now = this.clock();
    return [...this.rooms.values()]
      .filter((room) => room.worldPublished)
      .map((room) => {
        const invite = room.worldInviteId ? this.invites.get(room.worldInviteId) : null;
        if (!invite || !activeInvite(invite, now)) return null;
        return worldRoomSnapshot(
          room,
          this.usersById.get(room.ownerUserId)?.displayName ?? '未知房主',
          { ...invite, token: room.worldInviteToken },
          false,
        );
      })
      .filter(Boolean)
      .sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt));
  }

  async getWorldRoom({ roomId }) {
    const room = this._room(roomId);
    const invite = room.worldInviteId ? this.invites.get(room.worldInviteId) : null;
    if (!room.worldPublished || !invite || !activeInvite(invite, this.clock())) {
      throw new HttpError(404, 'resource_not_found', 'World room not found');
    }
    return worldRoomSnapshot(
      room,
      this.usersById.get(room.ownerUserId)?.displayName ?? '未知房主',
      { ...invite, token: room.worldInviteToken },
    );
  }

  async updateWorldRoom({ userId, roomId, published, summary }) {
    const room = this._room(roomId);
    if (room.ownerUserId !== userId) {
      throw new HttpError(403, 'forbidden', 'Room owner required');
    }
    const now = this.clock();
    if (!published) {
      const invite = room.worldInviteId ? this.invites.get(room.worldInviteId) : null;
      if (invite) invite.revokedAt = now.toISOString();
      room.worldPublished = false;
      room.worldInviteId = null;
      room.worldInviteToken = null;
      room.worldPublishedAt = null;
      room.revision += 1;
      room.updatedAt = now.toISOString();
      return { room: webRoomSnapshot(room), world: null };
    }

    let invite = room.worldInviteId ? this.invites.get(room.worldInviteId) : null;
    let token = room.worldInviteToken;
    if (!invite || !activeInvite(invite, now) || !token) {
      token = randomBytes(16).toString('base64url');
      invite = {
        id: newId('invite'),
        roomId,
        createdByUserId: userId,
        tokenHash: hash(token),
        expiresAt: new Date(now.getTime() + WORLD_INVITE_LIFETIME_MS).toISOString(),
        maxUses: WORLD_INVITE_MAX_USES,
        remainingUses: WORLD_INVITE_MAX_USES,
        createdAt: now.toISOString(),
        revokedAt: null,
      };
      this.invites.set(invite.id, invite);
      room.worldInviteId = invite.id;
      room.worldInviteToken = token;
    }
    room.worldPublished = true;
    room.worldSummary = summary;
    room.worldPublishedAt ??= now.toISOString();
    room.revision += 1;
    room.updatedAt = now.toISOString();
    return {
      room: webRoomSnapshot(room),
      world: worldRoomSnapshot(room, this.usersById.get(userId)?.displayName ?? '未知房主', {
        ...invite,
        token,
      }),
    };
  }

  async deleteRoom({ userId, roomId }) {
    const room = this._room(roomId);
    if (room.ownerUserId !== userId) {
      throw new HttpError(403, 'forbidden', 'Room owner required');
    }
    const recipientUserIds = [...room.members.keys()];
    const bindingIds = new Set(
      [...this.roomAgentBindings.values()]
        .filter((binding) => binding.roomId === roomId)
        .map((binding) => binding.id),
    );
    this.rooms.delete(roomId);
    this.messagesByRoom.delete(roomId);
    for (const [inviteId, invite] of this.invites) {
      if (invite.roomId === roomId) this.invites.delete(inviteId);
    }
    for (const [bindingKey, binding] of this.roomAgentBindings) {
      if (binding.roomId === roomId) this.roomAgentBindings.delete(bindingKey);
    }
    for (const [runtimeKey, runtime] of this.agentRuntimes) {
      if (bindingIds.has(runtime.bindingId)) this.agentRuntimes.delete(runtimeKey);
    }
    for (const [requestId, request] of this.generationRequests) {
      if (request.roomId === roomId) this.generationRequests.delete(requestId);
    }
    for (const readKey of this.webRoomReads.keys()) {
      if (readKey.endsWith(`:${roomId}`)) this.webRoomReads.delete(readKey);
    }
    this.outbox = this.outbox.filter(
      (entry) => entry.roomId !== roomId || entry.dispatchedAt !== null,
    );
    this.outbox.push({
      id: String(this.nextOutboxId++),
      eventId: newId('evt'),
      type: 'room.deleted',
      roomId,
      payload: { recipientUserIds },
      occurredAt: this.clock().toISOString(),
      dispatchedAt: null,
    });
  }

  async getMembership({ userId, roomId }) {
    const room = this._room(roomId);
    const membership = requireMembership(room, userId);
    return membershipSnapshot(this.usersById.get(userId), membership, true);
  }

  async listMembers({ userId, roomId }) {
    const room = this._room(roomId);
    requireMembership(room, userId);
    return {
      items: [...room.members.values()].map((membership) =>
        membershipSnapshot(this.usersById.get(membership.userId), membership, false)),
      roomRevision: room.revision,
    };
  }

  async getRoomContext({ userId, roomId }) {
    const room = this._room(roomId);
    requireMembership(room, userId);
    return {
      room: roomSnapshot(room),
      members: [...room.members.values()].map((membership) =>
        membershipSnapshot(this.usersById.get(membership.userId), membership, false)),
      agentBindings: [...this.roomAgentBindings.values()]
        .filter((binding) => binding.roomId === roomId)
        .sort((left, right) => left.ownerUserId.localeCompare(right.ownerUserId))
        .map((binding) => {
          const profile = this._agentProfile(binding.agentProfileId);
          return {
            binding: publicRoomAgentBindingSnapshot(binding, profile),
            agentProfile: agentProfileSnapshot(profile),
          };
        }),
    };
  }

  async getMyRoomAgentBinding({ userId, roomId }) {
    const room = this._room(roomId);
    requireMembership(room, userId);
    const binding = this.roomAgentBindings.get(this._bindingKey(roomId, userId));
    if (!binding) {
      throw new HttpError(404, 'resource_not_found', 'Room agent binding not found');
    }
    return roomAgentBindingSnapshot(binding);
  }

  async listRoomAgentBindings({ userId, roomId }) {
    const room = this._room(roomId);
    requireMembership(room, userId);
    return {
      items: [...this.roomAgentBindings.values()]
        .filter((binding) => binding.roomId === roomId)
        .sort((left, right) => left.ownerUserId.localeCompare(right.ownerUserId))
        .map((binding) => publicRoomAgentBindingSnapshot(
          binding,
          this._agentProfile(binding.agentProfileId),
        )),
    };
  }

  async putMyRoomAgentBinding({
    userId,
    roomId,
    agentProfileId,
    participationMode,
    publishMode,
    triggerScope,
    preferredRuntimeDeviceId,
    generationLimitPer24h,
    expectedPolicyRevision,
    key,
    requestFingerprint,
  }) {
    const room = this._room(roomId);
    requireMembership(room, userId);
    const replay = this._replay(userId, 'putMyRoomAgentBinding', key, requestFingerprint);
    if (replay.response) return replay.response;
    const profile = this._agentProfile(agentProfileId);
    if (profile.ownerUserId !== userId) {
      throw new HttpError(403, 'forbidden', 'Agent profile owner required');
    }
    if (
      preferredRuntimeDeviceId !== null &&
      !this.userDevices.has(`${userId}:${preferredRuntimeDeviceId}`)
    ) {
      throw new HttpError(403, 'forbidden', 'Preferred runtime device owner required');
    }
    const bindingKey = this._bindingKey(roomId, userId);
    let binding = this.roomAgentBindings.get(bindingKey);
    if (binding) {
      if (expectedPolicyRevision !== binding.policyRevision) {
        throw new HttpError(409, 'request_version_conflict', 'Binding revision does not match');
      }
      binding.agentProfileId = agentProfileId;
      binding.participationMode = participationMode;
      binding.publishMode = publishMode;
      binding.triggerScope = triggerScope;
      binding.preferredRuntimeDeviceId = preferredRuntimeDeviceId;
      binding.generationLimitPer24h = generationLimitPer24h;
      binding.policyRevision += 1;
      binding.updatedAt = this.clock().toISOString();
    } else {
      if (expectedPolicyRevision !== null) {
        throw new HttpError(409, 'request_version_conflict', 'Binding does not exist');
      }
      binding = {
        id: newId('binding'),
        roomId,
        ownerUserId: userId,
        agentProfileId,
        participationMode,
        publishMode,
        triggerScope,
        preferredRuntimeDeviceId,
        generationLimitPer24h,
        policyRevision: 1,
        runtimeLeaseDeviceId: null,
        runtimeLeaseId: null,
        runtimeLeaseEpoch: 0,
        runtimeLeaseExpiresAt: null,
        updatedAt: this.clock().toISOString(),
      };
      this.roomAgentBindings.set(bindingKey, binding);
    }
    const status = binding.policyRevision === 1 ? 201 : 200;
    const body = roomAgentBindingSnapshot(binding);
    this._saveReplay(replay.recordKey, requestFingerprint, status, body);
    return { status, body };
  }

  async deleteMyRoomAgentBinding({
    userId,
    roomId,
    expectedPolicyRevision,
    key,
    requestFingerprint,
  }) {
    const room = this._room(roomId);
    requireMembership(room, userId);
    const replay = this._replay(userId, 'deleteMyRoomAgentBinding', key, requestFingerprint);
    if (replay.response) return replay.response;
    const bindingKey = this._bindingKey(roomId, userId);
    const binding = this.roomAgentBindings.get(bindingKey);
    if (!binding) {
      throw new HttpError(404, 'resource_not_found', 'Room agent binding not found');
    }
    if (expectedPolicyRevision !== binding.policyRevision) {
      throw new HttpError(409, 'request_version_conflict', 'Binding revision does not match');
    }
    this.roomAgentBindings.delete(bindingKey);
    this._saveReplay(replay.recordKey, requestFingerprint, 204, null);
    return { status: 204, body: null };
  }

  async putMyAgentRuntime({
    user,
    roomId,
    deviceId,
    readiness,
    readyForBindingPolicyRevision,
    runtimeCapabilitiesVersion,
    localConfigRevision,
    key,
    requestFingerprint,
  }) {
    const room = this._room(roomId);
    requireMembership(room, user.userId);
    if (deviceId !== user.deviceId) {
      throw new HttpError(403, 'forbidden', 'Runtime device must match the session');
    }
    const binding = this.roomAgentBindings.get(this._bindingKey(roomId, user.userId));
    if (!binding) {
      throw new HttpError(404, 'resource_not_found', 'Room agent binding not found');
    }
    const replay = this._replay(user.userId, 'putMyAgentRuntime', key, requestFingerprint);
    if (replay.response) return replay.response;
    if (
      (readiness === 'ready' &&
        readyForBindingPolicyRevision !== binding.policyRevision) ||
      (readiness === 'notReady' && readyForBindingPolicyRevision !== null)
    ) {
      throw new HttpError(409, 'request_version_conflict', 'Runtime policy revision does not match');
    }
    const runtime = {
      bindingId: binding.id,
      ownerUserId: user.userId,
      deviceId,
      readiness,
      readyForBindingPolicyRevision,
      runtimeCapabilitiesVersion,
      localConfigRevision,
      updatedAt: this.clock().toISOString(),
    };
    if (readiness === 'ready' && binding.preferredRuntimeDeviceId === deviceId) {
      acquireRuntimeLease(binding, user, this.clock());
    } else if (
      readiness === 'notReady' &&
      binding.runtimeLeaseDeviceId === deviceId
    ) {
      binding.runtimeLeaseExpiresAt = null;
    }
    this.agentRuntimes.set(this._runtimeKey(binding.id, deviceId), runtime);
    const body = agentRuntimeSnapshot(runtime);
    this._saveReplay(replay.recordKey, requestFingerprint, 200, body);
    return { status: 200, body };
  }

  async activateMyAgent({
    user,
    roomId,
    publicProfile,
    triggerScope = 'allMessages',
    runtimeCapabilitiesVersion,
    localConfigRevision,
  }) {
    const room = this._room(roomId);
    requireMembership(room, user.userId);
    this._requireOwnedAvatar(user.userId, publicProfile.avatarResourceId);
    const now = this.clock();
    const bindingKey = this._bindingKey(roomId, user.userId);
    let binding = this.roomAgentBindings.get(bindingKey);
    let profile;
    if (binding) {
      profile = this._agentProfile(binding.agentProfileId);
      if (
        profile.displayName !== publicProfile.displayName ||
        profile.avatarResourceId !== publicProfile.avatarResourceId ||
        profile.shortBio !== publicProfile.shortBio
      ) {
        profile.displayName = publicProfile.displayName;
        profile.avatarResourceId = publicProfile.avatarResourceId;
        profile.shortBio = publicProfile.shortBio;
        profile.profileRevision += 1;
        profile.updatedAt = now.toISOString();
      }
      if (
        binding.participationMode !== 'automatic' ||
        binding.publishMode !== 'automatic' ||
        binding.triggerScope !== triggerScope
      ) {
        binding.participationMode = 'automatic';
        binding.publishMode = 'automatic';
        binding.triggerScope = triggerScope;
        binding.policyRevision += 1;
        binding.updatedAt = now.toISOString();
      }
    } else {
      const createdAt = now.toISOString();
      profile = {
        id: newId('agent'),
        ownerUserId: user.userId,
        displayName: publicProfile.displayName,
        avatarResourceId: publicProfile.avatarResourceId,
        shortBio: publicProfile.shortBio,
        profileRevision: 1,
        createdAt,
        updatedAt: createdAt,
      };
      this.agentProfiles.set(profile.id, profile);
      binding = {
        id: newId('binding'),
        roomId,
        ownerUserId: user.userId,
        agentProfileId: profile.id,
        participationMode: 'automatic',
        publishMode: 'automatic',
        triggerScope,
        preferredRuntimeDeviceId: null,
        generationLimitPer24h: 1000,
        policyRevision: 1,
        runtimeLeaseDeviceId: null,
        runtimeLeaseId: null,
        runtimeLeaseEpoch: 0,
        runtimeLeaseExpiresAt: null,
        updatedAt: createdAt,
      };
      this.roomAgentBindings.set(bindingKey, binding);
    }
    acquireRuntimeLease(binding, user, now);
    const runtime = {
      bindingId: binding.id,
      ownerUserId: user.userId,
      deviceId: user.deviceId,
      readiness: 'ready',
      readyForBindingPolicyRevision: binding.policyRevision,
      runtimeCapabilitiesVersion,
      localConfigRevision,
      updatedAt: now.toISOString(),
    };
    this.agentRuntimes.set(this._runtimeKey(binding.id, user.deviceId), runtime);
    return agentActivationSnapshot(binding, profile);
  }

  async recoverMyAgentRuntime({ user, roomId }) {
    const room = this._room(roomId);
    requireMembership(room, user.userId);
    const binding = this.roomAgentBindings.get(this._bindingKey(roomId, user.userId));
    if (!binding) {
      throw new HttpError(404, 'resource_not_found', 'Room agent binding not found');
    }
    if (binding.participationMode === 'off') {
      throw new HttpError(409, 'generation_state_conflict', 'Agent binding is disabled');
    }
    const now = this.clock();
    acquireRuntimeLease(binding, user, now);
    const runtimeKey = this._runtimeKey(binding.id, user.deviceId);
    const runtime = this.agentRuntimes.get(runtimeKey) ?? {
      bindingId: binding.id,
      ownerUserId: user.userId,
      deviceId: user.deviceId,
      runtimeCapabilitiesVersion: 1,
      localConfigRevision: 0,
    };
    runtime.readiness = 'ready';
    runtime.readyForBindingPolicyRevision = binding.policyRevision;
    runtime.updatedAt = now.toISOString();
    this.agentRuntimes.set(runtimeKey, runtime);
    return agentActivationSnapshot(binding, this._agentProfile(binding.agentProfileId));
  }

  async heartbeatMyAgent({ user, roomId, leaseId, leaseEpoch }) {
    const room = this._room(roomId);
    requireMembership(room, user.userId);
    const binding = this.roomAgentBindings.get(this._bindingKey(roomId, user.userId));
    if (!binding) {
      throw new HttpError(404, 'resource_not_found', 'Room agent binding not found');
    }
    const now = this.clock();
    requireRuntimeLease(binding, user, leaseId, leaseEpoch, now);
    binding.runtimeLeaseExpiresAt = new Date(
      now.getTime() + AGENT_RUNTIME_LEASE_DURATION_MS,
    ).toISOString();
    const runtime = this.agentRuntimes.get(this._runtimeKey(binding.id, user.deviceId));
    if (runtime) runtime.updatedAt = now.toISOString();
    return agentActivationSnapshot(binding, this._agentProfile(binding.agentProfileId));
  }

  async deactivateMyAgent({ user, roomId, leaseId, leaseEpoch }) {
    const room = this._room(roomId);
    requireMembership(room, user.userId);
    const binding = this.roomAgentBindings.get(this._bindingKey(roomId, user.userId));
    if (!binding) {
      throw new HttpError(404, 'resource_not_found', 'Room agent binding not found');
    }
    requireRuntimeLease(binding, user, leaseId, leaseEpoch, this.clock(), { active: false });
    binding.preferredRuntimeDeviceId = null;
    binding.runtimeLeaseExpiresAt = null;
    const updatedAt = this.clock().toISOString();
    const runtime = this.agentRuntimes.get(this._runtimeKey(binding.id, user.deviceId));
    if (runtime) {
      runtime.readiness = 'notReady';
      runtime.readyForBindingPolicyRevision = null;
      runtime.updatedAt = updatedAt;
    }
    return {
      roomId,
      bindingId: binding.id,
      deviceId: user.deviceId,
      leaseEpoch,
      status: 'deactivated',
    };
  }

  async createManualGenerationRequest({
    user,
    roomId,
    clientGenerationRequestId,
    triggerMessageIds,
    expectedBindingPolicyRevision,
    supersedesRequestId = null,
    key,
    requestFingerprint,
  }) {
    const room = this._room(roomId);
    const membership = requireMembership(room, user.userId);
    const binding = this.roomAgentBindings.get(this._bindingKey(roomId, user.userId));
    if (!binding) {
      throw new HttpError(404, 'resource_not_found', 'Room agent binding not found');
    }
    const replay = this._replay(
      user.userId,
      'createManualGenerationRequest',
      key,
      requestFingerprint,
    );
    if (replay.response) return replay.response;
    if (binding.participationMode === 'off') {
      throw new HttpError(409, 'generation_state_conflict', 'Agent binding is disabled');
    }
    if (binding.policyRevision !== expectedBindingPolicyRevision) {
      throw new HttpError(409, 'request_version_conflict', 'Binding policy revision does not match');
    }
    const roomMessages = this.messagesByRoom.get(roomId);
    const triggers = triggerMessageIds.map((messageId) => {
      const message = roomMessages.find((candidate) => candidate.id === messageId);
      if (!message) {
        throw new HttpError(404, 'resource_not_found', 'Trigger message not found');
      }
      if (message.seq < membership.joinedSeq) {
        throw new HttpError(403, 'history_not_visible', 'Trigger message is outside membership history');
      }
      return message;
    });
    const triggerSequences = triggers.map((message) => message.seq);
    if (supersedesRequestId !== null) {
      const superseded = this.generationRequests.get(supersedesRequestId);
      if (
        !superseded ||
        superseded.ownerUserId !== user.userId ||
        superseded.creatorDeviceId !== user.deviceId
      ) {
        throw new HttpError(404, 'resource_not_found', 'Superseded generation request not found');
      }
      if (
        superseded.roomId !== roomId ||
        superseded.bindingId !== binding.id ||
        !REGENERATABLE_GENERATION_STATUSES.has(superseded.status) ||
        JSON.stringify(superseded.triggerMessageIds) !== JSON.stringify(triggerMessageIds)
      ) {
        throw new HttpError(
          409,
          'generation_state_conflict',
          'Superseded generation request is not eligible for regeneration',
        );
      }
    }
    const now = this.clock().toISOString();
    const request = {
      id: newId('generation'),
      roomId,
      bindingId: binding.id,
      ownerUserId: user.userId,
      creatorDeviceId: user.deviceId,
      source: 'manual',
      clientGenerationRequestId,
      triggerBatchId: null,
      triggerMessageIds: clone(triggerMessageIds),
      triggerFromSeq: Math.min(...triggerSequences),
      triggerThroughSeq: Math.max(...triggerSequences),
      contextThroughSeq: room.lastSeq,
      minVisibleSeq: membership.joinedSeq,
      historyPolicyRevision: room.revision,
      bindingPolicyRevision: binding.policyRevision,
      status: 'queued',
      requestVersion: 1,
      claimedDeviceId: null,
      leaseId: null,
      leaseEpoch: 0,
      leaseExpiresAt: null,
      draftDeviceId: null,
      attempt: 0,
      supersedesRequestId,
      startedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.generationRequests.set(request.id, request);
    const body = generationRequestSnapshot(request);
    this._saveReplay(replay.recordKey, requestFingerprint, 201, body);
    return { status: 201, body };
  }

  async createAutomaticGenerationRequest({
    user,
    roomId,
    triggerBatchId,
    triggerMessageIds,
    key,
    requestFingerprint,
    humanTriggersOnly = false,
  }) {
    const room = this._room(roomId);
    const membership = requireMembership(room, user.userId);
    const binding = this.roomAgentBindings.get(this._bindingKey(roomId, user.userId));
    if (!binding) {
      throw new HttpError(404, 'resource_not_found', 'Room agent binding not found');
    }
    const replay = this._replay(
      user.userId,
      'createAutomaticGenerationRequest',
      key,
      requestFingerprint,
    );
    if (replay.response) return replay.response;
    if (binding.participationMode !== 'automatic' || binding.publishMode !== 'automatic') {
      throw new HttpError(
        409,
        'generation_state_conflict',
        'Agent binding is not enabled for automatic publication',
      );
    }
    if (
      triggerMessageIds.length < 1 ||
      triggerMessageIds.length > 128 ||
      new Set(triggerMessageIds).size !== triggerMessageIds.length
    ) {
      throw new HttpError(400, 'invalid_request', 'Trigger message IDs must contain unique items');
    }
    const roomMessages = this.messagesByRoom.get(roomId);
    const triggers = triggerMessageIds.map((messageId) => {
      const message = roomMessages.find((candidate) => candidate.id === messageId);
      if (!message) {
        throw new HttpError(404, 'resource_not_found', 'Trigger message not found');
      }
      if (message.seq < membership.joinedSeq) {
        throw new HttpError(403, 'history_not_visible', 'Trigger message is outside membership history');
      }
      return message;
    });
    requireEligibleAutomaticTriggers({
      triggerScope: binding.triggerScope,
      agentProfileId: binding.agentProfileId,
      triggers,
      humanTriggersOnly,
    });
    const triggerSequences = triggers.map((message) => message.seq);
    const now = this.clock().toISOString();
    const request = {
      id: newId('generation'),
      roomId,
      bindingId: binding.id,
      ownerUserId: user.userId,
      creatorDeviceId: user.deviceId,
      source: 'automatic',
      clientGenerationRequestId: null,
      triggerBatchId,
      triggerMessageIds: clone(triggerMessageIds),
      triggerFromSeq: Math.min(...triggerSequences),
      triggerThroughSeq: Math.max(...triggerSequences),
      contextThroughSeq: room.lastSeq,
      minVisibleSeq: membership.joinedSeq,
      historyPolicyRevision: room.revision,
      bindingPolicyRevision: binding.policyRevision,
      status: 'queued',
      requestVersion: 1,
      claimedDeviceId: null,
      leaseId: null,
      leaseEpoch: 0,
      leaseExpiresAt: null,
      draftDeviceId: null,
      attempt: 0,
      supersedesRequestId: null,
      startedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.generationRequests.set(request.id, request);
    const body = generationRequestSnapshot(request);
    this._saveReplay(replay.recordKey, requestFingerprint, 201, body);
    return { status: 201, body };
  }

  async listGenerationRequests({ user, statuses, pageToken, limit }) {
    let cursor = null;
    if (pageToken !== null) {
      cursor = this.generationRequests.get(pageToken);
      if (
        !cursor ||
        cursor.ownerUserId !== user.userId ||
        cursor.creatorDeviceId !== user.deviceId
      ) {
        throw new HttpError(400, 'invalid_request', 'pageToken is not valid');
      }
    }
    const filtered = [...this.generationRequests.values()]
      .filter(
        (request) =>
          request.ownerUserId === user.userId &&
          request.creatorDeviceId === user.deviceId &&
          statuses.includes(request.status) &&
          (
            cursor === null ||
            request.createdAt.localeCompare(cursor.createdAt) < 0 ||
            (
              request.createdAt === cursor.createdAt &&
              request.id.localeCompare(cursor.id) < 0
            )
          ),
      )
      .sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
      );
    const page = filtered.slice(0, limit + 1);
    return {
      items: page.slice(0, limit).map(generationRequestSnapshot),
      nextPageToken: page.length > limit ? page[limit - 1].id : null,
    };
  }

  async getGenerationRequest({ userId, generationRequestId }) {
    const request = this._generationRequest(generationRequestId);
    if (request.ownerUserId !== userId) {
      throw new HttpError(403, 'forbidden', 'Generation request owner required');
    }
    return generationRequestSnapshot(request);
  }

  async claimGenerationRequest({
    user,
    generationRequestId,
    expectedRequestVersion,
    key,
    requestFingerprint,
  }) {
    const request = this._generationRequest(generationRequestId);
    const replay = this._replay(
      user.userId,
      'claimGenerationRequest',
      key,
      requestFingerprint,
    );
    const { binding } = this._requireGenerationContext(request, user, { ready: true });
    if (
      (request.source === 'manual' && request.creatorDeviceId !== user.deviceId) ||
      binding.preferredRuntimeDeviceId !== user.deviceId
    ) {
      throw new HttpError(403, 'forbidden', 'Current device is not eligible to claim');
    }
    const now = this.clock();
    if (replay.response) {
      requireGenerationStatus(request, 'claimed');
      requireGenerationLease(request, user, request.leaseId, request.leaseEpoch, now);
      return { status: 200, body: generationRequestSnapshot(request) };
    }
    requireGenerationVersion(request, expectedRequestVersion);
    requireGenerationStatus(request, 'queued');
    request.status = 'claimed';
    request.requestVersion += 1;
    request.claimedDeviceId = user.deviceId;
    request.leaseId = newId('lease');
    request.leaseEpoch += 1;
    request.leaseExpiresAt = new Date(
      now.getTime() + GENERATION_LEASE_DURATION_MS,
    ).toISOString();
    request.updatedAt = now.toISOString();
    const body = generationRequestSnapshot(request);
    this._saveReplay(replay.recordKey, requestFingerprint, 200, body);
    return { status: 200, body };
  }

  async startGenerationRequest({
    user,
    generationRequestId,
    expectedRequestVersion,
    leaseId,
    leaseEpoch,
    key,
    requestFingerprint,
  }) {
    const request = this._generationRequest(generationRequestId);
    const replay = this._replay(
      user.userId,
      'startGenerationRequest',
      key,
      requestFingerprint,
    );
    const { binding } = this._requireGenerationContext(request, user, { ready: true });
    const now = this.clock();
    if (replay.response) {
      requireGenerationStatus(request, 'generating');
      requireGenerationLease(request, user, leaseId, leaseEpoch, now);
      return { status: 200, body: generationRequestSnapshot(request) };
    }
    requireGenerationVersion(request, expectedRequestVersion);
    requireGenerationStatus(request, 'claimed');
    requireGenerationLease(request, user, leaseId, leaseEpoch, now);
    const cutoff = now.getTime() - 24 * 60 * 60 * 1000;
    const started = [...this.generationRequests.values()].filter(
      (candidate) =>
        candidate.bindingId === binding.id &&
        candidate.startedAt !== null &&
        Date.parse(candidate.startedAt) >= cutoff,
    );
    if (started.length >= binding.generationLimitPer24h) {
      const retryAt = Math.min(...started.map((candidate) => Date.parse(candidate.startedAt))) +
        24 * 60 * 60 * 1000;
      throw new HttpError(
        429,
        'generation_limit_exceeded',
        'Generation limit has been reached',
        { retryAfterSeconds: Math.max(0, Math.ceil((retryAt - now.getTime()) / 1000)) },
      );
    }
    request.status = 'generating';
    request.requestVersion += 1;
    request.attempt += 1;
    request.startedAt = now.toISOString();
    request.updatedAt = now.toISOString();
    const body = generationRequestSnapshot(request);
    this._saveReplay(replay.recordKey, requestFingerprint, 200, body);
    return { status: 200, body };
  }

  async markGenerationReviewPending({
    user,
    generationRequestId,
    expectedRequestVersion,
    leaseId,
    leaseEpoch,
    key,
    requestFingerprint,
  }) {
    const request = this._generationRequest(generationRequestId);
    if (request.ownerUserId !== user.userId) {
      throw new HttpError(403, 'forbidden', 'Generation request owner required');
    }
    const replay = this._replay(
      user.userId,
      'markGenerationReviewPending',
      key,
      requestFingerprint,
    );
    if (replay.response) return replay.response;
    const { binding } = this._requireGenerationContext(request, user, { ready: true });
    if (binding.publishMode !== 'reviewRequired') {
      throw new HttpError(409, 'generation_state_conflict', 'Binding does not require review');
    }
    requireGenerationVersion(request, expectedRequestVersion);
    requireGenerationStatus(request, 'generating');
    requireGenerationLease(request, user, leaseId, leaseEpoch, this.clock());
    request.status = 'review_pending';
    request.requestVersion += 1;
    request.draftDeviceId = user.deviceId;
    request.leaseId = null;
    request.leaseExpiresAt = null;
    request.updatedAt = this.clock().toISOString();
    const body = generationRequestSnapshot(request);
    this._saveReplay(replay.recordKey, requestFingerprint, 200, body);
    return { status: 200, body };
  }

  async failGenerationRequest({
    user,
    generationRequestId,
    expectedRequestVersion,
    leaseId,
    leaseEpoch,
    key,
    requestFingerprint,
  }) {
    const request = this._generationRequest(generationRequestId);
    if (request.ownerUserId !== user.userId) {
      throw new HttpError(403, 'forbidden', 'Generation request owner required');
    }
    const replay = this._replay(
      user.userId,
      'failGenerationRequest',
      key,
      requestFingerprint,
    );
    if (replay.response) return replay.response;
    requireGenerationVersion(request, expectedRequestVersion);
    requireGenerationStatus(request, 'generating');
    requireGenerationLease(request, user, leaseId, leaseEpoch, this.clock());
    request.status = 'failed';
    request.requestVersion += 1;
    request.leaseId = null;
    request.leaseExpiresAt = null;
    request.updatedAt = this.clock().toISOString();
    const body = generationRequestSnapshot(request);
    this._saveReplay(replay.recordKey, requestFingerprint, 200, body);
    return { status: 200, body };
  }

  async discardGenerationRequest({
    user,
    generationRequestId,
    expectedRequestVersion,
    key,
    requestFingerprint,
  }) {
    const request = this._generationRequest(generationRequestId);
    if (request.ownerUserId !== user.userId) {
      throw new HttpError(403, 'forbidden', 'Generation request owner required');
    }
    const replay = this._replay(
      user.userId,
      'discardGenerationRequest',
      key,
      requestFingerprint,
    );
    if (replay.response) return replay.response;
    requireGenerationVersion(request, expectedRequestVersion);
    requireGenerationStatus(request, 'review_pending');
    if (request.draftDeviceId !== user.deviceId) {
      throw new HttpError(403, 'forbidden', 'Draft device required');
    }
    request.status = 'discarded';
    request.requestVersion += 1;
    request.updatedAt = this.clock().toISOString();
    const body = generationRequestSnapshot(request);
    this._saveReplay(replay.recordKey, requestFingerprint, 200, body);
    return { status: 200, body };
  }

  async publishGenerationRequest({
    user,
    generationRequestId,
    expectedRequestVersion,
    expectedBindingPolicyRevision,
    clientMessageId,
    text,
    mentions,
    replyToMessageId,
    leaseId,
    leaseEpoch,
    key,
    requestFingerprint,
    automatic = false,
    precedingHumanMessage = null,
  }) {
    const request = this._generationRequest(generationRequestId);
    if (request.ownerUserId !== user.userId) {
      throw new HttpError(403, 'forbidden', 'Generation request owner required');
    }
    const operation = automatic
      ? 'publishAutomaticGenerationRequest'
      : 'publishGenerationRequest';
    const replay = this._replay(
      user.userId,
      operation,
      key,
      requestFingerprint,
    );
    if (replay.response) return replay.response;
    const { room, membership, binding } = this._requireGenerationContext(
      request,
      user,
      { ready: true },
    );
    requireGenerationVersion(request, expectedRequestVersion);
    if (automatic) {
      if (request.source !== 'automatic' || binding.publishMode !== 'automatic') {
        throw new HttpError(
          409,
          'generation_state_conflict',
          'Generation request is not eligible for automatic publication',
        );
      }
      requireGenerationStatus(request, 'generating');
      requireGenerationLease(request, user, leaseId, leaseEpoch, this.clock());
    } else {
      requireGenerationStatus(request, 'review_pending');
      if (request.draftDeviceId !== user.deviceId) {
        throw new HttpError(403, 'forbidden', 'Draft device required');
      }
      if (leaseId !== null || leaseEpoch !== null) {
        throw new HttpError(
          409,
          'generation_state_conflict',
          'Review publication must not use a lease',
        );
      }
    }
    if (
      expectedBindingPolicyRevision !== request.bindingPolicyRevision ||
      expectedBindingPolicyRevision !== binding.policyRevision
    ) {
      throw new HttpError(409, 'request_version_conflict', 'Binding policy revision does not match');
    }
    const messages = this.messagesByRoom.get(request.roomId);
    if (messages.some((message) => message.generationRequestId === request.id)) {
      throw new HttpError(409, 'generation_state_conflict', 'Generation request is already published');
    }
    if (
      precedingHumanMessage?.clientMessageId === clientMessageId ||
      messages.some(
        (message) =>
          message.clientMessageId === clientMessageId ||
          message.clientMessageId === precedingHumanMessage?.clientMessageId,
      )
    ) {
      throw new HttpError(409, 'conflict', 'Client message ID is already in use');
    }
    if (precedingHumanMessage === null) {
      requireAgentLoopCapacity({
        messages,
        bindings: this.roomAgentBindings,
        roomId: request.roomId,
        ownerUserId: user.userId,
        triggerScope: binding.triggerScope,
      });
    }
    for (const mention of [...(precedingHumanMessage?.mentions ?? []), ...mentions]) {
      if (mention.kind === 'user' && !room.members.has(mention.targetId)) {
        throw new HttpError(400, 'invalid_request', 'Mention target is not a room member');
      }
      if (
        mention.kind === 'agent' &&
        ![...this.roomAgentBindings.values()].some(
          (candidate) =>
            candidate.roomId === request.roomId &&
            candidate.agentProfileId === mention.targetId,
        )
      ) {
        throw new HttpError(400, 'invalid_request', 'Mentioned agent is not visible in the room');
      }
    }
    if (precedingHumanMessage?.replyToMessageId) {
      const target = messages.find(
        (message) => message.id === precedingHumanMessage.replyToMessageId,
      );
      if (!target) {
        throw new HttpError(404, 'resource_not_found', 'Reply target not found');
      }
      if (target.seq < membership.joinedSeq) {
        throw new HttpError(403, 'history_not_visible', 'Reply target is outside membership history');
      }
    }
    if (replyToMessageId !== null) {
      const target = messages.find((message) => message.id === replyToMessageId);
      if (!target) {
        throw new HttpError(404, 'resource_not_found', 'Reply target not found');
      }
      if (target.seq < membership.joinedSeq) {
        throw new HttpError(403, 'history_not_visible', 'Reply target is outside membership history');
      }
    }
    const profile = this._agentProfile(binding.agentProfileId);
    const createdAt = this.clock().toISOString();
    const humanMessage = precedingHumanMessage === null
      ? null
      : {
          id: newId('msg'),
          roomId: request.roomId,
          seq: room.lastSeq + 1,
          clientMessageId: precedingHumanMessage.clientMessageId,
          sender: {
            kind: 'human',
            userId: user.userId,
            displayNameSnapshot: user.displayName,
            avatarResourceIdSnapshot: user.avatarResourceId,
          },
          content: { schemaVersion: 1, type: 'text', text: precedingHumanMessage.text },
          mentions: clone(precedingHumanMessage.mentions),
          replyToMessageId: precedingHumanMessage.replyToMessageId,
          createdAt,
        };
    const message = {
      id: newId('msg'),
      roomId: request.roomId,
      seq: room.lastSeq + (humanMessage === null ? 1 : 2),
      clientMessageId,
      sender: {
        kind: 'agent',
        userId: user.userId,
        agentProfileId: profile.id,
        displayNameSnapshot: profile.displayName,
        avatarResourceIdSnapshot: profile.avatarResourceId,
      },
      content: { schemaVersion: 1, type: 'text', text },
      mentions: clone(mentions),
      replyToMessageId,
      generationRequestId: request.id,
      triggerThroughSeq: request.triggerThroughSeq,
      createdAt,
    };
    room.lastSeq = message.seq;
    if (humanMessage !== null) messages.push(humanMessage);
    messages.push(message);
    request.status = 'published';
    request.requestVersion += 1;
    if (automatic) {
      request.leaseId = null;
      request.leaseExpiresAt = null;
    }
    request.updatedAt = createdAt;
    const body = {
      generationRequest: generationRequestSnapshot(request),
      message: clone(message),
      ...(humanMessage === null ? {} : { humanMessage: clone(humanMessage) }),
    };
    this._saveReplay(replay.recordKey, requestFingerprint, 200, body);
    if (humanMessage !== null) {
      this.outbox.push({
        id: String(this.nextOutboxId++),
        eventId: newId('evt'),
        type: 'message.created',
        roomId: request.roomId,
        payload: clone(humanMessage),
        occurredAt: createdAt,
        dispatchedAt: null,
      });
    }
    this.outbox.push({
      id: String(this.nextOutboxId++),
      eventId: newId('evt'),
      type: 'message.created',
      roomId: request.roomId,
      payload: clone(message),
      occurredAt: createdAt,
      dispatchedAt: null,
    });
    return { status: 200, body };
  }

  async publishAutomaticGenerationRequest(parameters) {
    return this.publishGenerationRequest({ ...parameters, automatic: true });
  }

  async listInvites({ userId, roomId }) {
    const room = this._room(roomId);
    requireInviteManager(room, userId);
    const now = this.clock();
    return [...this.invites.values()]
      .filter((invite) => invite.roomId === roomId && activeInvite(invite, now))
      .map(inviteSummary);
  }

  async createInvite({
    userId,
    roomId,
    expectedRoomRevision,
    expiresAt,
    maxUses,
    key,
    requestFingerprint,
  }) {
    const room = this._room(roomId);
    requireInviteManager(room, userId);
    const replay = this._replay(userId, 'createRoomInvite', key, requestFingerprint);
    if (replay.response) return replay.response;
    if (expectedRoomRevision !== room.revision) {
      throw new HttpError(409, 'request_version_conflict', 'Room revision does not match');
    }
    const token = randomBytes(16).toString('base64url');
    const invite = {
      id: newId('invite'),
      roomId,
      createdByUserId: userId,
      tokenHash: hash(token),
      expiresAt,
      maxUses,
      remainingUses: maxUses,
      createdAt: this.clock().toISOString(),
      revokedAt: null,
    };
    this.invites.set(invite.id, invite);
    const body = { ...inviteSummary(invite), inviteToken: token };
    this._saveReplay(replay.recordKey, requestFingerprint, 201, body);
    return { status: 201, body };
  }

  async revokeInvite({ userId, roomId, inviteId, key, requestFingerprint }) {
    const room = this._room(roomId);
    requireInviteManager(room, userId);
    const invite = this.invites.get(inviteId);
    if (!invite || invite.roomId !== roomId) {
      throw new HttpError(404, 'resource_not_found', 'Invite not found');
    }
    const replay = this._replay(userId, 'revokeRoomInvite', key, requestFingerprint);
    if (replay.response) return replay.response;
    if (!activeInvite(invite, this.clock())) {
      throw new HttpError(409, 'conflict', 'Invite is no longer active');
    }
    invite.revokedAt = this.clock().toISOString();
    this._saveReplay(replay.recordKey, requestFingerprint, 204, null);
    return { status: 204, body: null };
  }

  async invitePreview({ inviteToken }) {
    const tokenHash = hash(inviteToken);
    const invite = [...this.invites.values()].find((entry) => entry.tokenHash === tokenHash);
    if (!invite || !activeInvite(invite, this.clock())) {
      throw new HttpError(404, 'resource_not_found', 'Invite is not valid or has expired');
    }
    const room = this._room(invite.roomId);
    const inviter = this.usersById.get(invite.createdByUserId);
    return {
      roomTitle: room.title,
      inviterDisplayName: inviter?.displayName ?? 'Unknown',
      expiresAt: invite.expiresAt,
      remainingUses: invite.remainingUses,
    };
  }

  async acceptInvite({ userId, inviteToken, key, requestFingerprint }) {
    const replay = this._replay(userId, 'acceptRoomInvite', key, requestFingerprint);
    if (replay.response) return replay.response;
    const tokenHash = hash(inviteToken);
    const invite = [...this.invites.values()].find((entry) => entry.tokenHash === tokenHash);
    if (!invite || !activeInvite(invite, this.clock())) {
      throw new HttpError(409, 'conflict', 'Invite is not valid');
    }
    const room = this._room(invite.roomId);
    let membership = room.members.get(userId);
    if (!membership) {
      const joinedSeq = room.historyVisibility === 'from_start' ? 1 : room.lastSeq + 1;
      membership = {
        userId,
        role: 'member',
        joinedSeq,
        readSeq: joinedSeq - 1,
      };
      room.members.set(userId, membership);
      invite.remainingUses -= 1;
      room.revision += 1;
      room.updatedAt = this.clock().toISOString();
    }
    const body = {
      room: roomSnapshot(room),
      membership: membershipSnapshot(this.usersById.get(userId), membership, true),
    };
    this._saveReplay(replay.recordKey, requestFingerprint, 200, body);
    return { status: 200, body };
  }

  async listMessages({ userId, roomId, afterSeq, limit }) {
    const room = this._room(roomId);
    const membership = requireMembership(room, userId);
    const visible = this.messagesByRoom.get(roomId).filter(
      (message) => message.seq > afterSeq && message.seq >= membership.joinedSeq,
    );
    return {
      items: visible.slice(0, limit).map(clone),
      highWaterSeq: room.lastSeq,
      hasMore: visible.length > limit,
    };
  }

  async listWebMessages({ userId, roomId, beforeSeq, limit }) {
    const room = this._room(roomId);
    const membership = requireMembership(room, userId);
    const upperBound = beforeSeq ?? room.lastSeq + 1;
    const visible = this.messagesByRoom.get(roomId)
      .filter(
        (message) => message.seq < upperBound && message.seq >= membership.joinedSeq,
      )
      .sort((left, right) => right.seq - left.seq);
    const page = visible.slice(0, limit);
    const items = page.reverse().map(clone);
    return {
      items,
      highWaterSeq: room.lastSeq,
      hasMore: visible.length > limit,
      nextBeforeSeq: items.length > 0 ? items[0].seq : null,
    };
  }

  async createHumanMessage({
    user,
    roomId,
    clientMessageId,
    text,
    mentions,
    replyToMessageId,
    key,
    requestFingerprint,
  }) {
    const room = this._room(roomId);
    const membership = requireMembership(room, user.userId);
    const replay = this._replay(
      user.userId,
      'createHumanMessage',
      key,
      requestFingerprint,
    );
    if (replay.response) return replay.response;
    for (const mention of mentions) {
      if (mention.kind === 'user' && !room.members.has(mention.targetId)) {
        throw new HttpError(400, 'invalid_request', 'Mention target is not a room member');
      }
      if (
        mention.kind === 'agent' &&
        ![...this.roomAgentBindings.values()].some(
          (binding) =>
            binding.roomId === roomId && binding.agentProfileId === mention.targetId,
        )
      ) {
        throw new HttpError(400, 'invalid_request', 'Mentioned agent is not visible in the room');
      }
    }
    if (replyToMessageId) {
      const target = this.messagesByRoom.get(roomId).find(
        (message) => message.id === replyToMessageId,
      );
      if (!target) throw new HttpError(404, 'resource_not_found', 'Reply target not found');
      if (target.seq < membership.joinedSeq) {
        throw new HttpError(403, 'history_not_visible', 'Reply target is outside membership history');
      }
    }
    const createdAt = this.clock().toISOString();
    const message = {
      id: newId('msg'),
      roomId,
      seq: room.lastSeq + 1,
      clientMessageId,
      sender: {
        kind: 'human',
        userId: user.userId,
        displayNameSnapshot: user.displayName,
        avatarResourceIdSnapshot: user.avatarResourceId,
      },
      content: { schemaVersion: 1, type: 'text', text },
      mentions: clone(mentions),
      replyToMessageId,
      createdAt,
    };
    room.lastSeq = message.seq;
    this.messagesByRoom.get(roomId).push(message);
    const body = clone(message);
    this._saveReplay(replay.recordKey, requestFingerprint, 201, body);
    this.outbox.push({
      id: String(this.nextOutboxId++),
      eventId: newId('evt'),
      type: 'message.created',
      roomId,
      payload: body,
      occurredAt: createdAt,
      dispatchedAt: null,
    });
    return { status: 201, body };
  }

  async recallMessage({ userId, roomId, messageId }) {
    const room = this._room(roomId);
    requireMembership(room, userId);
    const message = this.messagesByRoom.get(roomId).find(
      (candidate) => candidate.id === messageId,
    );
    if (!message) throw new HttpError(404, 'resource_not_found', 'Message not found');
    if (message.sender.userId !== userId) {
      throw new HttpError(403, 'forbidden', 'Message sender owner required');
    }
    if (message.recalledAt) return clone(message);
    const now = this.clock();
    if (now.getTime() - Date.parse(message.createdAt) > MESSAGE_RECALL_WINDOW_MS) {
      throw new HttpError(409, 'recall_window_expired', 'Message recall window has expired');
    }
    message.content = { schemaVersion: 1, type: 'text', text: '' };
    message.mentions = [];
    message.replyToMessageId = null;
    message.recalledAt = now.toISOString();
    const body = clone(message);
    this.outbox.push({
      id: String(this.nextOutboxId++),
      eventId: newId('evt'),
      type: 'message.recalled',
      roomId,
      payload: body,
      occurredAt: message.recalledAt,
      dispatchedAt: null,
    });
    return body;
  }

  async handoffToRoom({
    user,
    title,
    contextSummary,
    decisions,
    openQuestions,
    invite,
    key,
    requestFingerprint,
  }) {
    const replay = this._replay(user.userId, 'handoffToRoom', key, requestFingerprint);
    if (replay.response) return replay.response;
    const text = assembleHandoffMessage({ contextSummary, decisions, openQuestions });
    const createdAt = this.clock().toISOString();
    const roomId = newId('room');
    const room = {
      id: roomId,
      ownerUserId: user.userId,
      title,
      lastSeq: 1,
      revision: 1,
      historyVisibility: 'from_start',
      createdAt,
      updatedAt: createdAt,
      members: new Map([
        [user.userId, { userId: user.userId, role: 'owner', joinedSeq: 0, readSeq: 0 }],
      ]),
    };
    this.rooms.set(roomId, room);
    this.messagesByRoom.set(roomId, []);
    const message = {
      id: newId('msg'),
      roomId,
      seq: 1,
      clientMessageId: handoffMessageId(key),
      sender: {
        kind: 'human',
        userId: user.userId,
        displayNameSnapshot: user.displayName,
        avatarResourceIdSnapshot: user.avatarResourceId,
      },
      content: { schemaVersion: 1, type: 'text', text },
      mentions: [],
      replyToMessageId: null,
      createdAt,
    };
    this.messagesByRoom.get(roomId).push(message);
    const token = randomBytes(16).toString('base64url');
    const inviteRecord = {
      id: newId('invite'),
      roomId,
      createdByUserId: user.userId,
      tokenHash: hash(token),
      expiresAt: invite.expiresAt,
      maxUses: invite.maxUses,
      remainingUses: invite.maxUses,
      createdAt,
      revokedAt: null,
    };
    this.invites.set(inviteRecord.id, inviteRecord);
    const body = {
      room: roomSnapshot(room),
      message: clone(message),
      invite: { ...inviteSummary(inviteRecord), inviteToken: token },
    };
    this._saveReplay(replay.recordKey, requestFingerprint, 201, body);
    this.outbox.push({
      id: String(this.nextOutboxId++),
      eventId: newId('evt'),
      type: 'message.created',
      roomId,
      payload: clone(message),
      occurredAt: createdAt,
      dispatchedAt: null,
    });
    return { status: 201, body };
  }

  async listPendingOutboxEvents(limit = 100) {
    return this.outbox
      .filter((entry) => entry.dispatchedAt === null)
      .slice(0, limit)
      .map((entry) => ({
        outboxId: entry.id,
        event: {
          protocolVersion: 1,
          eventId: entry.eventId,
          type: entry.type,
          occurredAt: entry.occurredAt,
          ...(entry.roomId ? { roomId: entry.roomId } : {}),
          payload: clone(entry.payload),
        },
      }));
  }

  async markOutboxDispatched(outboxId) {
    const entry = this.outbox.find((candidate) => candidate.id === String(outboxId));
    if (entry) entry.dispatchedAt = this.clock().toISOString();
  }

  async listRealtimeRecipientUserIds(roomId, messageSeq) {
    const room = this._room(roomId);
    return [...room.members.values()]
      .filter((membership) => membership.joinedSeq <= messageSeq)
      .map((membership) => membership.userId);
  }

  async listProfileRecipientUserIds(ownerUserId) {
    const recipients = new Set([ownerUserId]);
    for (const room of this.rooms.values()) {
      if (!room.members.has(ownerUserId)) continue;
      for (const membership of room.members.values()) recipients.add(membership.userId);
    }
    return [...recipients];
  }
}

function rowToUser(row) {
  return {
    id: row.id,
    userId: row.id,
    deviceId: row.device_id,
    handle: row.handle,
    displayName: row.display_name,
    avatarResourceId: row.avatar_resource_id,
    profileRevision: row.profile_revision,
  };
}

function rowToRoom(row, includeWorld = false) {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    title: row.title,
    lastSeq: safeInteger(row.last_seq, 'rooms.last_seq'),
    revision: safeInteger(row.revision, 'rooms.revision'),
    historyVisibility: row.history_visibility,
    ...(includeWorld ? {
      worldPublished: row.world_published ?? false,
      worldSummary: row.world_summary ?? '',
    } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function rowToWorldRoom(row, includeInvite = true) {
  const snapshot = {
    id: row.id,
    title: row.title,
    ownerUserId: row.owner_user_id,
    ownerDisplayName: row.owner_display_name,
    summary: row.world_summary,
    publishedAt: iso(row.world_published_at),
  };
  if (includeInvite) {
    Object.assign(snapshot, {
      inviteToken: row.world_invite_token,
      inviteExpiresAt: iso(row.world_invite_expires_at),
      remainingUses: row.world_invite_remaining_uses,
    });
  }
  return snapshot;
}

function rowToMembership(row, includeReadSeq) {
  return {
    userId: row.user_id,
    role: row.role,
    joinedSeq: safeInteger(row.joined_seq, 'room_members.joined_seq'),
    ...(includeReadSeq
      ? { readSeq: safeInteger(row.read_seq, 'room_members.read_seq') }
      : {}),
    displayName: row.display_name,
    avatarResourceId: row.avatar_resource_id,
  };
}

function rowToInvite(row) {
  return {
    id: row.id,
    roomId: row.room_id,
    createdByUserId: row.created_by_user_id,
    expiresAt: iso(row.expires_at),
    maxUses: row.max_uses,
    remainingUses: row.remaining_uses,
    createdAt: iso(row.created_at),
  };
}

function rowToAgentProfile(row) {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    displayName: row.display_name,
    avatarResourceId: row.avatar_resource_id,
    shortBio: row.short_bio,
    profileRevision: safeInteger(row.profile_revision, 'agent_profiles.profile_revision'),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function rowToRoomAgentBinding(row) {
  return {
    bindingId: row.id,
    roomId: row.room_id,
    ownerUserId: row.owner_user_id,
    agentProfileId: row.agent_profile_id,
    participationMode: row.participation_mode,
    publishMode: row.publish_mode,
    triggerScope: row.trigger_scope,
    preferredRuntimeDeviceId: row.preferred_runtime_device_id,
    generationLimitPer24h: row.generation_limit_per_24h,
    policyRevision: safeInteger(row.policy_revision, 'room_agent_bindings.policy_revision'),
    updatedAt: iso(row.updated_at),
  };
}

function rowToPublicRoomAgentBinding(row) {
  return {
    bindingId: row.id,
    roomId: row.room_id,
    ownerUserId: row.owner_user_id,
    agentProfileId: row.agent_profile_id,
    agentProfileRevision: safeInteger(
      row.agent_profile_revision,
      'agent_profiles.profile_revision',
    ),
    displayName: row.agent_display_name,
    avatarResourceId: row.agent_avatar_resource_id,
    participationMode: row.participation_mode,
    publishMode: row.publish_mode,
    triggerScope: row.trigger_scope,
    policyRevision: safeInteger(row.policy_revision, 'room_agent_bindings.policy_revision'),
    updatedAt: iso(row.updated_at),
  };
}

function rowToAgentRuntime(row) {
  return {
    bindingId: row.binding_id,
    deviceId: row.device_id,
    readiness: row.readiness,
    readyForBindingPolicyRevision: row.ready_for_binding_policy_revision === null
      ? null
      : safeInteger(
        row.ready_for_binding_policy_revision,
        'agent_runtimes.ready_for_binding_policy_revision',
      ),
    runtimeCapabilitiesVersion: safeInteger(
      row.runtime_capabilities_version,
      'agent_runtimes.runtime_capabilities_version',
    ),
    localConfigRevision: safeInteger(
      row.local_config_revision,
      'agent_runtimes.local_config_revision',
    ),
    updatedAt: iso(row.updated_at),
  };
}

function rowToAgentActivation(binding, profile) {
  return {
    roomId: binding.room_id,
    bindingId: binding.id,
    agentProfileId: profile.id,
    profileRevision: safeInteger(profile.profile_revision, 'agent_profiles.profile_revision'),
    policyRevision: safeInteger(binding.policy_revision, 'room_agent_bindings.policy_revision'),
    deviceId: binding.runtime_lease_device_id,
    leaseId: binding.runtime_lease_id,
    leaseEpoch: safeInteger(
      binding.runtime_lease_epoch,
      'room_agent_bindings.runtime_lease_epoch',
    ),
    leaseExpiresAt: iso(binding.runtime_lease_expires_at),
  };
}

function rowToGenerationRequest(row) {
  return {
    id: row.id,
    roomId: row.room_id,
    bindingId: row.binding_id,
    ownerUserId: row.owner_user_id,
    source: row.source,
    ...(row.client_generation_request_id
      ? { clientGenerationRequestId: row.client_generation_request_id }
      : {}),
    ...(row.trigger_batch_id ? { triggerBatchId: row.trigger_batch_id } : {}),
    triggerMessageIds: row.trigger_message_ids,
    triggerFromSeq: safeInteger(row.trigger_from_seq, 'generation_requests.trigger_from_seq'),
    triggerThroughSeq: safeInteger(
      row.trigger_through_seq,
      'generation_requests.trigger_through_seq',
    ),
    contextThroughSeq: safeInteger(
      row.context_through_seq,
      'generation_requests.context_through_seq',
    ),
    minVisibleSeq: safeInteger(row.min_visible_seq, 'generation_requests.min_visible_seq'),
    historyPolicyRevision: safeInteger(
      row.history_policy_revision,
      'generation_requests.history_policy_revision',
    ),
    bindingPolicyRevision: safeInteger(
      row.binding_policy_revision,
      'generation_requests.binding_policy_revision',
    ),
    status: row.status,
    requestVersion: safeInteger(row.request_version, 'generation_requests.request_version'),
    ...(row.claimed_device_id ? { claimedDeviceId: row.claimed_device_id } : {}),
    ...(row.lease_id ? { leaseId: row.lease_id } : {}),
    leaseEpoch: safeInteger(row.lease_epoch, 'generation_requests.lease_epoch'),
    ...(row.lease_expires_at ? { leaseExpiresAt: iso(row.lease_expires_at) } : {}),
    ...(row.draft_device_id ? { draftDeviceId: row.draft_device_id } : {}),
    attempt: safeInteger(row.attempt, 'generation_requests.attempt'),
    ...(row.supersedes_request_id
      ? { supersedesRequestId: row.supersedes_request_id }
      : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function rowToMessage(row) {
  return {
    id: row.id,
    roomId: row.room_id,
    seq: safeInteger(row.seq, 'messages.seq'),
    clientMessageId: row.client_message_id,
    sender: row.sender,
    content: row.content,
    mentions: row.mentions,
    replyToMessageId: row.reply_to_message_id,
    ...(row.generation_request_id
      ? { generationRequestId: row.generation_request_id }
      : {}),
    ...(row.trigger_through_seq !== null
      ? { triggerThroughSeq: safeInteger(row.trigger_through_seq, 'messages.trigger_through_seq') }
      : {}),
    recalledAt: row.recalled_at ? iso(row.recalled_at) : null,
    createdAt: iso(row.created_at),
  };
}

function rowToContextAgentBinding(row) {
  return {
    binding: rowToPublicRoomAgentBinding(row),
    agentProfile: {
      id: row.context_profile_id,
      ownerUserId: row.context_profile_owner_user_id,
      displayName: row.context_profile_display_name,
      avatarResourceId: row.context_profile_avatar_resource_id,
      shortBio: row.context_profile_short_bio,
      profileRevision: safeInteger(
        row.agent_profile_revision,
        'agent_profiles.profile_revision',
      ),
      createdAt: iso(row.context_profile_created_at),
      updatedAt: iso(row.context_profile_updated_at),
    },
  };
}

export class PostgresGroupChatStore {
  static async connect({
    connectionString,
    ssl = false,
    migrate = false,
    clock = () => new Date(),
    logger = console,
  }) {
    if (!connectionString?.trim()) {
      throw new Error('DATABASE_URL is required for PostgreSQL storage');
    }
    const pool = new pg.Pool({
      connectionString,
      ssl: ssl ? { rejectUnauthorized: true } : undefined,
      max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
    });
    try {
      await pool.query('SELECT 1');
      if (migrate) await runMigrations(pool, logger);
      await pool.query('SELECT 1 FROM users LIMIT 1');
      return new PostgresGroupChatStore({ pool, clock });
    } catch (error) {
      await pool.end();
      throw error;
    }
  }

  constructor({ pool, clock = () => new Date() }) {
    this.pool = pool;
    this.clock = clock;
  }

  async health() {
    await this.pool.query('SELECT 1');
  }

  async close() {
    await this.pool.end();
  }

  async _transaction(action) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async _replay(client, principalId, operation, key, requestFingerprint) {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`${principalId}:${operation}:${key}`],
    );
    const result = await client.query(
      `SELECT request_fingerprint, response_status, response_body
         FROM idempotency_records
        WHERE principal_id = $1 AND operation = $2 AND idempotency_key = $3`,
      [principalId, operation, key],
    );
    if (result.rowCount === 0) return null;
    const row = result.rows[0];
    if (row.request_fingerprint !== requestFingerprint) throw idempotencyConflict();
    return { status: row.response_status, body: row.response_body };
  }

  async _saveReplay(
    client,
    { principalId, operation, key, requestFingerprint, status, body },
  ) {
    await client.query(
      `INSERT INTO idempotency_records(
         principal_id, operation, idempotency_key, request_fingerprint,
         response_status, response_body, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [principalId, operation, key, requestFingerprint, status, body, this.clock()],
    );
  }

  async _createDeviceSession(client, {
    userId,
    deviceId,
    kind,
    label,
    prefix,
  }) {
    const now = this.clock();
    const resolvedDeviceId = deviceId ?? `${kind}_${randomBytes(12).toString('base64url')}`;
    const token = `${prefix}_${randomBytes(24).toString('base64url')}`;
    await client.query(
      `INSERT INTO user_devices(
         user_id, device_id, kind, label, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $5)`,
      [userId, resolvedDeviceId, kind, label, now],
    );
    await client.query(
      `INSERT INTO sessions(token_hash, user_id, device_id, created_at)
       VALUES ($1, $2, $3, $4)`,
      [hash(token), userId, resolvedDeviceId, now],
    );
    return { token, deviceId: resolvedDeviceId, label };
  }

  async _issueWebBindingCode(client, userId) {
    const user = await client.query('SELECT 1 FROM users WHERE id = $1', [userId]);
    if (user.rowCount === 0) {
      throw new HttpError(404, 'resource_not_found', 'User not found');
    }
    const code = newOneTimeCode();
    const now = this.clock();
    const expiresAt = new Date(now.getTime() + WEB_BINDING_CODE_TTL_MS);
    await client.query(
      `INSERT INTO web_binding_codes(user_id, code_hash, expires_at, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE
       SET code_hash = EXCLUDED.code_hash,
           expires_at = EXCLUDED.expires_at,
           created_at = EXCLUDED.created_at`,
      [userId, hash(normalizeOneTimeCode(code)), expiresAt, now],
    );
    return { bindingCode: code, expiresAt: expiresAt.toISOString() };
  }

  async _issueWebPasswordResetCode(client, userId) {
    const account = await client.query(
      'SELECT 1 FROM web_accounts WHERE user_id = $1',
      [userId],
    );
    if (account.rowCount === 0) {
      throw new HttpError(409, 'web_account_required', 'Web account is not configured');
    }
    const code = newOneTimeCode();
    const now = this.clock();
    const expiresAt = new Date(now.getTime() + WEB_RESET_CODE_TTL_MS);
    await client.query(
      `INSERT INTO web_password_reset_codes(user_id, code_hash, expires_at, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE
       SET code_hash = EXCLUDED.code_hash,
           expires_at = EXCLUDED.expires_at,
           created_at = EXCLUDED.created_at`,
      [userId, hash(normalizeOneTimeCode(code)), expiresAt, now],
    );
    return { resetCode: code, expiresAt: expiresAt.toISOString() };
  }

  async _requireOwnedAvatar(client, userId, avatarResourceId) {
    if (avatarResourceId === null) return;
    const result = await client.query(
      'SELECT 1 FROM profile_resources WHERE id = $1 AND owner_user_id = $2',
      [avatarResourceId, userId],
    );
    if (result.rowCount === 0) {
      throw new HttpError(403, 'forbidden', 'Avatar resource owner required');
    }
  }

  async _enqueueProfileUpdated(client, profileType, ownerUserId, profile) {
    await client.query(
      `INSERT INTO outbox_events(
         event_id, event_type, room_id, payload, occurred_at, dispatched_at
       ) VALUES ($1, 'profile.updated', NULL, $2, $3, NULL)`,
      [
        newId('evt'),
        { profileType, ownerUserId, profile },
        this.clock(),
      ],
    );
  }

  async _room(client, roomId, { lock = false } = {}) {
    const result = await client.query(
      `SELECT * FROM rooms WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
      [roomId],
    );
    if (result.rowCount === 0) {
      throw new HttpError(404, 'resource_not_found', 'Room not found');
    }
    return result.rows[0];
  }

  async _membership(client, roomId, userId, { manager = false, lock = false } = {}) {
    const result = await client.query(
      `SELECT * FROM room_members
        WHERE room_id = $1 AND user_id = $2${lock ? ' FOR UPDATE' : ''}`,
      [roomId, userId],
    );
    if (result.rowCount === 0) {
      throw new HttpError(403, 'forbidden', 'Room membership required');
    }
    const membership = result.rows[0];
    if (manager && membership.role !== 'owner' && membership.role !== 'admin') {
      throw new HttpError(403, 'forbidden', 'Owner or admin role required');
    }
    return membership;
  }

  async _bindingById(client, bindingId, { lock = false } = {}) {
    const result = await client.query(
      `SELECT * FROM room_agent_bindings
        WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
      [bindingId],
    );
    if (result.rowCount === 0) {
      throw new HttpError(409, 'request_version_conflict', 'Agent binding is no longer current');
    }
    return result.rows[0];
  }

  async _generationRequest(client, generationRequestId, { lock = false } = {}) {
    const result = await client.query(
      `SELECT * FROM generation_requests
        WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
      [generationRequestId],
    );
    if (result.rowCount === 0) {
      throw new HttpError(404, 'resource_not_found', 'Generation request not found');
    }
    return result.rows[0];
  }

  async _requireReadyRuntime(client, binding, user) {
    const result = await client.query(
      `SELECT * FROM agent_runtimes
        WHERE binding_id = $1 AND device_id = $2`,
      [binding.id, user.deviceId],
    );
    const runtime = result.rows[0];
    if (
      !runtime ||
      runtime.readiness !== 'ready' ||
      safeInteger(
        runtime.ready_for_binding_policy_revision,
        'agent_runtimes.ready_for_binding_policy_revision',
      ) !== safeInteger(binding.policy_revision, 'room_agent_bindings.policy_revision') ||
      binding.preferred_runtime_device_id !== user.deviceId ||
      binding.runtime_lease_device_id !== user.deviceId ||
      !binding.runtime_lease_expires_at ||
      new Date(binding.runtime_lease_expires_at).getTime() <= this.clock().getTime()
    ) {
      throw new HttpError(409, 'runtime_not_ready', 'Agent runtime is not ready');
    }
    return runtime;
  }

  async _generationContext(client, request, user, { ready = false } = {}) {
    if (request.owner_user_id !== user.userId) {
      throw new HttpError(403, 'forbidden', 'Generation request owner required');
    }
    const room = await this._room(client, request.room_id, { lock: true });
    const membership = await this._membership(client, request.room_id, user.userId);
    const binding = await this._bindingById(client, request.binding_id, { lock: true });
    if (
      binding.room_id !== request.room_id ||
      binding.owner_user_id !== user.userId ||
      binding.participation_mode === 'off'
    ) {
      throw new HttpError(409, 'generation_state_conflict', 'Agent binding is disabled');
    }
    if (
      safeInteger(binding.policy_revision, 'room_agent_bindings.policy_revision') !==
      safeInteger(request.binding_policy_revision, 'generation_requests.binding_policy_revision')
    ) {
      throw new HttpError(409, 'request_version_conflict', 'Binding policy has changed');
    }
    if (ready) await this._requireReadyRuntime(client, binding, user);
    return { room, membership, binding };
  }

  async createGuestSession({ deviceId, displayName }) {
    try {
      return await this._transaction(async (client) => {
        const now = this.clock();
        const nicknameKey = displayName.normalize('NFKC').toLowerCase();
        const existing = await client.query(
          'SELECT * FROM users WHERE device_id = $1 FOR UPDATE',
          [deviceId],
        );
        let user;
        if (existing.rowCount > 0) {
          const row = existing.rows[0];
          if (row.display_name !== displayName) {
            const updated = await client.query(
              `UPDATE users
                  SET display_name = $1, nickname_key = $2,
                      profile_revision = profile_revision + 1, updated_at = $3
                WHERE id = $4
                RETURNING *`,
              [displayName, nicknameKey, now, row.id],
            );
            user = rowToUser(updated.rows[0]);
          } else {
            user = rowToUser(row);
          }
        } else {
          const id = newId('usr');
          const inserted = await client.query(
            `INSERT INTO users(
               id, device_id, handle, display_name, nickname_key,
               avatar_resource_id, profile_revision, created_at, updated_at
             ) VALUES ($1, $2, $3, $4, $5, NULL, 1, $6, $6)
             RETURNING *`,
            [id, deviceId, `guest_${hash(deviceId).slice(0, 12)}`, displayName, nicknameKey, now],
          );
          user = rowToUser(inserted.rows[0]);
        }
        const accessToken = `dev_${randomBytes(24).toString('base64url')}`;
        await client.query(
          `INSERT INTO user_devices(user_id, device_id, created_at, updated_at)
           VALUES ($1, $2, $3, $3)
           ON CONFLICT (user_id, device_id) DO UPDATE SET updated_at = EXCLUDED.updated_at`,
          [user.userId, deviceId, now],
        );
        await client.query(
          `INSERT INTO sessions(token_hash, user_id, device_id, created_at)
           VALUES ($1, $2, $3, $4)`,
          [hash(accessToken), user.userId, deviceId, now],
        );
        return { accessToken, tokenType: 'Bearer', user: publicUser(user) };
      });
    } catch (error) {
      if (error?.code === '23505' && error?.constraint === 'users_nickname_key_key') {
        throw new HttpError(409, 'conflict', 'Nickname is already in use');
      }
      throw error;
    }
  }

  async createUserRegistration({ displayName, key, requestFingerprint }) {
    try {
      return await this._transaction(async (client) => {
        const replay = await this._replay(
          client,
          PUBLIC_REGISTRATION_PRINCIPAL_ID,
          'createUserRegistration',
          key,
          requestFingerprint,
        );
        if (replay) {
          const existing = await client.query(
            'SELECT device_id FROM users WHERE id = $1',
            [replay.body.userId],
          );
          const accessToken = `ct_${randomBytes(24).toString('base64url')}`;
          await client.query(
            `INSERT INTO sessions(token_hash, user_id, device_id, created_at)
             VALUES ($1, $2, $3, $4)`,
            [
              hash(accessToken),
              replay.body.userId,
              existing.rows[0].device_id,
              this.clock(),
            ],
          );
          return { token: accessToken, ...replay.body };
        }
        const now = this.clock();
        const deviceId = `web_${randomBytes(12).toString('base64url')}`;
        const nicknameKey = displayName.normalize('NFKC').toLowerCase();
        const id = newId('usr');
        const inserted = await client.query(
          `INSERT INTO users(
             id, device_id, handle, display_name, nickname_key,
             avatar_resource_id, profile_revision, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, NULL, 1, $6, $6)
           RETURNING *`,
          [id, deviceId, `guest_${hash(deviceId).slice(0, 12)}`, displayName, nicknameKey, now],
        );
        const user = rowToUser(inserted.rows[0]);
        await client.query(
          `INSERT INTO user_devices(user_id, device_id, created_at, updated_at)
           VALUES ($1, $2, $3, $3)`,
          [user.userId, deviceId, now],
        );
        const accessToken = `ct_${randomBytes(24).toString('base64url')}`;
        await client.query(
          `INSERT INTO sessions(token_hash, user_id, device_id, created_at)
           VALUES ($1, $2, $3, $4)`,
          [hash(accessToken), user.userId, deviceId, now],
        );
        const body = {
          userId: user.userId,
          displayName: user.displayName,
          handle: user.handle,
        };
        await this._saveReplay(client, {
          principalId: PUBLIC_REGISTRATION_PRINCIPAL_ID,
          operation: 'createUserRegistration',
          key,
          requestFingerprint,
          status: 201,
          body,
        });
        return { token: accessToken, ...body };
      });
    } catch (error) {
      if (error?.code === '23505' && error?.constraint === 'users_nickname_key_key') {
        throw new HttpError(409, 'conflict', 'Nickname is already in use');
      }
      throw error;
    }
  }

  async createMcpRegistration({ displayName, deviceLabel, key, requestFingerprint }) {
    return this._transaction(async (client) => {
      const replay = await this._replay(
        client,
        PUBLIC_REGISTRATION_PRINCIPAL_ID,
        'createMcpRegistration',
        key,
        requestFingerprint,
      );
      let body;
      let deviceId;
      if (replay) {
        body = replay.body;
      } else {
        const now = this.clock();
        deviceId = `mcp_${randomBytes(12).toString('base64url')}`;
        const id = newId('usr');
        const inserted = await client.query(
          `INSERT INTO users(
             id, device_id, handle, display_name, nickname_key,
             avatar_resource_id, profile_revision, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, NULL, 1, $6, $6)
           RETURNING *`,
          [
            id,
            deviceId,
            `guest_${hash(deviceId).slice(0, 12)}`,
            displayName,
            displayName.normalize('NFKC').toLowerCase(),
            now,
          ],
        );
        body = publicUser(rowToUser(inserted.rows[0]));
        await this._saveReplay(client, {
          principalId: PUBLIC_REGISTRATION_PRINCIPAL_ID,
          operation: 'createMcpRegistration',
          key,
          requestFingerprint,
          status: 201,
          body,
        });
      }
      const session = await this._createDeviceSession(client, {
        userId: body.userId,
        deviceId,
        kind: 'mcp',
        label: deviceLabel,
        prefix: 'ct',
      });
      return {
        token: session.token,
        ...body,
        ...await this._issueWebBindingCode(client, body.userId),
      };
    });
  }

  async issueWebBindingCode({ userId }) {
    return this._transaction((client) => this._issueWebBindingCode(client, userId));
  }

  async registerWebAccount({
    username,
    usernameKey,
    displayName,
    passwordSalt,
    passwordHash,
    bindingCode,
  }) {
    try {
      return await this._transaction(async (client) => {
        const codeHash = hash(normalizeOneTimeCode(bindingCode));
        const codeResult = await client.query(
          'SELECT * FROM web_binding_codes WHERE code_hash = $1 FOR UPDATE',
          [codeHash],
        );
        const code = codeResult.rows[0];
        if (!code || new Date(code.expires_at).getTime() <= this.clock().getTime()) {
          throw new HttpError(400, 'invalid_binding_code', 'Binding code is invalid or expired');
        }
        const existing = await client.query(
          'SELECT 1 FROM web_accounts WHERE user_id = $1',
          [code.user_id],
        );
        if (existing.rowCount > 0) {
          throw new HttpError(409, 'web_account_exists', 'Web account is already configured');
        }
        const now = this.clock();
        await client.query(
          `INSERT INTO web_accounts(
             user_id, username, username_key, password_salt, password_hash,
             created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $6)`,
          [code.user_id, username, usernameKey, passwordSalt, passwordHash, now],
        );
        const updated = await client.query(
          `UPDATE users
              SET handle = $1, display_name = $2, nickname_key = $3,
                  profile_revision = profile_revision + 1, updated_at = $4
            WHERE id = $5
            RETURNING *`,
          [
            username,
            displayName,
            displayName.normalize('NFKC').toLowerCase(),
            now,
            code.user_id,
          ],
        );
        await client.query('DELETE FROM web_binding_codes WHERE user_id = $1', [code.user_id]);
        const session = await this._createDeviceSession(client, {
          userId: code.user_id,
          kind: 'web',
          label: 'Web browser',
          prefix: 'web',
        });
        return { token: session.token, user: publicUser(rowToUser(updated.rows[0])) };
      });
    } catch (error) {
      if (error?.code === '23505' && error?.constraint === 'web_accounts_pkey') {
        throw new HttpError(409, 'web_account_exists', 'Web account is already configured');
      }
      if (
        error?.code === '23505' &&
        ['web_accounts_username_key_key', 'users_handle_key'].includes(error.constraint)
      ) {
        throw new HttpError(409, 'username_conflict', 'Username is already in use');
      }
      throw error;
    }
  }

  async upgradeWebAccount({ userId, username, usernameKey, passwordSalt, passwordHash }) {
    try {
      return await this._transaction(async (client) => {
        const userResult = await client.query(
          'SELECT * FROM users WHERE id = $1 FOR UPDATE',
          [userId],
        );
        if (userResult.rowCount === 0) {
          throw new HttpError(404, 'resource_not_found', 'User not found');
        }
        const existing = await client.query(
          'SELECT 1 FROM web_accounts WHERE user_id = $1',
          [userId],
        );
        if (existing.rowCount > 0) {
          throw new HttpError(409, 'web_account_exists', 'Web account is already configured');
        }
        const now = this.clock();
        await client.query(
          `INSERT INTO web_accounts(
             user_id, username, username_key, password_salt, password_hash,
             created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $6)`,
          [userId, username, usernameKey, passwordSalt, passwordHash, now],
        );
        const updated = await client.query(
          `UPDATE users
              SET handle = $1, profile_revision = profile_revision + 1, updated_at = $2
            WHERE id = $3
            RETURNING *`,
          [username, now, userId],
        );
        const session = await this._createDeviceSession(client, {
          userId,
          kind: 'web',
          label: 'Web browser',
          prefix: 'web',
        });
        return { token: session.token, user: publicUser(rowToUser(updated.rows[0])) };
      });
    } catch (error) {
      if (error?.code === '23505' && error?.constraint === 'web_accounts_pkey') {
        throw new HttpError(409, 'web_account_exists', 'Web account is already configured');
      }
      if (
        error?.code === '23505' &&
        ['web_accounts_username_key_key', 'users_handle_key'].includes(error.constraint)
      ) {
        throw new HttpError(409, 'username_conflict', 'Username is already in use');
      }
      throw error;
    }
  }

  async getWebLoginCredentials({ usernameKey }) {
    const result = await this.pool.query(
      `SELECT user_id, username, username_key, password_salt, password_hash,
              created_at, updated_at
         FROM web_accounts
        WHERE username_key = $1`,
      [usernameKey],
    );
    if (result.rowCount === 0) {
      throw new HttpError(401, 'invalid_credentials', 'Username or password is incorrect');
    }
    const row = result.rows[0];
    return {
      userId: row.user_id,
      username: row.username,
      usernameKey: row.username_key,
      passwordSalt: row.password_salt,
      passwordHash: row.password_hash,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }

  async getWebLoginCredentialsByUserId({ userId }) {
    const result = await this.pool.query(
      `SELECT user_id, username, username_key, password_salt, password_hash,
              created_at, updated_at
         FROM web_accounts
        WHERE user_id = $1`,
      [userId],
    );
    if (result.rowCount === 0) {
      throw new HttpError(409, 'web_account_required', 'Web account is not configured');
    }
    const row = result.rows[0];
    return {
      userId: row.user_id,
      username: row.username,
      usernameKey: row.username_key,
      passwordSalt: row.password_salt,
      passwordHash: row.password_hash,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }

  async changeWebPassword({ userId, currentDeviceId, passwordSalt, passwordHash }) {
    await this._transaction(async (client) => {
      const updated = await client.query(
        `UPDATE web_accounts
            SET password_salt = $1, password_hash = $2, updated_at = $3
          WHERE user_id = $4`,
        [passwordSalt, passwordHash, this.clock(), userId],
      );
      if (updated.rowCount === 0) {
        throw new HttpError(409, 'web_account_required', 'Web account is not configured');
      }
      await client.query(
        `DELETE FROM sessions s
         USING user_devices d
         WHERE s.user_id = $1
           AND s.device_id <> $2
           AND d.user_id = s.user_id
           AND d.device_id = s.device_id
           AND d.kind = 'web'`,
        [userId, currentDeviceId],
      );
    });
  }

  async createWebSession({ userId, label }) {
    return this._transaction(async (client) => {
      const result = await client.query('SELECT * FROM users WHERE id = $1', [userId]);
      if (result.rowCount === 0) {
        throw new HttpError(404, 'resource_not_found', 'User not found');
      }
      const session = await this._createDeviceSession(client, {
        userId,
        kind: 'web',
        label,
        prefix: 'web',
      });
      return { token: session.token, user: publicUser(rowToUser(result.rows[0])) };
    });
  }

  async createMcpDeviceSession({ userId, label }) {
    return this._transaction(async (client) => {
      const user = await client.query('SELECT 1 FROM users WHERE id = $1', [userId]);
      if (user.rowCount === 0) {
        throw new HttpError(404, 'resource_not_found', 'User not found');
      }
      return this._createDeviceSession(client, {
        userId,
        kind: 'mcp',
        label,
        prefix: 'ct',
      });
    });
  }

  async listDevices({ userId }) {
    const result = await this.pool.query(
      `SELECT d.user_id, d.device_id, d.kind, d.label,
              EXISTS (
                SELECT 1 FROM sessions s
                 WHERE s.user_id = d.user_id AND s.device_id = d.device_id
              ) AS active
         FROM user_devices d
        WHERE d.user_id = $1
        ORDER BY d.created_at, d.device_id`,
      [userId],
    );
    return result.rows.map((row) => ({
      userId: row.user_id,
      deviceId: row.device_id,
      kind: row.kind,
      label: row.label,
      active: row.active,
    }));
  }

  async revokeDevice({ userId, deviceId }) {
    await this.pool.query(
      'DELETE FROM sessions WHERE user_id = $1 AND device_id = $2',
      [userId, deviceId],
    );
  }

  async issueWebPasswordResetCode({ userId }) {
    return this._transaction((client) => this._issueWebPasswordResetCode(client, userId));
  }

  async resetWebPassword({ usernameKey, resetCode, passwordSalt, passwordHash }) {
    await this._transaction(async (client) => {
      const codeHash = hash(normalizeOneTimeCode(resetCode));
      const result = await client.query(
        `SELECT a.user_id, c.expires_at
           FROM web_accounts a
           JOIN web_password_reset_codes c ON c.user_id = a.user_id
          WHERE a.username_key = $1 AND c.code_hash = $2
          FOR UPDATE OF a, c`,
        [usernameKey, codeHash],
      );
      const row = result.rows[0];
      if (!row || new Date(row.expires_at).getTime() <= this.clock().getTime()) {
        throw new HttpError(400, 'invalid_reset_code', 'Reset code is invalid or expired');
      }
      await client.query(
        `UPDATE web_accounts
            SET password_salt = $1, password_hash = $2, updated_at = $3
          WHERE user_id = $4`,
        [passwordSalt, passwordHash, this.clock(), row.user_id],
      );
      await client.query(
        'DELETE FROM web_password_reset_codes WHERE user_id = $1',
        [row.user_id],
      );
      await client.query(
        `DELETE FROM sessions s
         USING user_devices d
         WHERE s.user_id = $1
           AND d.user_id = s.user_id
           AND d.device_id = s.device_id
           AND d.kind = 'web'`,
        [row.user_id],
      );
    });
  }

  async createProfileResource({ userId, mimeType, content }) {
    const id = newId('resource');
    const createdAt = this.clock();
    await this.pool.query(
      `INSERT INTO profile_resources(
         id, owner_user_id, mime_type, content, byte_size, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, userId, mimeType, content, content.length, createdAt],
    );
    return {
      id,
      mimeType,
      byteSize: content.length,
      createdAt: createdAt.toISOString(),
    };
  }

  async getProfileResource({ resourceId }) {
    const result = await this.pool.query(
      `SELECT id, owner_user_id, mime_type, content, byte_size, created_at
         FROM profile_resources
        WHERE id = $1`,
      [resourceId],
    );
    if (result.rowCount === 0) {
      throw new HttpError(404, 'resource_not_found', 'Profile resource not found');
    }
    const row = result.rows[0];
    return {
      id: row.id,
      ownerUserId: row.owner_user_id,
      mimeType: row.mime_type,
      content: row.content,
      byteSize: row.byte_size,
      createdAt: iso(row.created_at),
    };
  }

  async getMe({ userId }) {
    const result = await this.pool.query(
      'SELECT * FROM users WHERE id = $1',
      [userId],
    );
    if (result.rowCount === 0) {
      throw new HttpError(404, 'resource_not_found', 'User not found');
    }
    return publicUser(rowToUser(result.rows[0]));
  }

  async authenticate(accessToken) {
    const result = await this.pool.query(
      `SELECT u.*, s.device_id AS session_device_id
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1`,
      [hash(accessToken)],
    );
    if (result.rowCount === 0) {
      throw new HttpError(401, 'session_revoked', 'Session is not valid');
    }
    return authenticatedUser(rowToUser(result.rows[0]), result.rows[0].session_device_id);
  }

  async isSessionActive({ userId, deviceId }) {
    const result = await this.pool.query(
      'SELECT 1 FROM sessions WHERE user_id = $1 AND device_id = $2 LIMIT 1',
      [userId, deviceId],
    );
    return result.rowCount > 0;
  }

  async updateMyProfile({
    userId,
    expectedProfileRevision,
    displayName,
    avatarResourceId,
    key,
    requestFingerprint,
  }) {
    try {
      return await this._transaction(async (client) => {
        const result = await client.query(
          'SELECT * FROM users WHERE id = $1 FOR UPDATE',
          [userId],
        );
        const user = result.rows[0];
        const replay = await this._replay(
          client,
          userId,
          'updateMyProfile',
          key,
          requestFingerprint,
        );
        if (replay) return replay;
        if (expectedProfileRevision !==
            safeInteger(user.profile_revision, 'users.profile_revision')) {
          throw new HttpError(409, 'request_version_conflict', 'Profile revision does not match');
        }
        if (avatarResourceId !== undefined) {
          await this._requireOwnedAvatar(client, userId, avatarResourceId);
        }
        const updated = await client.query(
          `UPDATE users
              SET display_name = $1, nickname_key = $2, avatar_resource_id = $3,
                  profile_revision = profile_revision + 1, updated_at = $4
            WHERE id = $5
            RETURNING *`,
          [
            displayName ?? user.display_name,
            displayName === undefined
              ? user.nickname_key
              : displayName.normalize('NFKC').toLowerCase(),
            avatarResourceId === undefined ? user.avatar_resource_id : avatarResourceId,
            this.clock(),
            userId,
          ],
        );
        const body = publicUser(rowToUser(updated.rows[0]));
        await this._saveReplay(client, {
          principalId: userId,
          operation: 'updateMyProfile',
          key,
          requestFingerprint,
          status: 200,
          body,
        });
        await this._enqueueProfileUpdated(client, 'human', userId, body);
        return { status: 200, body };
      });
    } catch (error) {
      if (error?.code === '23505' && error?.constraint === 'users_nickname_key_key') {
        throw new HttpError(409, 'conflict', 'Nickname is already in use');
      }
      throw error;
    }
  }

  async listRooms(userId) {
    const result = await this.pool.query(
      `SELECT r.*,
              COALESCE(w.read_seq, GREATEST(0, m.joined_seq - 1)) AS web_read_seq
         FROM rooms r
         JOIN room_members m ON m.room_id = r.id
         LEFT JOIN web_room_reads w ON w.room_id = r.id AND w.user_id = m.user_id
        WHERE m.user_id = $1
        ORDER BY r.updated_at DESC, r.id`,
      [userId],
    );
    return result.rows.map((row) => {
      const room = rowToRoom(row, true);
      const webReadSeq = safeInteger(row.web_read_seq, 'web_room_reads.read_seq');
      return {
        ...room,
        webReadSeq,
        unreadCount: Math.max(0, room.lastSeq - webReadSeq),
      };
    });
  }

  async updateWebRoomRead({ userId, roomId, readSeq }) {
    return this._transaction(async (client) => {
      const room = await this._room(client, roomId);
      const membership = await this._membership(client, roomId, userId);
      const minimum = Math.max(
        0,
        safeInteger(membership.joined_seq, 'room_members.joined_seq') - 1,
      );
      const lastSeq = safeInteger(room.last_seq, 'rooms.last_seq');
      if (readSeq < minimum || readSeq > lastSeq) {
        throw new HttpError(400, 'invalid_request', 'readSeq is outside visible room history');
      }
      const result = await client.query(
        `INSERT INTO web_room_reads(user_id, room_id, read_seq, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, room_id) DO UPDATE
         SET read_seq = GREATEST(web_room_reads.read_seq, EXCLUDED.read_seq),
             updated_at = EXCLUDED.updated_at
         RETURNING read_seq`,
        [userId, roomId, readSeq, this.clock()],
      );
      return {
        roomId,
        webReadSeq: safeInteger(result.rows[0].read_seq, 'web_room_reads.read_seq'),
      };
    });
  }

  async listRoomsPage({ userId, afterRoomId, limit }) {
    const result = await this.pool.query(
      `SELECT r.*
         FROM rooms r
         JOIN room_members m ON m.room_id = r.id
        WHERE m.user_id = $1 AND ($2::text IS NULL OR r.id > $2)
        ORDER BY r.id
        LIMIT $3`,
      [userId, afterRoomId, limit + 1],
    );
    const items = result.rows.slice(0, limit).map((row) => rowToRoom(row));
    return {
      items,
      nextRoomId: result.rows.length > limit ? items[items.length - 1].id : null,
    };
  }

  async createAgentProfile({
    userId,
    displayName,
    avatarResourceId,
    shortBio,
    key,
    requestFingerprint,
  }) {
    return this._transaction(async (client) => {
      await this._requireOwnedAvatar(client, userId, avatarResourceId);
      const replay = await this._replay(
        client,
        userId,
        'createAgentProfile',
        key,
        requestFingerprint,
      );
      if (replay) return replay;
      const now = this.clock();
      const inserted = await client.query(
        `INSERT INTO agent_profiles(
           id, owner_user_id, display_name, avatar_resource_id, short_bio,
           profile_revision, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, 1, $6, $6)
         RETURNING *`,
        [newId('agent'), userId, displayName, avatarResourceId, shortBio, now],
      );
      const body = rowToAgentProfile(inserted.rows[0]);
      await this._saveReplay(client, {
        principalId: userId,
        operation: 'createAgentProfile',
        key,
        requestFingerprint,
        status: 201,
        body,
      });
      return { status: 201, body };
    });
  }

  async listAgentProfiles({ userId }) {
    const result = await this.pool.query(
      `SELECT * FROM agent_profiles
        WHERE owner_user_id = $1
        ORDER BY created_at, id`,
      [userId],
    );
    return result.rows.map(rowToAgentProfile);
  }

  async getAgentProfile({ agentProfileId }) {
    const result = await this.pool.query(
      'SELECT * FROM agent_profiles WHERE id = $1',
      [agentProfileId],
    );
    if (result.rowCount === 0) {
      throw new HttpError(404, 'resource_not_found', 'Agent profile not found');
    }
    return rowToAgentProfile(result.rows[0]);
  }

  async updateAgentProfile({
    userId,
    agentProfileId,
    expectedProfileRevision,
    changes,
    key,
    requestFingerprint,
  }) {
    return this._transaction(async (client) => {
      const result = await client.query(
        'SELECT * FROM agent_profiles WHERE id = $1 FOR UPDATE',
        [agentProfileId],
      );
      if (result.rowCount === 0) {
        throw new HttpError(404, 'resource_not_found', 'Agent profile not found');
      }
      const profile = result.rows[0];
      if (profile.owner_user_id !== userId) {
        throw new HttpError(403, 'forbidden', 'Agent profile owner required');
      }
      if (Object.hasOwn(changes, 'avatarResourceId')) {
        await this._requireOwnedAvatar(client, userId, changes.avatarResourceId);
      }
      const replay = await this._replay(
        client,
        userId,
        'updateAgentProfile',
        key,
        requestFingerprint,
      );
      if (replay) return replay;
      if (expectedProfileRevision !==
          safeInteger(profile.profile_revision, 'agent_profiles.profile_revision')) {
        throw new HttpError(409, 'request_version_conflict', 'Profile revision does not match');
      }
      const updated = await client.query(
        `UPDATE agent_profiles
            SET display_name = $1, avatar_resource_id = $2, short_bio = $3,
                profile_revision = profile_revision + 1, updated_at = $4
          WHERE id = $5
          RETURNING *`,
        [
          Object.hasOwn(changes, 'displayName') ? changes.displayName : profile.display_name,
          Object.hasOwn(changes, 'avatarResourceId')
            ? changes.avatarResourceId
            : profile.avatar_resource_id,
          Object.hasOwn(changes, 'shortBio') ? changes.shortBio : profile.short_bio,
          this.clock(),
          agentProfileId,
        ],
      );
      const body = rowToAgentProfile(updated.rows[0]);
      await this._saveReplay(client, {
        principalId: userId,
        operation: 'updateAgentProfile',
        key,
        requestFingerprint,
        status: 200,
        body,
      });
      await this._enqueueProfileUpdated(client, 'agent', userId, body);
      return { status: 200, body };
    });
  }

  async deleteAgentProfile({ userId, agentProfileId }) {
    return this._transaction(async (client) => {
      const profile = await client.query(
        'SELECT owner_user_id FROM agent_profiles WHERE id = $1 FOR UPDATE',
        [agentProfileId],
      );
      if (profile.rowCount === 0) {
        throw new HttpError(404, 'resource_not_found', 'Agent profile not found');
      }
      if (profile.rows[0].owner_user_id !== userId) {
        throw new HttpError(403, 'forbidden', 'Agent profile owner required');
      }
      await client.query(
        'DELETE FROM room_agent_bindings WHERE agent_profile_id = $1',
        [agentProfileId],
      );
      await client.query('DELETE FROM agent_profiles WHERE id = $1', [agentProfileId]);
      return { status: 204 };
    });
  }

  async createRoom({ userId, title, key, requestFingerprint }) {
    return this._transaction(async (client) => {
      const replay = await this._replay(
        client,
        userId,
        'createRoom',
        key,
        requestFingerprint,
      );
      if (replay) return replay;
      const now = this.clock();
      const roomId = newId('room');
      const inserted = await client.query(
        `INSERT INTO rooms(
           id, owner_user_id, title, last_seq, revision,
           history_visibility, created_at, updated_at
         ) VALUES ($1, $2, $3, 0, 1, 'after_join', $4, $4)
         RETURNING *`,
        [roomId, userId, title, now],
      );
      await client.query(
        `INSERT INTO room_members(room_id, user_id, role, joined_seq, read_seq)
         VALUES ($1, $2, 'owner', 0, 0)`,
        [roomId, userId],
      );
      const body = rowToRoom(inserted.rows[0]);
      await this._saveReplay(client, {
        principalId: userId,
        operation: 'createRoom',
        key,
        requestFingerprint,
        status: 201,
        body,
      });
      return { status: 201, body };
    });
  }

  async getRoom({ userId, roomId }) {
    const client = this.pool;
    const room = await this._room(client, roomId);
    await this._membership(client, roomId, userId);
    return rowToRoom(room);
  }

  async listWorldRooms() {
    const result = await this.pool.query(
      `SELECT r.*, u.display_name AS owner_display_name,
              i.expires_at AS world_invite_expires_at,
              i.remaining_uses AS world_invite_remaining_uses
         FROM rooms r
         JOIN users u ON u.id = r.owner_user_id
         JOIN room_invites i ON i.id = r.world_invite_id
        WHERE r.world_published = true
          AND i.revoked_at IS NULL
          AND i.remaining_uses > 0
          AND i.expires_at > $1
        ORDER BY r.world_published_at DESC, r.id`,
      [this.clock()],
    );
    return result.rows.map((row) => rowToWorldRoom(row, false));
  }

  async getWorldRoom({ roomId }) {
    const result = await this.pool.query(
      `SELECT r.*, u.display_name AS owner_display_name,
              i.expires_at AS world_invite_expires_at,
              i.remaining_uses AS world_invite_remaining_uses
         FROM rooms r
         JOIN users u ON u.id = r.owner_user_id
         JOIN room_invites i ON i.id = r.world_invite_id
        WHERE r.id = $1
          AND r.world_published = true
          AND i.revoked_at IS NULL
          AND i.remaining_uses > 0
          AND i.expires_at > $2`,
      [roomId, this.clock()],
    );
    if (result.rowCount === 0) {
      throw new HttpError(404, 'resource_not_found', 'World room not found');
    }
    return rowToWorldRoom(result.rows[0]);
  }

  async updateWorldRoom({ userId, roomId, published, summary }) {
    return this._transaction(async (client) => {
      const roomResult = await client.query(
        'SELECT * FROM rooms WHERE id = $1 FOR UPDATE',
        [roomId],
      );
      if (roomResult.rowCount === 0) {
        throw new HttpError(404, 'resource_not_found', 'Room not found');
      }
      const room = roomResult.rows[0];
      if (room.owner_user_id !== userId) {
        throw new HttpError(403, 'forbidden', 'Room owner required');
      }
      const now = this.clock();
      if (!published) {
        if (room.world_invite_id) {
          await client.query(
            'UPDATE room_invites SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL',
            [now, room.world_invite_id],
          );
        }
        const updated = await client.query(
          `UPDATE rooms
              SET world_published = false, world_invite_id = NULL,
                  world_invite_token = NULL, world_published_at = NULL,
                  revision = revision + 1, updated_at = $1
            WHERE id = $2 RETURNING *`,
          [now, roomId],
        );
        return { room: rowToRoom(updated.rows[0], true), world: null };
      }

      let invite = null;
      let token = room.world_invite_token;
      if (room.world_invite_id) {
        const inviteResult = await client.query(
          'SELECT * FROM room_invites WHERE id = $1',
          [room.world_invite_id],
        );
        invite = inviteResult.rows[0] ?? null;
      }
      if (!invite || invite.revoked_at !== null || invite.remaining_uses <= 0 ||
          new Date(invite.expires_at).getTime() <= now.getTime() || !token) {
        token = randomBytes(16).toString('base64url');
        const expiresAt = new Date(now.getTime() + WORLD_INVITE_LIFETIME_MS);
        const inserted = await client.query(
          `INSERT INTO room_invites(
             id, room_id, created_by_user_id, token_hash, expires_at,
             max_uses, remaining_uses, created_at, revoked_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $6, $7, NULL)
           RETURNING *`,
          [newId('invite'), roomId, userId, hash(token), expiresAt, WORLD_INVITE_MAX_USES, now],
        );
        invite = inserted.rows[0];
      }
      const updated = await client.query(
        `UPDATE rooms
            SET world_published = true, world_summary = $1,
                world_invite_id = $2, world_invite_token = $3,
                world_published_at = COALESCE(world_published_at, $4),
                revision = revision + 1, updated_at = $4
          WHERE id = $5 RETURNING *`,
        [summary, invite.id, token, now, roomId],
      );
      const owner = await client.query('SELECT display_name FROM users WHERE id = $1', [userId]);
      return {
        room: rowToRoom(updated.rows[0], true),
        world: rowToWorldRoom({
          ...updated.rows[0],
          owner_display_name: owner.rows[0].display_name,
          world_invite_expires_at: invite.expires_at,
          world_invite_remaining_uses: invite.remaining_uses,
        }),
      };
    });
  }

  async deleteRoom({ userId, roomId }) {
    await this._transaction(async (client) => {
      const room = await this._room(client, roomId, { lock: true });
      if (room.owner_user_id !== userId) {
        throw new HttpError(403, 'forbidden', 'Room owner required');
      }
      const members = await client.query(
        'SELECT user_id FROM room_members WHERE room_id = $1',
        [roomId],
      );
      const recipientUserIds = members.rows.map((row) => row.user_id);
      await client.query(
        'DELETE FROM outbox_events WHERE room_id = $1 AND dispatched_at IS NULL',
        [roomId],
      );
      // Remove messages first because messages.generation_request_id is a non-cascading FK.
      await client.query('DELETE FROM messages WHERE room_id = $1', [roomId]);
      await client.query('DELETE FROM generation_requests WHERE room_id = $1', [roomId]);
      await client.query('DELETE FROM rooms WHERE id = $1', [roomId]);
      await client.query(
        `INSERT INTO outbox_events(
           event_id, event_type, room_id, payload, occurred_at, dispatched_at
         ) VALUES ($1, 'room.deleted', $2, $3, $4, NULL)`,
        [newId('evt'), roomId, { recipientUserIds }, this.clock()],
      );
    });
  }

  async getMembership({ userId, roomId }) {
    await this._room(this.pool, roomId);
    const result = await this.pool.query(
      `SELECT m.*, u.display_name, u.avatar_resource_id
         FROM room_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.room_id = $1 AND m.user_id = $2`,
      [roomId, userId],
    );
    if (result.rowCount === 0) {
      throw new HttpError(403, 'forbidden', 'Room membership required');
    }
    return rowToMembership(result.rows[0], true);
  }

  async listMembers({ userId, roomId }) {
    const room = await this._room(this.pool, roomId);
    await this._membership(this.pool, roomId, userId);
    const result = await this.pool.query(
      `SELECT m.*, u.display_name, u.avatar_resource_id
         FROM room_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.room_id = $1
        ORDER BY m.joined_seq, m.user_id`,
      [roomId],
    );
    return {
      items: result.rows.map((row) => rowToMembership(row, false)),
      roomRevision: safeInteger(room.revision, 'rooms.revision'),
    };
  }

  async getRoomContext({ userId, roomId }) {
    const room = await this._room(this.pool, roomId);
    await this._membership(this.pool, roomId, userId);
    const [members, agentBindings] = await Promise.all([
      this.pool.query(
        `SELECT m.*, u.display_name, u.avatar_resource_id
           FROM room_members m
           JOIN users u ON u.id = m.user_id
          WHERE m.room_id = $1
          ORDER BY m.joined_seq, m.user_id`,
        [roomId],
      ),
      this.pool.query(
        `SELECT b.*,
                p.id AS context_profile_id,
                p.owner_user_id AS context_profile_owner_user_id,
                p.display_name AS context_profile_display_name,
                p.avatar_resource_id AS context_profile_avatar_resource_id,
                p.short_bio AS context_profile_short_bio,
                p.profile_revision AS agent_profile_revision,
                p.display_name AS agent_display_name,
                p.avatar_resource_id AS agent_avatar_resource_id,
                p.created_at AS context_profile_created_at,
                p.updated_at AS context_profile_updated_at
           FROM room_agent_bindings b
           JOIN agent_profiles p ON p.id = b.agent_profile_id
          WHERE b.room_id = $1
          ORDER BY b.owner_user_id`,
        [roomId],
      ),
    ]);
    return {
      room: rowToRoom(room),
      members: members.rows.map((row) => rowToMembership(row, false)),
      agentBindings: agentBindings.rows.map(rowToContextAgentBinding),
    };
  }

  async getMyRoomAgentBinding({ userId, roomId }) {
    await this._room(this.pool, roomId);
    await this._membership(this.pool, roomId, userId);
    const result = await this.pool.query(
      `SELECT * FROM room_agent_bindings
        WHERE room_id = $1 AND owner_user_id = $2`,
      [roomId, userId],
    );
    if (result.rowCount === 0) {
      throw new HttpError(404, 'resource_not_found', 'Room agent binding not found');
    }
    return rowToRoomAgentBinding(result.rows[0]);
  }

  async listRoomAgentBindings({ userId, roomId }) {
    await this._room(this.pool, roomId);
    await this._membership(this.pool, roomId, userId);
    const result = await this.pool.query(
      `SELECT b.*,
              p.profile_revision AS agent_profile_revision,
              p.display_name AS agent_display_name,
              p.avatar_resource_id AS agent_avatar_resource_id
         FROM room_agent_bindings b
         JOIN agent_profiles p ON p.id = b.agent_profile_id
        WHERE b.room_id = $1
        ORDER BY b.owner_user_id`,
      [roomId],
    );
    return { items: result.rows.map(rowToPublicRoomAgentBinding) };
  }

  async putMyRoomAgentBinding({
    userId,
    roomId,
    agentProfileId,
    participationMode,
    publishMode,
    triggerScope,
    preferredRuntimeDeviceId,
    generationLimitPer24h,
    expectedPolicyRevision,
    key,
    requestFingerprint,
  }) {
    return this._transaction(async (client) => {
      await this._room(client, roomId);
      await this._membership(client, roomId, userId, { lock: true });
      const replay = await this._replay(
        client,
        userId,
        'putMyRoomAgentBinding',
        key,
        requestFingerprint,
      );
      if (replay) return replay;
      const profileResult = await client.query(
        'SELECT * FROM agent_profiles WHERE id = $1',
        [agentProfileId],
      );
      if (profileResult.rowCount === 0) {
        throw new HttpError(404, 'resource_not_found', 'Agent profile not found');
      }
      if (profileResult.rows[0].owner_user_id !== userId) {
        throw new HttpError(403, 'forbidden', 'Agent profile owner required');
      }
      if (preferredRuntimeDeviceId !== null) {
        const device = await client.query(
          'SELECT 1 FROM user_devices WHERE user_id = $1 AND device_id = $2',
          [userId, preferredRuntimeDeviceId],
        );
        if (device.rowCount === 0) {
          throw new HttpError(403, 'forbidden', 'Preferred runtime device owner required');
        }
      }
      const existing = await client.query(
        `SELECT * FROM room_agent_bindings
          WHERE room_id = $1 AND owner_user_id = $2
          FOR UPDATE`,
        [roomId, userId],
      );
      let status;
      let changed;
      if (existing.rowCount > 0) {
        const binding = existing.rows[0];
        if (expectedPolicyRevision !==
            safeInteger(binding.policy_revision, 'room_agent_bindings.policy_revision')) {
          throw new HttpError(409, 'request_version_conflict', 'Binding revision does not match');
        }
        changed = await client.query(
          `UPDATE room_agent_bindings
              SET agent_profile_id = $1, participation_mode = $2, publish_mode = $3,
                  trigger_scope = $4, preferred_runtime_device_id = $5,
                  generation_limit_per_24h = $6,
                  policy_revision = policy_revision + 1, updated_at = $7
            WHERE id = $8
            RETURNING *`,
          [
            agentProfileId,
            participationMode,
            publishMode,
            triggerScope,
            preferredRuntimeDeviceId,
            generationLimitPer24h,
            this.clock(),
            binding.id,
          ],
        );
        status = 200;
      } else {
        if (expectedPolicyRevision !== null) {
          throw new HttpError(409, 'request_version_conflict', 'Binding does not exist');
        }
        changed = await client.query(
          `INSERT INTO room_agent_bindings(
             id, room_id, owner_user_id, agent_profile_id, participation_mode,
             publish_mode, trigger_scope, preferred_runtime_device_id,
             generation_limit_per_24h, policy_revision, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10)
           RETURNING *`,
          [
            newId('binding'),
            roomId,
            userId,
            agentProfileId,
            participationMode,
            publishMode,
            triggerScope,
            preferredRuntimeDeviceId,
            generationLimitPer24h,
            this.clock(),
          ],
        );
        status = 201;
      }
      const body = rowToRoomAgentBinding(changed.rows[0]);
      await this._saveReplay(client, {
        principalId: userId,
        operation: 'putMyRoomAgentBinding',
        key,
        requestFingerprint,
        status,
        body,
      });
      return { status, body };
    });
  }

  async deleteMyRoomAgentBinding({
    userId,
    roomId,
    expectedPolicyRevision,
    key,
    requestFingerprint,
  }) {
    return this._transaction(async (client) => {
      await this._room(client, roomId);
      await this._membership(client, roomId, userId, { lock: true });
      const replay = await this._replay(
        client,
        userId,
        'deleteMyRoomAgentBinding',
        key,
        requestFingerprint,
      );
      if (replay) return replay;
      const result = await client.query(
        `SELECT * FROM room_agent_bindings
          WHERE room_id = $1 AND owner_user_id = $2
          FOR UPDATE`,
        [roomId, userId],
      );
      if (result.rowCount === 0) {
        throw new HttpError(404, 'resource_not_found', 'Room agent binding not found');
      }
      const binding = result.rows[0];
      if (expectedPolicyRevision !==
          safeInteger(binding.policy_revision, 'room_agent_bindings.policy_revision')) {
        throw new HttpError(409, 'request_version_conflict', 'Binding revision does not match');
      }
      await client.query('DELETE FROM room_agent_bindings WHERE id = $1', [binding.id]);
      await this._saveReplay(client, {
        principalId: userId,
        operation: 'deleteMyRoomAgentBinding',
        key,
        requestFingerprint,
        status: 204,
        body: null,
      });
      return { status: 204, body: null };
    });
  }

  async putMyAgentRuntime({
    user,
    roomId,
    deviceId,
    readiness,
    readyForBindingPolicyRevision,
    runtimeCapabilitiesVersion,
    localConfigRevision,
    key,
    requestFingerprint,
  }) {
    return this._transaction(async (client) => {
      await this._room(client, roomId);
      await this._membership(client, roomId, user.userId);
      if (deviceId !== user.deviceId) {
        throw new HttpError(403, 'forbidden', 'Runtime device must match the session');
      }
      const bindingResult = await client.query(
        `SELECT * FROM room_agent_bindings
          WHERE room_id = $1 AND owner_user_id = $2
          FOR UPDATE`,
        [roomId, user.userId],
      );
      if (bindingResult.rowCount === 0) {
        throw new HttpError(404, 'resource_not_found', 'Room agent binding not found');
      }
      const replay = await this._replay(
        client,
        user.userId,
        'putMyAgentRuntime',
        key,
        requestFingerprint,
      );
      if (replay) return replay;
      const binding = bindingResult.rows[0];
      const policyRevision = safeInteger(
        binding.policy_revision,
        'room_agent_bindings.policy_revision',
      );
      if (
        (readiness === 'ready' && readyForBindingPolicyRevision !== policyRevision) ||
        (readiness === 'notReady' && readyForBindingPolicyRevision !== null)
      ) {
        throw new HttpError(
          409,
          'request_version_conflict',
          'Runtime policy revision does not match',
        );
      }
      const changed = await client.query(
        `INSERT INTO agent_runtimes(
           binding_id, owner_user_id, device_id, readiness,
           ready_for_binding_policy_revision, runtime_capabilities_version,
           local_config_revision, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (binding_id, device_id) DO UPDATE
           SET readiness = EXCLUDED.readiness,
               ready_for_binding_policy_revision = EXCLUDED.ready_for_binding_policy_revision,
               runtime_capabilities_version = EXCLUDED.runtime_capabilities_version,
               local_config_revision = EXCLUDED.local_config_revision,
               updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [
          binding.id,
          user.userId,
          deviceId,
          readiness,
          readyForBindingPolicyRevision,
          runtimeCapabilitiesVersion,
          localConfigRevision,
          this.clock(),
        ],
      );
      const now = this.clock();
      if (readiness === 'ready' && binding.preferred_runtime_device_id === deviceId) {
        const leaseIsActive = Boolean(
          binding.runtime_lease_device_id &&
          binding.runtime_lease_id &&
          binding.runtime_lease_expires_at &&
          new Date(binding.runtime_lease_expires_at).getTime() > now.getTime()
        );
        if (leaseIsActive && binding.runtime_lease_device_id !== deviceId) {
          throw new HttpError(
            409,
            'lease_conflict',
            'Agent runtime lease is held by another device',
          );
        }
        await client.query(
          `UPDATE room_agent_bindings
              SET runtime_lease_device_id = $1,
                  runtime_lease_id = $2,
                  runtime_lease_epoch = $3,
                  runtime_lease_expires_at = $4
            WHERE id = $5`,
          [
            deviceId,
            leaseIsActive ? binding.runtime_lease_id : newId('agent-lease'),
            leaseIsActive
              ? safeInteger(binding.runtime_lease_epoch, 'room_agent_bindings.runtime_lease_epoch')
              : safeInteger(
                binding.runtime_lease_epoch,
                'room_agent_bindings.runtime_lease_epoch',
              ) + 1,
            new Date(now.getTime() + AGENT_RUNTIME_LEASE_DURATION_MS),
            binding.id,
          ],
        );
      } else if (
        readiness === 'notReady' &&
        binding.runtime_lease_device_id === deviceId
      ) {
        await client.query(
          `UPDATE room_agent_bindings
              SET runtime_lease_expires_at = NULL
            WHERE id = $1`,
          [binding.id],
        );
      }
      const body = rowToAgentRuntime(changed.rows[0]);
      await this._saveReplay(client, {
        principalId: user.userId,
        operation: 'putMyAgentRuntime',
        key,
        requestFingerprint,
        status: 200,
        body,
      });
      return { status: 200, body };
    });
  }

  async activateMyAgent({
    user,
    roomId,
    publicProfile,
    triggerScope = 'allMessages',
    runtimeCapabilitiesVersion,
    localConfigRevision,
  }) {
    return this._transaction(async (client) => {
      await this._requireOwnedAvatar(client, user.userId, publicProfile.avatarResourceId);
      await this._room(client, roomId);
      await this._membership(client, roomId, user.userId, { lock: true });
      const now = this.clock();
      const existing = await client.query(
        `SELECT * FROM room_agent_bindings
          WHERE room_id = $1 AND owner_user_id = $2
          FOR UPDATE`,
        [roomId, user.userId],
      );
      let profile;
      let binding;
      if (existing.rowCount > 0) {
        binding = existing.rows[0];
        const profileResult = await client.query(
          'SELECT * FROM agent_profiles WHERE id = $1 FOR UPDATE',
          [binding.agent_profile_id],
        );
        profile = profileResult.rows[0];
        if (
          profile.display_name !== publicProfile.displayName ||
          profile.avatar_resource_id !== publicProfile.avatarResourceId ||
          profile.short_bio !== publicProfile.shortBio
        ) {
          const updatedProfile = await client.query(
            `UPDATE agent_profiles
                SET display_name = $1, avatar_resource_id = $2, short_bio = $3,
                    profile_revision = profile_revision + 1, updated_at = $4
              WHERE id = $5
              RETURNING *`,
            [
              publicProfile.displayName,
              publicProfile.avatarResourceId,
              publicProfile.shortBio,
              now,
              profile.id,
            ],
          );
          profile = updatedProfile.rows[0];
        }
      } else {
        const insertedProfile = await client.query(
          `INSERT INTO agent_profiles(
             id, owner_user_id, display_name, avatar_resource_id, short_bio,
             profile_revision, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, 1, $6, $6)
           RETURNING *`,
          [
            newId('agent'),
            user.userId,
            publicProfile.displayName,
            publicProfile.avatarResourceId,
            publicProfile.shortBio,
            now,
          ],
        );
        profile = insertedProfile.rows[0];
        const insertedBinding = await client.query(
          `INSERT INTO room_agent_bindings(
             id, room_id, owner_user_id, agent_profile_id, participation_mode,
             publish_mode, trigger_scope, preferred_runtime_device_id,
             generation_limit_per_24h, policy_revision, updated_at
           ) VALUES ($1, $2, $3, $4, 'automatic', 'automatic', $5,
                     NULL, 1000, 1, $6)
           RETURNING *`,
          [newId('binding'), roomId, user.userId, profile.id, triggerScope, now],
        );
        binding = insertedBinding.rows[0];
      }

      const leaseIsActive = Boolean(
        binding.runtime_lease_device_id &&
        binding.runtime_lease_id &&
        binding.runtime_lease_expires_at &&
        new Date(binding.runtime_lease_expires_at).getTime() > now.getTime()
      );
      if (leaseIsActive && binding.runtime_lease_device_id !== user.deviceId) {
        throw new HttpError(409, 'lease_conflict', 'Agent runtime lease is held by another device');
      }
      const policyChanged =
        binding.participation_mode !== 'automatic' ||
        binding.publish_mode !== 'automatic' ||
        binding.trigger_scope !== triggerScope;
      const leaseId = leaseIsActive ? binding.runtime_lease_id : newId('agent-lease');
      const leaseEpoch = leaseIsActive
        ? safeInteger(binding.runtime_lease_epoch, 'room_agent_bindings.runtime_lease_epoch')
        : safeInteger(binding.runtime_lease_epoch, 'room_agent_bindings.runtime_lease_epoch') + 1;
      const leaseExpiresAt = new Date(now.getTime() + AGENT_RUNTIME_LEASE_DURATION_MS);
      const updatedBinding = await client.query(
        `UPDATE room_agent_bindings
            SET participation_mode = 'automatic', publish_mode = 'automatic',
                trigger_scope = $1, preferred_runtime_device_id = $2,
                policy_revision = policy_revision + $3,
                runtime_lease_device_id = $2, runtime_lease_id = $4,
                runtime_lease_epoch = $5, runtime_lease_expires_at = $6,
                updated_at = CASE WHEN $3 = 1 THEN $7 ELSE updated_at END
          WHERE id = $8
          RETURNING *`,
        [
          triggerScope,
          user.deviceId,
          policyChanged ? 1 : 0,
          leaseId,
          leaseEpoch,
          leaseExpiresAt,
          now,
          binding.id,
        ],
      );
      binding = updatedBinding.rows[0];
      await client.query(
        `INSERT INTO agent_runtimes(
           binding_id, owner_user_id, device_id, readiness,
           ready_for_binding_policy_revision, runtime_capabilities_version,
           local_config_revision, updated_at
         ) VALUES ($1, $2, $3, 'ready', $4, $5, $6, $7)
         ON CONFLICT (binding_id, device_id) DO UPDATE
           SET readiness = 'ready',
               ready_for_binding_policy_revision = EXCLUDED.ready_for_binding_policy_revision,
               runtime_capabilities_version = EXCLUDED.runtime_capabilities_version,
               local_config_revision = EXCLUDED.local_config_revision,
               updated_at = EXCLUDED.updated_at`,
        [
          binding.id,
          user.userId,
          user.deviceId,
          binding.policy_revision,
          runtimeCapabilitiesVersion,
          localConfigRevision,
          now,
        ],
      );
      return rowToAgentActivation(binding, profile);
    });
  }

  async recoverMyAgentRuntime({ user, roomId }) {
    return this._transaction(async (client) => {
      await this._room(client, roomId);
      await this._membership(client, roomId, user.userId, { lock: true });
      const result = await client.query(
        `SELECT * FROM room_agent_bindings
          WHERE room_id = $1 AND owner_user_id = $2
          FOR UPDATE`,
        [roomId, user.userId],
      );
      if (result.rowCount === 0) {
        throw new HttpError(404, 'resource_not_found', 'Room agent binding not found');
      }
      let binding = result.rows[0];
      if (binding.participation_mode === 'off') {
        throw new HttpError(409, 'generation_state_conflict', 'Agent binding is disabled');
      }

      const now = this.clock();
      const leaseIsActive = Boolean(
        binding.runtime_lease_device_id &&
        binding.runtime_lease_id &&
        binding.runtime_lease_expires_at &&
        new Date(binding.runtime_lease_expires_at).getTime() > now.getTime()
      );
      if (leaseIsActive && binding.runtime_lease_device_id !== user.deviceId) {
        throw new HttpError(409, 'lease_conflict', 'Agent runtime lease is held by another device');
      }
      const leaseId = leaseIsActive ? binding.runtime_lease_id : newId('agent-lease');
      const leaseEpoch = leaseIsActive
        ? safeInteger(binding.runtime_lease_epoch, 'room_agent_bindings.runtime_lease_epoch')
        : safeInteger(binding.runtime_lease_epoch, 'room_agent_bindings.runtime_lease_epoch') + 1;
      const updated = await client.query(
        `UPDATE room_agent_bindings
            SET preferred_runtime_device_id = $1, runtime_lease_device_id = $1,
                runtime_lease_id = $2, runtime_lease_epoch = $3,
                runtime_lease_expires_at = $4
          WHERE id = $5
          RETURNING *`,
        [
          user.deviceId,
          leaseId,
          leaseEpoch,
          new Date(now.getTime() + AGENT_RUNTIME_LEASE_DURATION_MS),
          binding.id,
        ],
      );
      binding = updated.rows[0];
      await client.query(
        `INSERT INTO agent_runtimes(
           binding_id, owner_user_id, device_id, readiness,
           ready_for_binding_policy_revision, runtime_capabilities_version,
           local_config_revision, updated_at
         ) VALUES ($1, $2, $3, 'ready', $4, 1, 0, $5)
         ON CONFLICT (binding_id, device_id) DO UPDATE
           SET readiness = 'ready',
               ready_for_binding_policy_revision = EXCLUDED.ready_for_binding_policy_revision,
               updated_at = EXCLUDED.updated_at`,
        [binding.id, user.userId, user.deviceId, binding.policy_revision, now],
      );
      const profile = await client.query(
        'SELECT * FROM agent_profiles WHERE id = $1',
        [binding.agent_profile_id],
      );
      return rowToAgentActivation(binding, profile.rows[0]);
    });
  }

  async heartbeatMyAgent({ user, roomId, leaseId, leaseEpoch }) {
    return this._transaction(async (client) => {
      await this._room(client, roomId);
      await this._membership(client, roomId, user.userId);
      const result = await client.query(
        `SELECT * FROM room_agent_bindings
          WHERE room_id = $1 AND owner_user_id = $2
          FOR UPDATE`,
        [roomId, user.userId],
      );
      if (result.rowCount === 0) {
        throw new HttpError(404, 'resource_not_found', 'Room agent binding not found');
      }
      const binding = result.rows[0];
      const now = this.clock();
      if (
        binding.runtime_lease_device_id !== user.deviceId ||
        binding.runtime_lease_id !== leaseId ||
        safeInteger(binding.runtime_lease_epoch, 'room_agent_bindings.runtime_lease_epoch') !==
          leaseEpoch ||
        !binding.runtime_lease_expires_at ||
        new Date(binding.runtime_lease_expires_at).getTime() <= now.getTime()
      ) {
        throw new HttpError(409, 'lease_conflict', 'Agent runtime lease is not current');
      }
      const updated = await client.query(
        `UPDATE room_agent_bindings
            SET runtime_lease_expires_at = $1
          WHERE id = $2
          RETURNING *`,
        [new Date(now.getTime() + AGENT_RUNTIME_LEASE_DURATION_MS), binding.id],
      );
      await client.query(
        `UPDATE agent_runtimes SET updated_at = $1
          WHERE binding_id = $2 AND device_id = $3`,
        [now, binding.id, user.deviceId],
      );
      const profile = await client.query(
        'SELECT * FROM agent_profiles WHERE id = $1',
        [binding.agent_profile_id],
      );
      return rowToAgentActivation(updated.rows[0], profile.rows[0]);
    });
  }

  async deactivateMyAgent({ user, roomId, leaseId, leaseEpoch }) {
    return this._transaction(async (client) => {
      await this._room(client, roomId);
      await this._membership(client, roomId, user.userId);
      const result = await client.query(
        `SELECT * FROM room_agent_bindings
          WHERE room_id = $1 AND owner_user_id = $2
          FOR UPDATE`,
        [roomId, user.userId],
      );
      if (result.rowCount === 0) {
        throw new HttpError(404, 'resource_not_found', 'Room agent binding not found');
      }
      const binding = result.rows[0];
      if (
        binding.runtime_lease_device_id !== user.deviceId ||
        binding.runtime_lease_id !== leaseId ||
        safeInteger(binding.runtime_lease_epoch, 'room_agent_bindings.runtime_lease_epoch') !==
          leaseEpoch
      ) {
        throw new HttpError(409, 'lease_conflict', 'Agent runtime lease is not current');
      }
      const now = this.clock();
      await client.query(
        `UPDATE room_agent_bindings
            SET preferred_runtime_device_id = NULL,
                runtime_lease_expires_at = NULL
          WHERE id = $1`,
        [binding.id],
      );
      await client.query(
        `UPDATE agent_runtimes
            SET readiness = 'notReady', ready_for_binding_policy_revision = NULL,
                updated_at = $1
          WHERE binding_id = $2 AND device_id = $3`,
        [now, binding.id, user.deviceId],
      );
      return {
        roomId,
        bindingId: binding.id,
        deviceId: user.deviceId,
        leaseEpoch,
        status: 'deactivated',
      };
    });
  }

  async createManualGenerationRequest({
    user,
    roomId,
    clientGenerationRequestId,
    triggerMessageIds,
    expectedBindingPolicyRevision,
    supersedesRequestId = null,
    key,
    requestFingerprint,
  }) {
    return this._transaction(async (client) => {
      const room = await this._room(client, roomId, { lock: true });
      const membership = await this._membership(client, roomId, user.userId);
      const bindingResult = await client.query(
        `SELECT * FROM room_agent_bindings
          WHERE room_id = $1 AND owner_user_id = $2
          FOR UPDATE`,
        [roomId, user.userId],
      );
      if (bindingResult.rowCount === 0) {
        throw new HttpError(404, 'resource_not_found', 'Room agent binding not found');
      }
      const replay = await this._replay(
        client,
        user.userId,
        'createManualGenerationRequest',
        key,
        requestFingerprint,
      );
      if (replay) return replay;
      const binding = bindingResult.rows[0];
      if (binding.participation_mode === 'off') {
        throw new HttpError(409, 'generation_state_conflict', 'Agent binding is disabled');
      }
      if (
        safeInteger(binding.policy_revision, 'room_agent_bindings.policy_revision') !==
        expectedBindingPolicyRevision
      ) {
        throw new HttpError(
          409,
          'request_version_conflict',
          'Binding policy revision does not match',
        );
      }
      const triggerResult = await client.query(
        `SELECT id, seq FROM messages
          WHERE room_id = $1 AND id = ANY($2::text[])`,
        [roomId, triggerMessageIds],
      );
      if (triggerResult.rowCount !== triggerMessageIds.length) {
        throw new HttpError(404, 'resource_not_found', 'Trigger message not found');
      }
      const minVisibleSeq = safeInteger(
        membership.joined_seq,
        'room_members.joined_seq',
      );
      const triggerSequences = triggerResult.rows.map((row) =>
        safeInteger(row.seq, 'messages.seq'));
      if (triggerSequences.some((sequence) => sequence < minVisibleSeq)) {
        throw new HttpError(
          403,
          'history_not_visible',
          'Trigger message is outside membership history',
        );
      }
      if (supersedesRequestId !== null) {
        const supersededResult = await client.query(
          `SELECT * FROM generation_requests
            WHERE id = $1 AND owner_user_id = $2 AND creator_device_id = $3
            FOR UPDATE`,
          [supersedesRequestId, user.userId, user.deviceId],
        );
        if (supersededResult.rowCount === 0) {
          throw new HttpError(
            404,
            'resource_not_found',
            'Superseded generation request not found',
          );
        }
        const superseded = supersededResult.rows[0];
        if (
          superseded.room_id !== roomId ||
          superseded.binding_id !== binding.id ||
          !REGENERATABLE_GENERATION_STATUSES.has(superseded.status) ||
          JSON.stringify(superseded.trigger_message_ids) !== JSON.stringify(triggerMessageIds)
        ) {
          throw new HttpError(
            409,
            'generation_state_conflict',
            'Superseded generation request is not eligible for regeneration',
          );
        }
      }
      const now = this.clock();
      const inserted = await client.query(
        `INSERT INTO generation_requests(
           id, room_id, binding_id, owner_user_id, creator_device_id, source,
           client_generation_request_id, trigger_batch_id, trigger_message_ids,
           trigger_from_seq, trigger_through_seq, context_through_seq,
           min_visible_seq, history_policy_revision, binding_policy_revision,
           status, request_version, claimed_device_id, lease_id, lease_epoch,
           lease_expires_at, draft_device_id, attempt, supersedes_request_id,
           started_at, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, 'manual', $6, NULL, $7, $8, $9, $10,
           $11, $12, $13, 'queued', 1, NULL, NULL, 0, NULL, NULL, 0,
           $14, NULL, $15, $15
         ) RETURNING *`,
        [
          newId('generation'),
          roomId,
          binding.id,
          user.userId,
          user.deviceId,
          clientGenerationRequestId,
          JSON.stringify(triggerMessageIds),
          Math.min(...triggerSequences),
          Math.max(...triggerSequences),
          safeInteger(room.last_seq, 'rooms.last_seq'),
          minVisibleSeq,
          safeInteger(room.revision, 'rooms.revision'),
          expectedBindingPolicyRevision,
          supersedesRequestId,
          now,
        ],
      );
      const body = rowToGenerationRequest(inserted.rows[0]);
      await this._saveReplay(client, {
        principalId: user.userId,
        operation: 'createManualGenerationRequest',
        key,
        requestFingerprint,
        status: 201,
        body,
      });
      return { status: 201, body };
    });
  }

  async createAutomaticGenerationRequest({
    user,
    roomId,
    triggerBatchId,
    triggerMessageIds,
    key,
    requestFingerprint,
    humanTriggersOnly = false,
  }) {
    return this._transaction(async (client) => {
      const room = await this._room(client, roomId, { lock: true });
      const membership = await this._membership(client, roomId, user.userId);
      const bindingResult = await client.query(
        `SELECT * FROM room_agent_bindings
          WHERE room_id = $1 AND owner_user_id = $2
          FOR UPDATE`,
        [roomId, user.userId],
      );
      if (bindingResult.rowCount === 0) {
        throw new HttpError(404, 'resource_not_found', 'Room agent binding not found');
      }
      const replay = await this._replay(
        client,
        user.userId,
        'createAutomaticGenerationRequest',
        key,
        requestFingerprint,
      );
      if (replay) return replay;
      const binding = bindingResult.rows[0];
      if (
        binding.participation_mode !== 'automatic' ||
        binding.publish_mode !== 'automatic'
      ) {
        throw new HttpError(
          409,
          'generation_state_conflict',
          'Agent binding is not enabled for automatic publication',
        );
      }
      if (
        triggerMessageIds.length < 1 ||
        triggerMessageIds.length > 128 ||
        new Set(triggerMessageIds).size !== triggerMessageIds.length
      ) {
        throw new HttpError(400, 'invalid_request', 'Trigger message IDs must contain unique items');
      }
      const triggerResult = await client.query(
        `SELECT id, seq, sender, mentions FROM messages
          WHERE room_id = $1 AND id = ANY($2::text[])`,
        [roomId, triggerMessageIds],
      );
      if (triggerResult.rowCount !== triggerMessageIds.length) {
        throw new HttpError(404, 'resource_not_found', 'Trigger message not found');
      }
      const minVisibleSeq = safeInteger(
        membership.joined_seq,
        'room_members.joined_seq',
      );
      const triggerSequences = triggerResult.rows.map((row) =>
        safeInteger(row.seq, 'messages.seq'));
      if (triggerSequences.some((sequence) => sequence < minVisibleSeq)) {
        throw new HttpError(
          403,
          'history_not_visible',
          'Trigger message is outside membership history',
        );
      }
      requireEligibleAutomaticTriggers({
        triggerScope: binding.trigger_scope,
        agentProfileId: binding.agent_profile_id,
        triggers: triggerResult.rows,
        humanTriggersOnly,
      });
      const bindingPolicyRevision = safeInteger(
        binding.policy_revision,
        'room_agent_bindings.policy_revision',
      );
      const now = this.clock();
      const inserted = await client.query(
        `INSERT INTO generation_requests(
           id, room_id, binding_id, owner_user_id, creator_device_id, source,
           client_generation_request_id, trigger_batch_id, trigger_message_ids,
           trigger_from_seq, trigger_through_seq, context_through_seq,
           min_visible_seq, history_policy_revision, binding_policy_revision,
           status, request_version, claimed_device_id, lease_id, lease_epoch,
           lease_expires_at, draft_device_id, attempt, supersedes_request_id,
           started_at, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, 'automatic', NULL, $6, $7, $8, $9, $10,
           $11, $12, $13, 'queued', 1, NULL, NULL, 0, NULL, NULL, 0,
           NULL, NULL, $14, $14
         ) RETURNING *`,
        [
          newId('generation'),
          roomId,
          binding.id,
          user.userId,
          user.deviceId,
          triggerBatchId,
          JSON.stringify(triggerMessageIds),
          Math.min(...triggerSequences),
          Math.max(...triggerSequences),
          safeInteger(room.last_seq, 'rooms.last_seq'),
          minVisibleSeq,
          safeInteger(room.revision, 'rooms.revision'),
          bindingPolicyRevision,
          now,
        ],
      );
      const body = rowToGenerationRequest(inserted.rows[0]);
      await this._saveReplay(client, {
        principalId: user.userId,
        operation: 'createAutomaticGenerationRequest',
        key,
        requestFingerprint,
        status: 201,
        body,
      });
      return { status: 201, body };
    });
  }

  async listGenerationRequests({ user, statuses, pageToken, limit }) {
    let cursor = null;
    if (pageToken !== null) {
      const cursorResult = await this.pool.query(
        `SELECT created_at, id FROM generation_requests
          WHERE id = $1 AND owner_user_id = $2 AND creator_device_id = $3`,
        [pageToken, user.userId, user.deviceId],
      );
      if (cursorResult.rowCount === 0) {
        throw new HttpError(400, 'invalid_request', 'pageToken is not valid');
      }
      cursor = cursorResult.rows[0];
    }
    const result = await this.pool.query(
      `SELECT * FROM generation_requests
        WHERE owner_user_id = $1 AND creator_device_id = $2
          AND status = ANY($3::text[])
          AND ($4::timestamptz IS NULL OR (created_at, id) < ($4, $5))
        ORDER BY created_at DESC, id DESC
        LIMIT $6`,
      [
        user.userId,
        user.deviceId,
        statuses,
        cursor?.created_at ?? null,
        cursor?.id ?? null,
        limit + 1,
      ],
    );
    return {
      items: result.rows.slice(0, limit).map(rowToGenerationRequest),
      nextPageToken: result.rows.length > limit ? result.rows[limit - 1].id : null,
    };
  }

  async getGenerationRequest({ userId, generationRequestId }) {
    const request = await this._generationRequest(this.pool, generationRequestId);
    if (request.owner_user_id !== userId) {
      throw new HttpError(403, 'forbidden', 'Generation request owner required');
    }
    return rowToGenerationRequest(request);
  }

  async claimGenerationRequest({
    user,
    generationRequestId,
    expectedRequestVersion,
    key,
    requestFingerprint,
  }) {
    return this._transaction(async (client) => {
      const request = await this._generationRequest(client, generationRequestId, { lock: true });
      const replay = await this._replay(
        client,
        user.userId,
        'claimGenerationRequest',
        key,
        requestFingerprint,
      );
      const { binding } = await this._generationContext(
        client,
        request,
        user,
        { ready: true },
      );
      if (
        (request.source === 'manual' && request.creator_device_id !== user.deviceId) ||
        binding.preferred_runtime_device_id !== user.deviceId
      ) {
        throw new HttpError(403, 'forbidden', 'Current device is not eligible to claim');
      }
      const now = this.clock();
      const snapshot = rowToGenerationRequest(request);
      if (replay) {
        requireGenerationStatus(snapshot, 'claimed');
        requireGenerationLease(snapshot, user, snapshot.leaseId, snapshot.leaseEpoch, now);
        return { status: 200, body: snapshot };
      }
      requireGenerationVersion(snapshot, expectedRequestVersion);
      requireGenerationStatus(snapshot, 'queued');
      const changed = await client.query(
        `UPDATE generation_requests
            SET status = 'claimed', request_version = request_version + 1,
                claimed_device_id = $1, lease_id = $2, lease_epoch = lease_epoch + 1,
                lease_expires_at = $3, updated_at = $4
          WHERE id = $5 RETURNING *`,
        [
          user.deviceId,
          newId('lease'),
          new Date(now.getTime() + GENERATION_LEASE_DURATION_MS),
          now,
          generationRequestId,
        ],
      );
      const body = rowToGenerationRequest(changed.rows[0]);
      await this._saveReplay(client, {
        principalId: user.userId,
        operation: 'claimGenerationRequest',
        key,
        requestFingerprint,
        status: 200,
        body,
      });
      return { status: 200, body };
    });
  }

  async startGenerationRequest({
    user,
    generationRequestId,
    expectedRequestVersion,
    leaseId,
    leaseEpoch,
    key,
    requestFingerprint,
  }) {
    return this._transaction(async (client) => {
      const request = await this._generationRequest(client, generationRequestId, { lock: true });
      const replay = await this._replay(
        client,
        user.userId,
        'startGenerationRequest',
        key,
        requestFingerprint,
      );
      const { binding } = await this._generationContext(
        client,
        request,
        user,
        { ready: true },
      );
      const now = this.clock();
      const snapshot = rowToGenerationRequest(request);
      if (replay) {
        requireGenerationStatus(snapshot, 'generating');
        requireGenerationLease(snapshot, user, leaseId, leaseEpoch, now);
        return { status: 200, body: snapshot };
      }
      requireGenerationVersion(snapshot, expectedRequestVersion);
      requireGenerationStatus(snapshot, 'claimed');
      requireGenerationLease(snapshot, user, leaseId, leaseEpoch, now);
      const usage = await client.query(
        `SELECT count(*)::integer AS count, min(started_at) AS earliest
           FROM generation_requests
          WHERE binding_id = $1 AND started_at >= $2`,
        [binding.id, new Date(now.getTime() - 24 * 60 * 60 * 1000)],
      );
      if (usage.rows[0].count >= binding.generation_limit_per_24h) {
        const retryAt = new Date(usage.rows[0].earliest).getTime() + 24 * 60 * 60 * 1000;
        throw new HttpError(
          429,
          'generation_limit_exceeded',
          'Generation limit has been reached',
          { retryAfterSeconds: Math.max(0, Math.ceil((retryAt - now.getTime()) / 1000)) },
        );
      }
      const changed = await client.query(
        `UPDATE generation_requests
            SET status = 'generating', request_version = request_version + 1,
                attempt = attempt + 1, started_at = $1, updated_at = $1
          WHERE id = $2 RETURNING *`,
        [now, generationRequestId],
      );
      const body = rowToGenerationRequest(changed.rows[0]);
      await this._saveReplay(client, {
        principalId: user.userId,
        operation: 'startGenerationRequest',
        key,
        requestFingerprint,
        status: 200,
        body,
      });
      return { status: 200, body };
    });
  }

  async markGenerationReviewPending({
    user,
    generationRequestId,
    expectedRequestVersion,
    leaseId,
    leaseEpoch,
    key,
    requestFingerprint,
  }) {
    return this._transaction(async (client) => {
      const request = await this._generationRequest(client, generationRequestId, { lock: true });
      if (request.owner_user_id !== user.userId) {
        throw new HttpError(403, 'forbidden', 'Generation request owner required');
      }
      const replay = await this._replay(
        client,
        user.userId,
        'markGenerationReviewPending',
        key,
        requestFingerprint,
      );
      if (replay) return replay;
      const { binding } = await this._generationContext(
        client,
        request,
        user,
        { ready: true },
      );
      if (binding.publish_mode !== 'reviewRequired') {
        throw new HttpError(409, 'generation_state_conflict', 'Binding does not require review');
      }
      const snapshot = rowToGenerationRequest(request);
      requireGenerationVersion(snapshot, expectedRequestVersion);
      requireGenerationStatus(snapshot, 'generating');
      requireGenerationLease(snapshot, user, leaseId, leaseEpoch, this.clock());
      const changed = await client.query(
        `UPDATE generation_requests
            SET status = 'review_pending', request_version = request_version + 1,
                draft_device_id = $1, lease_id = NULL, lease_expires_at = NULL,
                updated_at = $2
          WHERE id = $3 RETURNING *`,
        [user.deviceId, this.clock(), generationRequestId],
      );
      const body = rowToGenerationRequest(changed.rows[0]);
      await this._saveReplay(client, {
        principalId: user.userId,
        operation: 'markGenerationReviewPending',
        key,
        requestFingerprint,
        status: 200,
        body,
      });
      return { status: 200, body };
    });
  }

  async failGenerationRequest({
    user,
    generationRequestId,
    expectedRequestVersion,
    leaseId,
    leaseEpoch,
    key,
    requestFingerprint,
  }) {
    return this._transaction(async (client) => {
      const request = await this._generationRequest(client, generationRequestId, { lock: true });
      if (request.owner_user_id !== user.userId) {
        throw new HttpError(403, 'forbidden', 'Generation request owner required');
      }
      const replay = await this._replay(
        client,
        user.userId,
        'failGenerationRequest',
        key,
        requestFingerprint,
      );
      if (replay) return replay;
      const snapshot = rowToGenerationRequest(request);
      requireGenerationVersion(snapshot, expectedRequestVersion);
      requireGenerationStatus(snapshot, 'generating');
      requireGenerationLease(snapshot, user, leaseId, leaseEpoch, this.clock());
      const changed = await client.query(
        `UPDATE generation_requests
            SET status = 'failed', request_version = request_version + 1,
                lease_id = NULL, lease_expires_at = NULL, updated_at = $1
          WHERE id = $2 RETURNING *`,
        [this.clock(), generationRequestId],
      );
      const body = rowToGenerationRequest(changed.rows[0]);
      await this._saveReplay(client, {
        principalId: user.userId,
        operation: 'failGenerationRequest',
        key,
        requestFingerprint,
        status: 200,
        body,
      });
      return { status: 200, body };
    });
  }

  async discardGenerationRequest({
    user,
    generationRequestId,
    expectedRequestVersion,
    key,
    requestFingerprint,
  }) {
    return this._transaction(async (client) => {
      const request = await this._generationRequest(client, generationRequestId, { lock: true });
      if (request.owner_user_id !== user.userId) {
        throw new HttpError(403, 'forbidden', 'Generation request owner required');
      }
      const replay = await this._replay(
        client,
        user.userId,
        'discardGenerationRequest',
        key,
        requestFingerprint,
      );
      if (replay) return replay;
      const snapshot = rowToGenerationRequest(request);
      requireGenerationVersion(snapshot, expectedRequestVersion);
      requireGenerationStatus(snapshot, 'review_pending');
      if (request.draft_device_id !== user.deviceId) {
        throw new HttpError(403, 'forbidden', 'Draft device required');
      }
      const changed = await client.query(
        `UPDATE generation_requests
            SET status = 'discarded', request_version = request_version + 1,
                updated_at = $1
          WHERE id = $2 RETURNING *`,
        [this.clock(), generationRequestId],
      );
      const body = rowToGenerationRequest(changed.rows[0]);
      await this._saveReplay(client, {
        principalId: user.userId,
        operation: 'discardGenerationRequest',
        key,
        requestFingerprint,
        status: 200,
        body,
      });
      return { status: 200, body };
    });
  }

  async publishGenerationRequest({
    user,
    generationRequestId,
    expectedRequestVersion,
    expectedBindingPolicyRevision,
    clientMessageId,
    text,
    mentions,
    replyToMessageId,
    leaseId,
    leaseEpoch,
    key,
    requestFingerprint,
    automatic = false,
    precedingHumanMessage = null,
  }) {
    return this._transaction(async (client) => {
      const request = await this._generationRequest(client, generationRequestId, { lock: true });
      if (request.owner_user_id !== user.userId) {
        throw new HttpError(403, 'forbidden', 'Generation request owner required');
      }
      const operation = automatic
        ? 'publishAutomaticGenerationRequest'
        : 'publishGenerationRequest';
      const replay = await this._replay(
        client,
        user.userId,
        operation,
        key,
        requestFingerprint,
      );
      if (replay) return replay;
      const { room, membership, binding } = await this._generationContext(
        client,
        request,
        user,
        { ready: true },
      );
      const snapshot = rowToGenerationRequest(request);
      requireGenerationVersion(snapshot, expectedRequestVersion);
      if (automatic) {
        if (request.source !== 'automatic' || binding.publish_mode !== 'automatic') {
          throw new HttpError(
            409,
            'generation_state_conflict',
            'Generation request is not eligible for automatic publication',
          );
        }
        requireGenerationStatus(snapshot, 'generating');
        requireGenerationLease(snapshot, user, leaseId, leaseEpoch, this.clock());
      } else {
        requireGenerationStatus(snapshot, 'review_pending');
        if (request.draft_device_id !== user.deviceId) {
          throw new HttpError(403, 'forbidden', 'Draft device required');
        }
        if (leaseId !== null || leaseEpoch !== null) {
          throw new HttpError(
            409,
            'generation_state_conflict',
            'Review publication must not use a lease',
          );
        }
      }
      const currentPolicyRevision = safeInteger(
        binding.policy_revision,
        'room_agent_bindings.policy_revision',
      );
      if (
        expectedBindingPolicyRevision !== snapshot.bindingPolicyRevision ||
        expectedBindingPolicyRevision !== currentPolicyRevision
      ) {
        throw new HttpError(
          409,
          'request_version_conflict',
          'Binding policy revision does not match',
        );
      }
      if (precedingHumanMessage?.clientMessageId === clientMessageId) {
        throw new HttpError(409, 'conflict', 'Client message ID is already in use');
      }
      const clientMessageIds = [
        clientMessageId,
        ...(precedingHumanMessage === null
          ? []
          : [precedingHumanMessage.clientMessageId]),
      ];
      const existing = await client.query(
        `SELECT 1 FROM messages
          WHERE generation_request_id = $1
             OR (room_id = $2 AND client_message_id = ANY($3::text[]))`,
        [generationRequestId, request.room_id, clientMessageIds],
      );
      if (existing.rowCount > 0) {
        throw new HttpError(409, 'conflict', 'Generation or client message is already published');
      }
      if (precedingHumanMessage === null) {
        const loopState = await client.query(
          `WITH cycle AS (
             SELECT COALESCE((
               SELECT seq FROM messages
                WHERE room_id = $1 AND sender->>'kind' = 'human'
                ORDER BY seq DESC
                LIMIT 1
             ), 0) AS start_seq
           )
           SELECT
             COUNT(*) FILTER (WHERE m.sender->>'kind' = 'agent') AS ai_count,
             COUNT(*) FILTER (
               WHERE m.sender->>'kind' = 'agent' AND m.sender->>'userId' = $2
             ) AS owner_ai_count,
             (
               SELECT COUNT(*) FROM room_agent_bindings
                WHERE room_id = $1 AND participation_mode = 'automatic'
             ) AS enabled_agent_count
             FROM messages m CROSS JOIN cycle c
            WHERE m.room_id = $1 AND m.seq > c.start_seq`,
          [request.room_id, user.userId],
        );
        const aiCount = safeInteger(loopState.rows[0].ai_count, 'AI message count');
        const ownerAiCount = safeInteger(
          loopState.rows[0].owner_ai_count,
          'Agent message count',
        );
        const enabledAgentCount = safeInteger(
          loopState.rows[0].enabled_agent_count,
          'Enabled agent count',
        );
        if (
          binding.trigger_scope === 'allMessages' &&
          aiCount >= ABSOLUTE_CONSECUTIVE_AI_LIMIT
        ) {
          throw new HttpError(
            409,
            'agent_loop_limit_reached',
            'Room consecutive AI message limit reached; wait for a human message',
          );
        }
        if (
          binding.trigger_scope !== 'allMessages' &&
          ownerAiCount >= AGENT_MESSAGES_PER_CYCLE_LIMIT
        ) {
          throw new HttpError(
            409,
            'agent_loop_limit_reached',
            'Agent reply already published for the current human cycle; stop the current assistant turn',
          );
        }
        const roomLimit = Math.min(
          Math.max(enabledAgentCount, 1) * AGENT_MESSAGES_PER_CYCLE_LIMIT,
          ABSOLUTE_CONSECUTIVE_AI_LIMIT,
        );
        if (binding.trigger_scope !== 'allMessages' && aiCount >= roomLimit) {
          throw new HttpError(
            409,
            'agent_loop_limit_reached',
            'Room AI message limit reached for the current human cycle',
          );
        }
      }
      const allMentions = [...(precedingHumanMessage?.mentions ?? []), ...mentions];
      const mentionedUserIds = [...new Set(
        allMentions
          .filter((mention) => mention.kind === 'user')
          .map((mention) => mention.targetId),
      )];
      if (mentionedUserIds.length > 0) {
        const targets = await client.query(
          `SELECT user_id FROM room_members
            WHERE room_id = $1 AND user_id = ANY($2::text[])`,
          [request.room_id, mentionedUserIds],
        );
        if (targets.rowCount !== mentionedUserIds.length) {
          throw new HttpError(400, 'invalid_request', 'Mention target is not a room member');
        }
      }
      const mentionedAgentIds = [...new Set(
        allMentions
          .filter((mention) => mention.kind === 'agent')
          .map((mention) => mention.targetId),
      )];
      if (mentionedAgentIds.length > 0) {
        const targets = await client.query(
          `SELECT agent_profile_id FROM room_agent_bindings
            WHERE room_id = $1 AND agent_profile_id = ANY($2::text[])`,
          [request.room_id, mentionedAgentIds],
        );
        if (targets.rowCount !== mentionedAgentIds.length) {
          throw new HttpError(400, 'invalid_request', 'Mentioned agent is not visible in the room');
        }
      }
      if (replyToMessageId !== null) {
        const target = await client.query(
          'SELECT seq FROM messages WHERE id = $1 AND room_id = $2',
          [replyToMessageId, request.room_id],
        );
        if (target.rowCount === 0) {
          throw new HttpError(404, 'resource_not_found', 'Reply target not found');
        }
        if (
          safeInteger(target.rows[0].seq, 'messages.seq') <
          safeInteger(membership.joined_seq, 'room_members.joined_seq')
        ) {
          throw new HttpError(
            403,
            'history_not_visible',
            'Reply target is outside membership history',
          );
        }
      }
      if (precedingHumanMessage?.replyToMessageId) {
        const target = await client.query(
          'SELECT seq FROM messages WHERE id = $1 AND room_id = $2',
          [precedingHumanMessage.replyToMessageId, request.room_id],
        );
        if (target.rowCount === 0) {
          throw new HttpError(404, 'resource_not_found', 'Reply target not found');
        }
        if (
          safeInteger(target.rows[0].seq, 'messages.seq') <
          safeInteger(membership.joined_seq, 'room_members.joined_seq')
        ) {
          throw new HttpError(
            403,
            'history_not_visible',
            'Reply target is outside membership history',
          );
        }
      }
      const profileResult = await client.query(
        'SELECT * FROM agent_profiles WHERE id = $1',
        [binding.agent_profile_id],
      );
      if (profileResult.rowCount === 0) {
        throw new HttpError(404, 'resource_not_found', 'Agent profile not found');
      }
      const profile = profileResult.rows[0];
      const now = this.clock();
      const firstSeq = safeInteger(room.last_seq, 'rooms.last_seq') + 1;
      const humanMessage = precedingHumanMessage === null
        ? null
        : {
            id: newId('msg'),
            roomId: request.room_id,
            seq: firstSeq,
            clientMessageId: precedingHumanMessage.clientMessageId,
            sender: {
              kind: 'human',
              userId: user.userId,
              displayNameSnapshot: user.displayName,
              avatarResourceIdSnapshot: user.avatarResourceId,
            },
            content: {
              schemaVersion: 1,
              type: 'text',
              text: precedingHumanMessage.text,
            },
            mentions: precedingHumanMessage.mentions,
            replyToMessageId: precedingHumanMessage.replyToMessageId,
            createdAt: now.toISOString(),
          };
      if (humanMessage !== null) {
        await client.query(
          `INSERT INTO messages(
             id, room_id, seq, client_message_id, sender, content, mentions,
             reply_to_message_id, generation_request_id, trigger_through_seq, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, NULL, $9)`,
          [
            humanMessage.id,
            humanMessage.roomId,
            humanMessage.seq,
            humanMessage.clientMessageId,
            humanMessage.sender,
            humanMessage.content,
            JSON.stringify(humanMessage.mentions),
            humanMessage.replyToMessageId,
            now,
          ],
        );
      }
      const seq = firstSeq + (humanMessage === null ? 0 : 1);
      const message = {
        id: newId('msg'),
        roomId: request.room_id,
        seq,
        clientMessageId,
        sender: {
          kind: 'agent',
          userId: user.userId,
          agentProfileId: profile.id,
          displayNameSnapshot: profile.display_name,
          avatarResourceIdSnapshot: profile.avatar_resource_id,
        },
        content: { schemaVersion: 1, type: 'text', text },
        mentions,
        replyToMessageId,
        generationRequestId,
        triggerThroughSeq: snapshot.triggerThroughSeq,
        createdAt: now.toISOString(),
      };
      await client.query(
        `INSERT INTO messages(
           id, room_id, seq, client_message_id, sender, content, mentions,
           reply_to_message_id, generation_request_id, trigger_through_seq,
           created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          message.id,
          message.roomId,
          seq,
          clientMessageId,
          message.sender,
          message.content,
          JSON.stringify(mentions),
          replyToMessageId,
          generationRequestId,
          snapshot.triggerThroughSeq,
          now,
        ],
      );
      await client.query('UPDATE rooms SET last_seq = $1 WHERE id = $2', [seq, request.room_id]);
      const changed = await client.query(
        `UPDATE generation_requests
            SET status = 'published', request_version = request_version + 1,
                lease_id = CASE WHEN $3 THEN NULL ELSE lease_id END,
                lease_expires_at = CASE WHEN $3 THEN NULL ELSE lease_expires_at END,
                updated_at = $1
          WHERE id = $2 RETURNING *`,
        [now, generationRequestId, automatic],
      );
      const body = {
        generationRequest: rowToGenerationRequest(changed.rows[0]),
        message,
        ...(humanMessage === null ? {} : { humanMessage }),
      };
      await this._saveReplay(client, {
        principalId: user.userId,
        operation,
        key,
        requestFingerprint,
        status: 200,
        body,
      });
      if (humanMessage !== null) {
        await client.query(
          `INSERT INTO outbox_events(
             event_id, event_type, room_id, payload, occurred_at, dispatched_at
           ) VALUES ($1, 'message.created', $2, $3, $4, NULL)`,
          [newId('evt'), request.room_id, humanMessage, now],
        );
      }
      await client.query(
        `INSERT INTO outbox_events(
           event_id, event_type, room_id, payload, occurred_at, dispatched_at
         ) VALUES ($1, 'message.created', $2, $3, $4, NULL)`,
        [newId('evt'), request.room_id, message, now],
      );
      return { status: 200, body };
    });
  }

  async publishAutomaticGenerationRequest(parameters) {
    return this.publishGenerationRequest({ ...parameters, automatic: true });
  }

  async listInvites({ userId, roomId }) {
    await this._room(this.pool, roomId);
    await this._membership(this.pool, roomId, userId, { manager: true });
    const result = await this.pool.query(
      `SELECT * FROM room_invites
        WHERE room_id = $1
          AND revoked_at IS NULL
          AND remaining_uses > 0
          AND expires_at > $2
        ORDER BY created_at DESC`,
      [roomId, this.clock()],
    );
    return result.rows.map(rowToInvite);
  }

  async createInvite({
    userId,
    roomId,
    expectedRoomRevision,
    expiresAt,
    maxUses,
    key,
    requestFingerprint,
  }) {
    return this._transaction(async (client) => {
      const room = await this._room(client, roomId, { lock: true });
      await this._membership(client, roomId, userId, { manager: true });
      const replay = await this._replay(
        client,
        userId,
        'createRoomInvite',
        key,
        requestFingerprint,
      );
      if (replay) return replay;
      if (expectedRoomRevision !== safeInteger(room.revision, 'rooms.revision')) {
        throw new HttpError(409, 'request_version_conflict', 'Room revision does not match');
      }
      const now = this.clock();
      const token = randomBytes(16).toString('base64url');
      const inserted = await client.query(
        `INSERT INTO room_invites(
           id, room_id, created_by_user_id, token_hash, expires_at,
           max_uses, remaining_uses, created_at, revoked_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $6, $7, NULL)
         RETURNING *`,
        [newId('invite'), roomId, userId, hash(token), new Date(expiresAt), maxUses, now],
      );
      const body = { ...rowToInvite(inserted.rows[0]), inviteToken: token };
      await this._saveReplay(client, {
        principalId: userId,
        operation: 'createRoomInvite',
        key,
        requestFingerprint,
        status: 201,
        body,
      });
      return { status: 201, body };
    });
  }

  async revokeInvite({ userId, roomId, inviteId, key, requestFingerprint }) {
    return this._transaction(async (client) => {
      await this._room(client, roomId);
      await this._membership(client, roomId, userId, { manager: true });
      const replay = await this._replay(
        client,
        userId,
        'revokeRoomInvite',
        key,
        requestFingerprint,
      );
      if (replay) return replay;
      const result = await client.query(
        `SELECT * FROM room_invites
          WHERE id = $1 AND room_id = $2
          FOR UPDATE`,
        [inviteId, roomId],
      );
      if (result.rowCount === 0) {
        throw new HttpError(404, 'resource_not_found', 'Invite not found');
      }
      const invite = result.rows[0];
      if (invite.revoked_at || invite.remaining_uses <= 0 || invite.expires_at <= this.clock()) {
        throw new HttpError(409, 'conflict', 'Invite is no longer active');
      }
      await client.query(
        'UPDATE room_invites SET revoked_at = $1 WHERE id = $2',
        [this.clock(), inviteId],
      );
      await this._saveReplay(client, {
        principalId: userId,
        operation: 'revokeRoomInvite',
        key,
        requestFingerprint,
        status: 204,
        body: null,
      });
      return { status: 204, body: null };
    });
  }

  async invitePreview({ inviteToken }) {
    return this._transaction(async (client) => {
      const result = await client.query(
        `SELECT i.*, r.title AS room_title, r.owner_user_id,
                u.display_name AS inviter_display_name
           FROM room_invites i
           JOIN rooms r ON r.id = i.room_id
           JOIN users u ON u.id = i.created_by_user_id
          WHERE i.token_hash = $1`,
        [hash(inviteToken)],
      );
      if (result.rowCount === 0) {
        throw new HttpError(404, 'resource_not_found', 'Invite is not valid or has expired');
      }
      const row = result.rows[0];
      if (row.revoked_at || row.remaining_uses <= 0 || row.expires_at <= this.clock()) {
        throw new HttpError(404, 'resource_not_found', 'Invite is not valid or has expired');
      }
      return {
        roomTitle: row.room_title,
        inviterDisplayName: row.inviter_display_name,
        expiresAt: row.expires_at.toISOString(),
        remainingUses: row.remaining_uses,
      };
    });
  }

  async acceptInvite({ userId, inviteToken, key, requestFingerprint }) {
    return this._transaction(async (client) => {
      const replay = await this._replay(
        client,
        userId,
        'acceptRoomInvite',
        key,
        requestFingerprint,
      );
      if (replay) return replay;
      const inviteResult = await client.query(
        'SELECT * FROM room_invites WHERE token_hash = $1 FOR UPDATE',
        [hash(inviteToken)],
      );
      if (inviteResult.rowCount === 0) {
        throw new HttpError(409, 'conflict', 'Invite is not valid');
      }
      const invite = inviteResult.rows[0];
      if (invite.revoked_at || invite.remaining_uses <= 0 || invite.expires_at <= this.clock()) {
        throw new HttpError(409, 'conflict', 'Invite is not valid');
      }
      let room = await this._room(client, invite.room_id, { lock: true });
      let membership = await client.query(
        'SELECT * FROM room_members WHERE room_id = $1 AND user_id = $2',
        [room.id, userId],
      );
      if (membership.rowCount === 0) {
        const joinedSeq = room.history_visibility === 'from_start'
          ? 1
          : safeInteger(room.last_seq, 'rooms.last_seq') + 1;
        membership = await client.query(
          `INSERT INTO room_members(room_id, user_id, role, joined_seq, read_seq)
           VALUES ($1, $2, 'member', $3, $4)
           RETURNING *`,
          [room.id, userId, joinedSeq, joinedSeq - 1],
        );
        await client.query(
          'UPDATE room_invites SET remaining_uses = remaining_uses - 1 WHERE id = $1',
          [invite.id],
        );
        const updatedRoom = await client.query(
          `UPDATE rooms
              SET revision = revision + 1, updated_at = $1
            WHERE id = $2
            RETURNING *`,
          [this.clock(), room.id],
        );
        room = updatedRoom.rows[0];
      }
      const user = await client.query(
        'SELECT display_name, avatar_resource_id FROM users WHERE id = $1',
        [userId],
      );
      const memberRow = {
        ...membership.rows[0],
        display_name: user.rows[0].display_name,
        avatar_resource_id: user.rows[0].avatar_resource_id,
      };
      const body = {
        room: rowToRoom(room),
        membership: rowToMembership(memberRow, true),
      };
      await this._saveReplay(client, {
        principalId: userId,
        operation: 'acceptRoomInvite',
        key,
        requestFingerprint,
        status: 200,
        body,
      });
      return { status: 200, body };
    });
  }

  async listMessages({ userId, roomId, afterSeq, limit }) {
    const room = await this._room(this.pool, roomId);
    const membership = await this._membership(this.pool, roomId, userId);
    const highWaterSeq = safeInteger(room.last_seq, 'rooms.last_seq');
    const result = await this.pool.query(
      `SELECT * FROM messages
        WHERE room_id = $1 AND seq > $2 AND seq >= $3 AND seq <= $4
        ORDER BY seq
        LIMIT $5`,
      [
        roomId,
        afterSeq,
        safeInteger(membership.joined_seq, 'room_members.joined_seq'),
        highWaterSeq,
        limit + 1,
      ],
    );
    return {
      items: result.rows.slice(0, limit).map(rowToMessage),
      highWaterSeq,
      hasMore: result.rows.length > limit,
    };
  }

  async listWebMessages({ userId, roomId, beforeSeq, limit }) {
    const room = await this._room(this.pool, roomId);
    const membership = await this._membership(this.pool, roomId, userId);
    const highWaterSeq = safeInteger(room.last_seq, 'rooms.last_seq');
    const upperBound = beforeSeq ?? highWaterSeq + 1;
    const result = await this.pool.query(
      `SELECT * FROM messages
        WHERE room_id = $1 AND seq < $2 AND seq >= $3 AND seq <= $4
        ORDER BY seq DESC
        LIMIT $5`,
      [
        roomId,
        upperBound,
        safeInteger(membership.joined_seq, 'room_members.joined_seq'),
        highWaterSeq,
        limit + 1,
      ],
    );
    const items = result.rows.slice(0, limit).reverse().map(rowToMessage);
    return {
      items,
      highWaterSeq,
      hasMore: result.rows.length > limit,
      nextBeforeSeq: items.length > 0 ? items[0].seq : null,
    };
  }

  async createHumanMessage({
    user,
    roomId,
    clientMessageId,
    text,
    mentions,
    replyToMessageId,
    key,
    requestFingerprint,
  }) {
    return this._transaction(async (client) => {
      const room = await this._room(client, roomId, { lock: true });
      const membership = await this._membership(client, roomId, user.userId);
      const replay = await this._replay(
        client,
        user.userId,
        'createHumanMessage',
        key,
        requestFingerprint,
      );
      if (replay) return replay;
      const mentionedUserIds = mentions
        .filter((mention) => mention.kind === 'user')
        .map((mention) => mention.targetId);
      if (mentionedUserIds.length > 0) {
        const targets = await client.query(
          `SELECT user_id FROM room_members
            WHERE room_id = $1 AND user_id = ANY($2::text[])`,
          [roomId, mentionedUserIds],
        );
        if (targets.rowCount !== mentionedUserIds.length) {
          throw new HttpError(400, 'invalid_request', 'Mention target is not a room member');
        }
      }
      const mentionedAgentIds = mentions
        .filter((mention) => mention.kind === 'agent')
        .map((mention) => mention.targetId);
      if (mentionedAgentIds.length > 0) {
        const targets = await client.query(
          `SELECT agent_profile_id FROM room_agent_bindings
            WHERE room_id = $1 AND agent_profile_id = ANY($2::text[])`,
          [roomId, mentionedAgentIds],
        );
        if (targets.rowCount !== mentionedAgentIds.length) {
          throw new HttpError(400, 'invalid_request', 'Mentioned agent is not visible in the room');
        }
      }
      if (replyToMessageId) {
        const target = await client.query(
          'SELECT seq FROM messages WHERE id = $1 AND room_id = $2',
          [replyToMessageId, roomId],
        );
        if (target.rowCount === 0) {
          throw new HttpError(404, 'resource_not_found', 'Reply target not found');
        }
        if (safeInteger(target.rows[0].seq, 'messages.seq') <
            safeInteger(membership.joined_seq, 'room_members.joined_seq')) {
          throw new HttpError(403, 'history_not_visible', 'Reply target is outside membership history');
        }
      }
      const now = this.clock();
      const seq = safeInteger(room.last_seq, 'rooms.last_seq') + 1;
      const message = {
        id: newId('msg'),
        roomId,
        seq,
        clientMessageId,
        sender: {
          kind: 'human',
          userId: user.userId,
          displayNameSnapshot: user.displayName,
          avatarResourceIdSnapshot: user.avatarResourceId,
        },
        content: { schemaVersion: 1, type: 'text', text },
        mentions,
        replyToMessageId,
        createdAt: now.toISOString(),
      };
      await client.query(
        `INSERT INTO messages(
           id, room_id, seq, client_message_id, sender, content, mentions,
           reply_to_message_id, generation_request_id, trigger_through_seq, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, NULL, $9)`,
        [
          message.id,
          roomId,
          seq,
          clientMessageId,
          message.sender,
          message.content,
          JSON.stringify(mentions),
          replyToMessageId,
          now,
        ],
      );
      await client.query('UPDATE rooms SET last_seq = $1 WHERE id = $2', [seq, roomId]);
      await this._saveReplay(client, {
        principalId: user.userId,
        operation: 'createHumanMessage',
        key,
        requestFingerprint,
        status: 201,
        body: message,
      });
      await client.query(
        `INSERT INTO outbox_events(
           event_id, event_type, room_id, payload, occurred_at, dispatched_at
         ) VALUES ($1, 'message.created', $2, $3, $4, NULL)`,
        [newId('evt'), roomId, message, now],
      );
      return { status: 201, body: message };
    });
  }

  async recallMessage({ userId, roomId, messageId }) {
    return this._transaction(async (client) => {
      await this._room(client, roomId);
      await this._membership(client, roomId, userId);
      const result = await client.query(
        'SELECT * FROM messages WHERE id = $1 AND room_id = $2 FOR UPDATE',
        [messageId, roomId],
      );
      if (result.rowCount === 0) {
        throw new HttpError(404, 'resource_not_found', 'Message not found');
      }
      const message = result.rows[0];
      if (message.sender.userId !== userId) {
        throw new HttpError(403, 'forbidden', 'Message sender owner required');
      }
      if (message.recalled_at) return rowToMessage(message);
      const now = this.clock();
      if (now.getTime() - new Date(message.created_at).getTime() > MESSAGE_RECALL_WINDOW_MS) {
        throw new HttpError(409, 'recall_window_expired', 'Message recall window has expired');
      }
      const updated = await client.query(
        `UPDATE messages
            SET content = $1, mentions = '[]'::jsonb,
                reply_to_message_id = NULL, recalled_at = $2
          WHERE id = $3
          RETURNING *`,
        [{ schemaVersion: 1, type: 'text', text: '' }, now, messageId],
      );
      const body = rowToMessage(updated.rows[0]);
      await client.query(
        `INSERT INTO outbox_events(
           event_id, event_type, room_id, payload, occurred_at, dispatched_at
         ) VALUES ($1, 'message.recalled', $2, $3, $4, NULL)`,
        [newId('evt'), roomId, body, now],
      );
      return body;
    });
  }

  async handoffToRoom({
    user,
    title,
    contextSummary,
    decisions,
    openQuestions,
    invite,
    key,
    requestFingerprint,
  }) {
    return this._transaction(async (client) => {
      const replay = await this._replay(
        client,
        user.userId,
        'handoffToRoom',
        key,
        requestFingerprint,
      );
      if (replay) return replay;
      const text = assembleHandoffMessage({ contextSummary, decisions, openQuestions });
      const now = this.clock();
      const roomId = newId('room');
      const roomInserted = await client.query(
        `INSERT INTO rooms(
           id, owner_user_id, title, last_seq, revision,
           history_visibility, created_at, updated_at
         ) VALUES ($1, $2, $3, 1, 1, 'from_start', $4, $4)
         RETURNING *`,
        [roomId, user.userId, title, now],
      );
      await client.query(
        `INSERT INTO room_members(room_id, user_id, role, joined_seq, read_seq)
         VALUES ($1, $2, 'owner', 0, 0)`,
        [roomId, user.userId],
      );
      const message = {
        id: newId('msg'),
        roomId,
        seq: 1,
        clientMessageId: handoffMessageId(key),
        sender: {
          kind: 'human',
          userId: user.userId,
          displayNameSnapshot: user.displayName,
          avatarResourceIdSnapshot: user.avatarResourceId,
        },
        content: { schemaVersion: 1, type: 'text', text },
        mentions: [],
        replyToMessageId: null,
        createdAt: now.toISOString(),
      };
      await client.query(
        `INSERT INTO messages(
           id, room_id, seq, client_message_id, sender, content, mentions,
           reply_to_message_id, generation_request_id, trigger_through_seq, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, NULL, $9)`,
        [
          message.id,
          roomId,
          1,
          message.clientMessageId,
          message.sender,
          message.content,
          JSON.stringify([]),
          null,
          now,
        ],
      );
      const token = randomBytes(16).toString('base64url');
      const inviteInserted = await client.query(
        `INSERT INTO room_invites(
           id, room_id, created_by_user_id, token_hash, expires_at,
           max_uses, remaining_uses, created_at, revoked_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $6, $7, NULL)
         RETURNING *`,
        [
          newId('invite'),
          roomId,
          user.userId,
          hash(token),
          new Date(invite.expiresAt),
          invite.maxUses,
          now,
        ],
      );
      const body = {
        room: rowToRoom(roomInserted.rows[0]),
        message,
        invite: { ...rowToInvite(inviteInserted.rows[0]), inviteToken: token },
      };
      await this._saveReplay(client, {
        principalId: user.userId,
        operation: 'handoffToRoom',
        key,
        requestFingerprint,
        status: 201,
        body,
      });
      await client.query(
        `INSERT INTO outbox_events(
           event_id, event_type, room_id, payload, occurred_at, dispatched_at
         ) VALUES ($1, 'message.created', $2, $3, $4, NULL)`,
        [newId('evt'), roomId, message, now],
      );
      return { status: 201, body };
    });
  }

  async listPendingOutboxEvents(limit = 100) {
    const result = await this.pool.query(
      `SELECT id, event_id, event_type, room_id, payload, occurred_at
         FROM outbox_events
        WHERE dispatched_at IS NULL
        ORDER BY id
        LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      outboxId: String(row.id),
      event: {
        protocolVersion: 1,
        eventId: row.event_id,
        type: row.event_type,
        occurredAt: iso(row.occurred_at),
        ...(row.room_id ? { roomId: row.room_id } : {}),
        payload: row.payload,
      },
    }));
  }

  async markOutboxDispatched(outboxId) {
    await this.pool.query(
      'UPDATE outbox_events SET dispatched_at = $1 WHERE id = $2 AND dispatched_at IS NULL',
      [this.clock(), outboxId],
    );
  }

  async listRealtimeRecipientUserIds(roomId, messageSeq) {
    const result = await this.pool.query(
      `SELECT user_id FROM room_members
        WHERE room_id = $1 AND joined_seq <= $2`,
      [roomId, messageSeq],
    );
    return result.rows.map((row) => row.user_id);
  }

  async listProfileRecipientUserIds(ownerUserId) {
    const result = await this.pool.query(
      `SELECT DISTINCT target.user_id
         FROM room_members owner
         JOIN room_members target ON target.room_id = owner.room_id
        WHERE owner.user_id = $1
       UNION SELECT $1`,
      [ownerUserId],
    );
    return result.rows.map((row) => row.user_id);
  }
}
