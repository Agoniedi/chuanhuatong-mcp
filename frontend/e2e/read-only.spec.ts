import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MemoryGroupChatStore } from '../../src/group_chat_store.mjs';
import { createPasswordDigest } from '../../src/passwords.mjs';
import { createLocalServer } from '../../src/server.mjs';

let server: ReturnType<typeof createLocalServer>;
let baseUrl: string;

test.beforeAll(async () => {
  const store = new MemoryGroupChatStore();
  const registration = await store.createMcpRegistration({
    displayName: 'E2E 读者',
    deviceLabel: 'E2E MCP device',
    key: 'e2e-registration',
    requestFingerprint: 'e2e-registration-fingerprint',
  });
  const password = await createPasswordDigest('secret6');
  await store.registerWebAccount({
    username: 'e2e_reader',
    usernameKey: 'e2e_reader',
    displayName: 'E2E 读者',
    passwordSalt: password.salt,
    passwordHash: password.hash,
    bindingCode: registration.bindingCode,
  });
  const owner = await store.authenticate(registration.token);
  const room = await store.createRoom({
    userId: owner.userId,
    title: '只读验收房间',
    key: 'e2e-room',
    requestFingerprint: 'e2e-room-fingerprint',
  });
  const guestSession = await store.createGuestSession({
    deviceId: 'e2e-guest-device',
    displayName: '外部成员',
  });
  const guest = await store.authenticate(guestSession.accessToken);
  const invite = await store.createInvite({
    userId: owner.userId,
    roomId: room.body.id,
    expectedRoomRevision: room.body.revision,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    maxUses: 1,
    key: 'e2e-invite',
    requestFingerprint: 'e2e-invite-fingerprint',
  });
  await store.acceptInvite({
    userId: guest.userId,
    inviteToken: invite.body.inviteToken,
    key: 'e2e-accept',
    requestFingerprint: 'e2e-accept-fingerprint',
  });
  await store.createHumanMessage({
    user: guest,
    roomId: room.body.id,
    clientMessageId: 'e2e-guest-message',
    text: '来自其他成员的消息',
    mentions: [],
    replyToMessageId: null,
    key: 'e2e-guest-message',
    requestFingerprint: 'e2e-guest-message-fingerprint',
  });
  await store.createHumanMessage({
    user: owner,
    roomId: room.body.id,
    clientMessageId: 'e2e-owner-message',
    text: '来自当前用户的消息',
    mentions: [],
    replyToMessageId: null,
    key: 'e2e-owner-message',
    requestFingerprint: 'e2e-owner-message-fingerprint',
  });

  server = createLocalServer({
    store,
    frontendDist: resolve(fileURLToPath(new URL('../dist/', import.meta.url))),
    logger: { warn() {}, error() {} },
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('E2E server did not start');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await server.shutdown();
});

test('logs in and keeps the room observer strictly read-only', async ({ page }) => {
  await page.goto(`${baseUrl}/auth`);
  await page.getByLabel('用户名', { exact: true }).fill('e2e_reader');
  await page.getByLabel('密码', { exact: true }).fill('secret6');
  await page.getByRole('button', { name: '登录', exact: true }).last().click();

  const room = page.getByRole('button', { name: /只读验收房间/ });
  await expect(room).toContainText('2');
  const markedRead = page.waitForResponse(response =>
    response.request().method() === 'PUT' && response.url().endsWith('/read'));
  await room.click();
  await markedRead;

  await expect(page.getByText('来自其他成员的消息')).toBeVisible();
  await expect(page.getByText('来自当前用户的消息')).toBeVisible();
  await expect(page.locator('.message-item').filter({ hasText: '来自其他成员的消息' }))
    .not.toHaveClass(/message-own/);
  await expect(page.locator('.message-item').filter({ hasText: '来自当前用户的消息' }))
    .toHaveClass(/message-own/);
  await expect(page.locator('.send-bar')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /发送|邀请|创建房间/ })).toHaveCount(0);

  const blocked = await page.context().request.post(`${baseUrl}/v1/rooms`, {
    data: { title: 'Cookie must not create this room' },
    headers: { 'Idempotency-Key': 'e2e-cookie-room' },
  });
  expect(blocked.status()).toBe(403);
  expect((await blocked.json()).error.code).toBe('web_read_only');

  await page.getByRole('button', { name: '← 返回', exact: true }).click();
  await expect(page.getByRole('button', { name: /只读验收房间/ })).not.toContainText('未读');
});
