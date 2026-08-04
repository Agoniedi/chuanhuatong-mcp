import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import pg from 'pg';

import { PostgresGroupChatStore } from '../src/group_chat_store.mjs';

describe('PostgreSQL group chat storage', () => {
  it('fails closed when DATABASE_URL is missing', async () => {
    await assert.rejects(
      PostgresGroupChatStore.connect({ connectionString: '' }),
      /DATABASE_URL is required/,
    );
  });

  it(
    'migrates legacy empty-object mentions to a constrained JSON array',
    { skip: !process.env.TEST_DATABASE_URL },
    async () => {
      const baseUrl = process.env.TEST_DATABASE_URL;
      const schema = `chuanhuatong_test_${randomBytes(8).toString('hex')}`;
      const admin = new pg.Pool({ connectionString: baseUrl });
      await admin.query(`CREATE SCHEMA "${schema}"`);

      const isolatedUrl = new URL(baseUrl);
      isolatedUrl.searchParams.set('options', `-csearch_path=${schema}`);
      const legacy = new pg.Pool({ connectionString: isolatedUrl.toString() });
      let store;
      try {
        const initialSql = await readFile(
          new URL('../migrations/001_initial.sql', import.meta.url),
          'utf8',
        );
        await legacy.query(initialSql);
        await legacy.query("INSERT INTO schema_migrations(version) VALUES ('001_initial')");
        await legacy.query(
          `INSERT INTO users(
             id, device_id, handle, display_name, nickname_key,
             avatar_resource_id, profile_revision, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, NULL, 1, now(), now())`,
          ['legacy-user', 'legacy-device', 'legacy', 'Legacy', 'legacy'],
        );
        await legacy.query(
          `INSERT INTO rooms(
             id, owner_user_id, title, last_seq, revision, created_at, updated_at
           ) VALUES ($1, $2, $3, 1, 1, now(), now())`,
          ['legacy-room', 'legacy-user', 'Legacy room'],
        );
        await legacy.query(
          `INSERT INTO messages(
             id, room_id, seq, client_message_id, sender, content, mentions, created_at
           ) VALUES ($1, $2, 1, $3, $4, $5, $6, now())`,
          [
            'legacy-message',
            'legacy-room',
            'legacy-client-message',
            { kind: 'human', userId: 'legacy-user' },
            { schemaVersion: 1, type: 'text', text: 'Legacy message' },
            {},
          ],
        );

        store = await PostgresGroupChatStore.connect({
          connectionString: isolatedUrl.toString(),
          migrate: true,
          logger: { info() {} },
        });
        const migrated = await legacy.query(
          `SELECT mentions, jsonb_typeof(mentions) AS mentions_type
             FROM messages WHERE id = $1`,
          ['legacy-message'],
        );
        assert.deepEqual(migrated.rows[0].mentions, []);
        assert.equal(migrated.rows[0].mentions_type, 'array');
        await assert.rejects(
          legacy.query('UPDATE messages SET mentions = $1 WHERE id = $2', [
            {},
            'legacy-message',
          ]),
          (error) => error.constraint === 'messages_mentions_array',
        );
      } finally {
        await store?.close().catch(() => {});
        await legacy.end();
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      }
    },
  );

  it(
    'atomically consumes a single-use room invite under concurrent joins',
    { skip: !process.env.TEST_DATABASE_URL },
    async () => {
      const baseUrl = process.env.TEST_DATABASE_URL;
      const schema = `chuanhuatong_test_${randomBytes(8).toString('hex')}`;
      const admin = new pg.Pool({ connectionString: baseUrl });
      await admin.query(`CREATE SCHEMA "${schema}"`);

      const isolatedUrl = new URL(baseUrl);
      isolatedUrl.searchParams.set('options', `-csearch_path=${schema}`);
      let store;
      try {
        store = await PostgresGroupChatStore.connect({
          connectionString: isolatedUrl.toString(),
          migrate: true,
          logger: { info() {} },
        });
        const owner = await store.createGuestSession({
          deviceId: 'postgres-invite-owner-device',
          displayName: 'Postgres Invite Owner',
        });
        const firstJoiner = await store.createGuestSession({
          deviceId: 'postgres-invite-first-device',
          displayName: 'Postgres Invite First',
        });
        const secondJoiner = await store.createGuestSession({
          deviceId: 'postgres-invite-second-device',
          displayName: 'Postgres Invite Second',
        });
        const room = await store.createRoom({
          userId: owner.user.userId,
          title: 'Single-use invite room',
          key: 'postgres-invite-room',
          requestFingerprint: 'postgres-invite-room-fingerprint',
        });
        const invite = await store.createInvite({
          userId: owner.user.userId,
          roomId: room.body.id,
          expectedRoomRevision: room.body.revision,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          maxUses: 1,
          key: 'postgres-single-use-invite',
          requestFingerprint: 'postgres-single-use-invite-fingerprint',
        });
        const joinRequests = [firstJoiner, secondJoiner].map((session, index) => ({
          userId: session.user.userId,
          inviteToken: invite.body.inviteToken,
          key: `postgres-concurrent-join-${index}`,
          requestFingerprint: `postgres-concurrent-join-${index}-fingerprint`,
        }));
        const results = await Promise.allSettled(
          joinRequests.map((request) => store.acceptInvite(request)),
        );

        assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
        assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
        const winnerIndex = results.findIndex((result) => result.status === 'fulfilled');
        const loserIndex = winnerIndex === 0 ? 1 : 0;
        assert.equal(results[loserIndex].reason.code, 'conflict');
        assert.deepEqual(
          await store.acceptInvite(joinRequests[winnerIndex]),
          results[winnerIndex].value,
        );
        assert.deepEqual(
          (await store.listRooms(joinRequests[winnerIndex].userId)).map((item) => item.id),
          [room.body.id],
        );
        assert.deepEqual(await store.listRooms(joinRequests[loserIndex].userId), []);
      } finally {
        await store?.close().catch(() => {});
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      }
    },
  );

  it(
    'persists identity, rooms, messages, agent bindings, idempotency, and outbox',
    { skip: !process.env.TEST_DATABASE_URL },
    async () => {
      const baseUrl = process.env.TEST_DATABASE_URL;
      const schema = `chuanhuatong_test_${randomBytes(8).toString('hex')}`;
      const admin = new pg.Pool({ connectionString: baseUrl });
      await admin.query(`CREATE SCHEMA "${schema}"`);

      const isolatedUrl = new URL(baseUrl);
      isolatedUrl.searchParams.set('options', `-csearch_path=${schema}`);
      let store;
      try {
        store = await PostgresGroupChatStore.connect({
          connectionString: isolatedUrl.toString(),
          migrate: true,
          logger: { info() {} },
        });
        const session = await store.createGuestSession({
          deviceId: 'postgres-device-alice',
          displayName: 'Postgres Alice',
        });
        const roomRequest = {
          userId: session.user.userId,
          title: 'Persistent room',
          key: 'create-room-once',
          requestFingerprint: 'room-fingerprint',
        };
        const [roomResult, concurrentReplay] = await Promise.all([
          store.createRoom(roomRequest),
          store.createRoom(roomRequest),
        ]);
        assert.deepEqual(concurrentReplay, roomResult);
        const profileRequest = {
          userId: session.user.userId,
          displayName: 'Persistent Agent',
          avatarResourceId: null,
          shortBio: 'Public profile data',
          key: 'create-agent-profile-once',
          requestFingerprint: 'agent-profile-fingerprint',
        };
        const [profileResult, profileReplay] = await Promise.all([
          store.createAgentProfile(profileRequest),
          store.createAgentProfile(profileRequest),
        ]);
        assert.deepEqual(profileReplay, profileResult);
        const bindingResult = await store.putMyRoomAgentBinding({
          userId: session.user.userId,
          roomId: roomResult.body.id,
          agentProfileId: profileResult.body.id,
          participationMode: 'manual',
          publishMode: 'reviewRequired',
          triggerScope: 'mentionsOnly',
          preferredRuntimeDeviceId: 'postgres-device-alice',
          generationLimitPer24h: 25,
          expectedPolicyRevision: null,
          key: 'create-room-agent-binding-once',
          requestFingerprint: 'room-agent-binding-fingerprint',
        });
        const updatedProfile = await store.updateAgentProfile({
          userId: session.user.userId,
          agentProfileId: profileResult.body.id,
          expectedProfileRevision: 1,
          changes: { shortBio: 'Updated public profile data' },
          key: 'update-agent-profile-once',
          requestFingerprint: 'updated-agent-profile-fingerprint',
        });
        assert.equal(updatedProfile.body.profileRevision, 2);
        const messageResult = await store.createHumanMessage({
          user: session.user,
          roomId: roomResult.body.id,
          clientMessageId: 'persistent-message',
          text: 'Survives restart',
          mentions: [],
          replyToMessageId: null,
          key: 'persistent-message',
          requestFingerprint: 'message-fingerprint',
        });
        assert.equal((await store.listPendingOutboxEvents()).length, 1);
        const authenticated = await store.authenticate(session.accessToken);
        const runtimeResult = await store.putMyAgentRuntime({
          user: authenticated,
          roomId: roomResult.body.id,
          deviceId: 'postgres-device-alice',
          readiness: 'ready',
          readyForBindingPolicyRevision: bindingResult.body.policyRevision,
          runtimeCapabilitiesVersion: 1,
          localConfigRevision: 1,
          key: 'postgres-runtime-ready',
          requestFingerprint: 'postgres-runtime-fingerprint',
        });
        assert.equal(runtimeResult.body.readiness, 'ready');
        const generationResult = await store.createManualGenerationRequest({
          user: authenticated,
          roomId: roomResult.body.id,
          clientGenerationRequestId: 'postgres-generation-request',
          triggerMessageIds: [messageResult.body.id],
          expectedBindingPolicyRevision: bindingResult.body.policyRevision,
          key: 'postgres-generation-request',
          requestFingerprint: 'postgres-generation-fingerprint',
        });
        const claimed = await store.claimGenerationRequest({
          user: authenticated,
          generationRequestId: generationResult.body.id,
          expectedRequestVersion: 1,
          key: 'postgres-generation-claim',
          requestFingerprint: 'postgres-generation-claim-fingerprint',
        });
        const leaseCommand = {
          user: authenticated,
          generationRequestId: generationResult.body.id,
          leaseId: claimed.body.leaseId,
          leaseEpoch: claimed.body.leaseEpoch,
        };
        const started = await store.startGenerationRequest({
          ...leaseCommand,
          expectedRequestVersion: 2,
          key: 'postgres-generation-start',
          requestFingerprint: 'postgres-generation-start-fingerprint',
        });
        assert.equal(started.body.status, 'generating');
        const review = await store.markGenerationReviewPending({
          ...leaseCommand,
          expectedRequestVersion: 3,
          key: 'postgres-generation-review',
          requestFingerprint: 'postgres-generation-review-fingerprint',
        });
        const publishRequest = {
          user: authenticated,
          generationRequestId: generationResult.body.id,
          expectedRequestVersion: review.body.requestVersion,
          expectedBindingPolicyRevision: bindingResult.body.policyRevision,
          clientMessageId: 'postgres-generation-message',
          text: 'Persistent reviewed AI answer',
          mentions: [],
          replyToMessageId: null,
          leaseId: null,
          leaseEpoch: null,
          key: 'postgres-generation-publish',
          requestFingerprint: 'postgres-generation-publish-fingerprint',
        };
        const published = await store.publishGenerationRequest(publishRequest);
        assert.equal(published.body.generationRequest.status, 'published');
        assert.equal(published.body.message.sender.kind, 'agent');
        assert.equal((await store.listPendingOutboxEvents()).length, 2);
        const disposable = await store.createManualGenerationRequest({
          user: authenticated,
          roomId: roomResult.body.id,
          clientGenerationRequestId: 'postgres-generation-disposable',
          triggerMessageIds: [messageResult.body.id],
          expectedBindingPolicyRevision: bindingResult.body.policyRevision,
          key: 'postgres-generation-disposable',
          requestFingerprint: 'postgres-generation-disposable-fingerprint',
        });
        const disposableClaim = await store.claimGenerationRequest({
          user: authenticated,
          generationRequestId: disposable.body.id,
          expectedRequestVersion: 1,
          key: 'postgres-generation-disposable-claim',
          requestFingerprint: 'postgres-generation-disposable-claim-fingerprint',
        });
        const disposableLease = {
          user: authenticated,
          generationRequestId: disposable.body.id,
          leaseId: disposableClaim.body.leaseId,
          leaseEpoch: disposableClaim.body.leaseEpoch,
        };
        await store.startGenerationRequest({
          ...disposableLease,
          expectedRequestVersion: 2,
          key: 'postgres-generation-disposable-start',
          requestFingerprint: 'postgres-generation-disposable-start-fingerprint',
        });
        await store.markGenerationReviewPending({
          ...disposableLease,
          expectedRequestVersion: 3,
          key: 'postgres-generation-disposable-review',
          requestFingerprint: 'postgres-generation-disposable-review-fingerprint',
        });
        await store.discardGenerationRequest({
          user: authenticated,
          generationRequestId: disposable.body.id,
          expectedRequestVersion: 4,
          key: 'postgres-generation-disposable-discard',
          requestFingerprint: 'postgres-generation-disposable-discard-fingerprint',
        });
        const replacement = await store.createManualGenerationRequest({
          user: authenticated,
          roomId: roomResult.body.id,
          clientGenerationRequestId: 'postgres-generation-replacement',
          triggerMessageIds: [messageResult.body.id],
          expectedBindingPolicyRevision: bindingResult.body.policyRevision,
          supersedesRequestId: disposable.body.id,
          key: 'postgres-generation-replacement',
          requestFingerprint: 'postgres-generation-replacement-fingerprint',
        });
        assert.equal(replacement.body.supersedesRequestId, disposable.body.id);
        await store.close();

        store = await PostgresGroupChatStore.connect({
          connectionString: isolatedUrl.toString(),
        });
        const restoredUser = await store.authenticate(session.accessToken);
        assert.equal(restoredUser.userId, session.user.userId);
        assert.deepEqual(
          (await store.listRooms(restoredUser.userId)).map((room) => room.id),
          [roomResult.body.id],
        );
        const roomPage = await store.listRoomsPage({
          userId: restoredUser.userId,
          afterRoomId: null,
          limit: 1,
        });
        assert.deepEqual(roomPage.items.map((room) => room.id), [roomResult.body.id]);
        assert.equal(roomPage.nextRoomId, null);
        assert.deepEqual(
          await store.getAgentProfile({ agentProfileId: profileResult.body.id }),
          updatedProfile.body,
        );
        assert.deepEqual(
          await store.getMyRoomAgentBinding({
            userId: restoredUser.userId,
            roomId: roomResult.body.id,
          }),
          bindingResult.body,
        );
        const publicBindings = await store.listRoomAgentBindings({
          userId: restoredUser.userId,
          roomId: roomResult.body.id,
        });
        assert.equal(publicBindings.items.length, 1);
        assert.equal(publicBindings.items[0].agentProfileRevision, 2);
        assert.equal('preferredRuntimeDeviceId' in publicBindings.items[0], false);
        assert.equal('generationLimitPer24h' in publicBindings.items[0], false);
        const roomContext = await store.getRoomContext({
          userId: restoredUser.userId,
          roomId: roomResult.body.id,
        });
        assert.equal(roomContext.members.length, 1);
        assert.equal(roomContext.agentBindings.length, 1);
        assert.deepEqual(roomContext.agentBindings[0].binding, publicBindings.items[0]);
        assert.deepEqual(roomContext.agentBindings[0].agentProfile, updatedProfile.body);
        const messages = await store.listMessages({
          userId: restoredUser.userId,
          roomId: roomResult.body.id,
          afterSeq: 0,
          limit: 100,
        });
        assert.deepEqual(messages.items, [messageResult.body, published.body.message]);
        assert.deepEqual(
          await store.getGenerationRequest({
            userId: restoredUser.userId,
            generationRequestId: generationResult.body.id,
          }),
          published.body.generationRequest,
        );
        const publishedReplay = await store.publishGenerationRequest({
          ...publishRequest,
          user: restoredUser,
        });
        assert.deepEqual(publishedReplay, published);
        const generationList = await store.listGenerationRequests({
          user: restoredUser,
          statuses: ['published'],
          pageToken: null,
          limit: 10,
        });
        assert.deepEqual(generationList.items, [published.body.generationRequest]);

        const replay = await store.createHumanMessage({
          user: restoredUser,
          roomId: roomResult.body.id,
          clientMessageId: 'persistent-message',
          text: 'Survives restart',
          mentions: [],
          replyToMessageId: null,
          key: 'persistent-message',
          requestFingerprint: 'message-fingerprint',
        });
        assert.deepEqual(replay, messageResult);
        const pending = await store.listPendingOutboxEvents();
        assert.equal(pending.length, 2);
        for (const entry of pending) {
          await store.markOutboxDispatched(entry.outboxId);
        }
        assert.deepEqual(await store.listPendingOutboxEvents(), []);
      } finally {
        await store?.close().catch(() => {});
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      }
    },
  );

  it(
    'persists and idempotently publishes an automatic generation request',
    { skip: !process.env.TEST_DATABASE_URL },
    async () => {
      const baseUrl = process.env.TEST_DATABASE_URL;
      const schema = `chuanhuatong_test_${randomBytes(8).toString('hex')}`;
      const admin = new pg.Pool({ connectionString: baseUrl });
      await admin.query(`CREATE SCHEMA "${schema}"`);

      const isolatedUrl = new URL(baseUrl);
      isolatedUrl.searchParams.set('options', `-csearch_path=${schema}`);
      let store;
      try {
        store = await PostgresGroupChatStore.connect({
          connectionString: isolatedUrl.toString(),
          migrate: true,
          logger: { info() {} },
        });
        const session = await store.createGuestSession({
          deviceId: 'postgres-automatic-device',
          displayName: 'Postgres Automatic User',
        });
        const user = await store.authenticate(session.accessToken);
        const room = await store.createRoom({
          userId: user.userId,
          title: 'Automatic generation room',
          key: 'postgres-automatic-room',
          requestFingerprint: 'postgres-automatic-room-fingerprint',
        });
        const profile = await store.createAgentProfile({
          userId: user.userId,
          displayName: 'Postgres Automatic Agent',
          avatarResourceId: null,
          shortBio: 'Automatic generation test profile',
          key: 'postgres-automatic-profile',
          requestFingerprint: 'postgres-automatic-profile-fingerprint',
        });
        const binding = await store.putMyRoomAgentBinding({
          userId: user.userId,
          roomId: room.body.id,
          agentProfileId: profile.body.id,
          participationMode: 'automatic',
          publishMode: 'automatic',
          triggerScope: 'allHumanMessages',
          preferredRuntimeDeviceId: user.deviceId,
          generationLimitPer24h: 10,
          expectedPolicyRevision: null,
          key: 'postgres-automatic-binding',
          requestFingerprint: 'postgres-automatic-binding-fingerprint',
        });
        await store.putMyAgentRuntime({
          user,
          roomId: room.body.id,
          deviceId: user.deviceId,
          readiness: 'ready',
          readyForBindingPolicyRevision: binding.body.policyRevision,
          runtimeCapabilitiesVersion: 1,
          localConfigRevision: 1,
          key: 'postgres-automatic-runtime',
          requestFingerprint: 'postgres-automatic-runtime-fingerprint',
        });
        const trigger = await store.createHumanMessage({
          user,
          roomId: room.body.id,
          clientMessageId: 'postgres-automatic-trigger',
          text: 'Trigger an automatic answer',
          mentions: [],
          replyToMessageId: null,
          key: 'postgres-automatic-trigger',
          requestFingerprint: 'postgres-automatic-trigger-fingerprint',
        });
        const createRequest = {
          user,
          roomId: room.body.id,
          triggerBatchId: 'postgres-automatic-batch',
          triggerMessageIds: [trigger.body.id],
          key: 'postgres-automatic-batch',
          requestFingerprint: 'postgres-automatic-call-fingerprint',
        };
        const created = await store.createAutomaticGenerationRequest(createRequest);
        assert.equal(created.body.source, 'automatic');
        assert.equal(created.body.triggerBatchId, createRequest.triggerBatchId);
        assert.deepEqual(await store.createAutomaticGenerationRequest(createRequest), created);

        const claimed = await store.claimGenerationRequest({
          user,
          generationRequestId: created.body.id,
          expectedRequestVersion: created.body.requestVersion,
          key: createRequest.key,
          requestFingerprint: createRequest.requestFingerprint,
        });
        const started = await store.startGenerationRequest({
          user,
          generationRequestId: created.body.id,
          expectedRequestVersion: claimed.body.requestVersion,
          leaseId: claimed.body.leaseId,
          leaseEpoch: claimed.body.leaseEpoch,
          key: createRequest.key,
          requestFingerprint: createRequest.requestFingerprint,
        });
        const publishRequest = {
          user,
          generationRequestId: created.body.id,
          expectedRequestVersion: started.body.requestVersion,
          expectedBindingPolicyRevision: binding.body.policyRevision,
          clientMessageId: 'postgres-automatic-reply',
          text: 'Automatic PostgreSQL answer',
          mentions: [],
          replyToMessageId: trigger.body.id,
          leaseId: started.body.leaseId,
          leaseEpoch: started.body.leaseEpoch,
          key: createRequest.key,
          requestFingerprint: createRequest.requestFingerprint,
        };
        const published = await store.publishAutomaticGenerationRequest(publishRequest);
        assert.equal(published.body.generationRequest.status, 'published');
        assert.equal(published.body.generationRequest.leaseId, undefined);
        assert.equal(published.body.message.sender.agentProfileId, profile.body.id);
        assert.deepEqual(
          await store.publishAutomaticGenerationRequest(publishRequest),
          published,
        );
        const messages = await store.listMessages({
          userId: user.userId,
          roomId: room.body.id,
          afterSeq: 0,
          limit: 10,
        });
        assert.deepEqual(
          messages.items.map((message) => message.clientMessageId),
          ['postgres-automatic-trigger', 'postgres-automatic-reply'],
        );
      } finally {
        await store?.close().catch(() => {});
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      }
    },
  );

  it(
    'fences and transfers an agent runtime lease between one user\'s devices',
    { skip: !process.env.TEST_DATABASE_URL },
    async () => {
      const baseUrl = process.env.TEST_DATABASE_URL;
      const schema = `chuanhuatong_test_${randomBytes(8).toString('hex')}`;
      const admin = new pg.Pool({ connectionString: baseUrl });
      await admin.query(`CREATE SCHEMA "${schema}"`);

      const isolatedUrl = new URL(baseUrl);
      isolatedUrl.searchParams.set('options', `-csearch_path=${schema}`);
      let nowMs = Date.now();
      let store;
      try {
        store = await PostgresGroupChatStore.connect({
          connectionString: isolatedUrl.toString(),
          migrate: true,
          clock: () => new Date(nowMs),
          logger: { info() {} },
        });
        const firstSession = await store.createGuestSession({
          deviceId: 'postgres-lifecycle-device-one',
          displayName: 'Postgres Lifecycle User',
        });
        const firstDevice = await store.authenticate(firstSession.accessToken);
        const room = await store.createRoom({
          userId: firstDevice.userId,
          title: 'Postgres lifecycle room',
          key: 'postgres-lifecycle-room',
          requestFingerprint: 'postgres-lifecycle-room-fingerprint',
        });
        const activate = {
          roomId: room.body.id,
          publicProfile: {
            displayName: 'Postgres Lifecycle Agent',
            avatarResourceId: null,
            shortBio: 'Public lifecycle profile',
          },
          runtimeCapabilitiesVersion: 1,
          localConfigRevision: 1,
        };
        const firstLease = await store.activateMyAgent({
          user: firstDevice,
          ...activate,
        });

        const secondDeviceId = 'postgres-lifecycle-device-two';
        const secondAccessToken = 'postgres-lifecycle-device-two-token';
        await store.pool.query(
          `INSERT INTO user_devices(user_id, device_id, created_at, updated_at)
           VALUES ($1, $2, $3, $3)`,
          [firstDevice.userId, secondDeviceId, new Date(nowMs)],
        );
        await store.pool.query(
          `INSERT INTO sessions(token_hash, user_id, device_id, created_at)
           VALUES ($1, $2, $3, $4)`,
          [
            createHash('sha256').update(secondAccessToken).digest('hex'),
            firstDevice.userId,
            secondDeviceId,
            new Date(nowMs),
          ],
        );
        const secondDevice = await store.authenticate(secondAccessToken);
        assert.equal(secondDevice.userId, firstDevice.userId);
        assert.equal(secondDevice.deviceId, secondDeviceId);

        await assert.rejects(
          store.activateMyAgent({ user: secondDevice, ...activate }),
          (error) => error.code === 'lease_conflict',
        );

        nowMs = Date.parse(firstLease.leaseExpiresAt) + 1;
        const recoveredFirstLease = await store.recoverMyAgentRuntime({
          user: firstDevice,
          roomId: room.body.id,
        });
        assert.equal(recoveredFirstLease.deviceId, firstDevice.deviceId);
        assert.equal(recoveredFirstLease.leaseEpoch, firstLease.leaseEpoch + 1);
        assert.notEqual(recoveredFirstLease.leaseId, firstLease.leaseId);
        await assert.rejects(
          store.recoverMyAgentRuntime({ user: secondDevice, roomId: room.body.id }),
          (error) => error.code === 'lease_conflict',
        );

        nowMs = Date.parse(recoveredFirstLease.leaseExpiresAt) + 1;
        const transferred = await store.activateMyAgent({
          user: secondDevice,
          ...activate,
        });
        assert.equal(transferred.deviceId, secondDeviceId);
        assert.equal(transferred.leaseEpoch, recoveredFirstLease.leaseEpoch + 1);
        assert.notEqual(transferred.leaseId, recoveredFirstLease.leaseId);

        const trigger = await store.createHumanMessage({
          user: firstDevice,
          roomId: room.body.id,
          clientMessageId: 'postgres-lifecycle-trigger',
          text: 'The active device must claim this request',
          mentions: [],
          replyToMessageId: null,
          key: 'postgres-lifecycle-trigger',
          requestFingerprint: 'postgres-lifecycle-trigger-fingerprint',
        });
        const automatic = await store.createAutomaticGenerationRequest({
          user: firstDevice,
          roomId: room.body.id,
          triggerBatchId: 'postgres-lifecycle-batch',
          triggerMessageIds: [trigger.body.id],
          key: 'postgres-lifecycle-batch',
          requestFingerprint: 'postgres-lifecycle-call-fingerprint',
        });
        const claimedByLeaseHolder = await store.claimGenerationRequest({
          user: secondDevice,
          generationRequestId: automatic.body.id,
          expectedRequestVersion: automatic.body.requestVersion,
          key: 'postgres-lifecycle-batch',
          requestFingerprint: 'postgres-lifecycle-call-fingerprint',
        });
        assert.equal(claimedByLeaseHolder.body.claimedDeviceId, secondDeviceId);

        const finishAutomatic = async (request, claimed, suffix) => {
          const started = await store.startGenerationRequest({
            user: secondDevice,
            generationRequestId: request.body.id,
            expectedRequestVersion: claimed.body.requestVersion,
            leaseId: claimed.body.leaseId,
            leaseEpoch: claimed.body.leaseEpoch,
            key: `postgres-loop-${suffix}`,
            requestFingerprint: `postgres-loop-${suffix}-fingerprint`,
          });
          return store.publishAutomaticGenerationRequest({
            user: secondDevice,
            generationRequestId: request.body.id,
            expectedRequestVersion: started.body.requestVersion,
            expectedBindingPolicyRevision: transferred.policyRevision,
            clientMessageId: `postgres-loop-reply-${suffix}`,
            text: `Postgres loop reply ${suffix}`,
            mentions: [],
            replyToMessageId: null,
            leaseId: started.body.leaseId,
            leaseEpoch: started.body.leaseEpoch,
            key: `postgres-loop-${suffix}`,
            requestFingerprint: `postgres-loop-${suffix}-fingerprint`,
          });
        };
        const createAndPublish = async (suffix, triggerMessageId) => {
          const request = await store.createAutomaticGenerationRequest({
            user: secondDevice,
            roomId: room.body.id,
            triggerBatchId: `postgres-loop-${suffix}`,
            triggerMessageIds: [triggerMessageId],
            key: `postgres-loop-${suffix}`,
            requestFingerprint: `postgres-loop-${suffix}-fingerprint`,
          });
          const claimed = await store.claimGenerationRequest({
            user: secondDevice,
            generationRequestId: request.body.id,
            expectedRequestVersion: request.body.requestVersion,
            key: `postgres-loop-${suffix}`,
            requestFingerprint: `postgres-loop-${suffix}-fingerprint`,
          });
          return finishAutomatic(request, claimed, suffix);
        };

        await finishAutomatic(
          automatic,
          claimedByLeaseHolder,
          'one',
        );
        await assert.rejects(
          createAndPublish('two', trigger.body.id),
          (error) => error.code === 'agent_loop_limit_reached',
        );
        const reset = await store.createHumanMessage({
          user: firstDevice,
          roomId: room.body.id,
          clientMessageId: 'postgres-loop-reset',
          text: 'Reset the PostgreSQL agent loop cycle',
          mentions: [],
          replyToMessageId: null,
          key: 'postgres-loop-reset',
          requestFingerprint: 'postgres-loop-reset-fingerprint',
        });
        await createAndPublish('after-reset', reset.body.id);

        await assert.rejects(
          store.heartbeatMyAgent({
            user: firstDevice,
            roomId: room.body.id,
            leaseId: firstLease.leaseId,
            leaseEpoch: firstLease.leaseEpoch,
          }),
          (error) => error.code === 'lease_conflict',
        );
        const renewed = await store.heartbeatMyAgent({
          user: secondDevice,
          roomId: room.body.id,
          leaseId: transferred.leaseId,
          leaseEpoch: transferred.leaseEpoch,
        });
        assert.equal(renewed.leaseId, transferred.leaseId);
        const deactivated = await store.deactivateMyAgent({
          user: secondDevice,
          roomId: room.body.id,
          leaseId: transferred.leaseId,
          leaseEpoch: transferred.leaseEpoch,
        });
        assert.equal(deactivated.status, 'deactivated');
        assert.deepEqual(
          await store.deactivateMyAgent({
            user: secondDevice,
            roomId: room.body.id,
            leaseId: transferred.leaseId,
            leaseEpoch: transferred.leaseEpoch,
          }),
          deactivated,
        );
      } finally {
        await store?.close().catch(() => {});
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      }
    },
  );

  it(
    'handoff atomically creates a shared room with a readable seeded context',
    { skip: !process.env.TEST_DATABASE_URL },
    async () => {
      const baseUrl = process.env.TEST_DATABASE_URL;
      const schema = `chuanhuatong_test_${randomBytes(8).toString('hex')}`;
      const admin = new pg.Pool({ connectionString: baseUrl });
      await admin.query(`CREATE SCHEMA "${schema}"`);

      const isolatedUrl = new URL(baseUrl);
      isolatedUrl.searchParams.set('options', `-csearch_path=${schema}`);
      let store;
      try {
        store = await PostgresGroupChatStore.connect({
          connectionString: isolatedUrl.toString(),
          migrate: true,
          logger: { info() {} },
        });
        const owner = await store.createGuestSession({
          deviceId: 'postgres-handoff-owner-device',
          displayName: 'Postgres Handoff Owner',
        });
        const joiner = await store.createGuestSession({
          deviceId: 'postgres-handoff-joiner-device',
          displayName: 'Postgres Handoff Joiner',
        });
        const request = {
          user: owner.user,
          title: 'Handoff room',
          contextSummary: '背景：方案讨论',
          decisions: ['结论：采用原子工具'],
          openQuestions: ['问题：默认过期时间'],
          invite: {
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            maxUses: 5,
          },
          key: 'postgres-handoff-once',
          requestFingerprint: 'postgres-handoff-fingerprint',
        };
        const [created, replay] = await Promise.all([
          store.handoffToRoom(request),
          store.handoffToRoom(request),
        ]);
        assert.deepEqual(replay, created);

        const body = created.body;
        assert.equal(body.room.ownerUserId, owner.user.userId);
        assert.equal(body.room.lastSeq, 1);
        assert.equal(body.room.historyVisibility, 'from_start');
        assert.equal(body.message.seq, 1);
        assert.ok(body.message.content.text.includes('# 背景'));
        assert.equal(typeof body.invite.inviteToken, 'string');

        const accepted = await store.acceptInvite({
          userId: joiner.user.userId,
          inviteToken: body.invite.inviteToken,
          key: 'postgres-handoff-join',
          requestFingerprint: 'postgres-handoff-join-fingerprint',
        });
        assert.equal(accepted.body.membership.joinedSeq, 1);
        assert.equal(accepted.body.membership.readSeq, 0);
        assert.equal(accepted.body.room.historyVisibility, 'from_start');
        const messages = await store.listMessages({
          userId: joiner.user.userId,
          roomId: body.room.id,
          afterSeq: accepted.body.membership.readSeq,
          limit: 10,
        });
        assert.equal(messages.items.length, 1);
        assert.equal(messages.items[0].id, body.message.id);
      } finally {
        await store?.close().catch(() => {});
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      }
    },
  );
});
