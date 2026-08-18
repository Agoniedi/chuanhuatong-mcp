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
  await expect(page.locator('.brand-mark')).toHaveCount(0);
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
  const otherMessage = page.getByRole('article').filter({ hasText: '来自其他成员的消息' });
  const ownMessage = page.getByRole('article').filter({ hasText: '来自当前用户的消息' });
  await expect(otherMessage).toHaveClass(/other/);
  await expect(ownMessage).toHaveClass(/own/);
  await expect(otherMessage.locator('.avatar-human')).toBeVisible();
  await expect(ownMessage.locator('.avatar-human')).toBeVisible();
  expect(await otherMessage.locator('.avatar-human').evaluate(element =>
    getComputedStyle(element).borderRadius)).toBe('30%');
  expect(await ownMessage.locator('.avatar-human').evaluate(element =>
    getComputedStyle(element).borderRadius)).toBe('30%');
  expect(await page.locator('html').evaluate(element =>
    getComputedStyle(element).getPropertyValue('--bubble-self-top').trim())).toBe('#55789c');
  await expect(page.locator('.readonly-bar')).toHaveCount(0);
  await expect(page.locator('.send-bar')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /发送|邀请|创建房间/ })).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect((await page.locator('.room-header').boundingBox())!.height).toBeLessThanOrEqual(44);
  const ownAvatarBox = await ownMessage.locator('.avatar-human').boundingBox();
  const ownBubbleBox = await ownMessage.locator('.msg-bubble').boundingBox();
  const otherAvatarBox = await otherMessage.locator('.avatar-human').boundingBox();
  const otherBubbleBox = await otherMessage.locator('.msg-bubble').boundingBox();
  expect(ownAvatarBox!.x).toBeGreaterThan(ownBubbleBox!.x + ownBubbleBox!.width);
  expect(otherAvatarBox!.x + otherAvatarBox!.width).toBeLessThan(otherBubbleBox!.x);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '成员', exact: true }).click();
  await expect(page.getByLabel('房间成员')).toBeVisible();
  expect(await page.getByLabel('房间成员').evaluate(element =>
    getComputedStyle(element).animationName)).toBe('none');
  expect(await page.locator('.panel-scrim').evaluate(element =>
    getComputedStyle(element).animationName)).toBe('none');
  await page.locator('.panel-scrim').click({ position: { x: 1, y: 1 } });

  const blocked = await page.context().request.post(`${baseUrl}/v1/rooms`, {
    data: { title: 'Cookie must not create this room' },
    headers: { 'Idempotency-Key': 'e2e-cookie-room' },
  });
  expect(blocked.status()).toBe(403);
  expect((await blocked.json()).error.code).toBe('web_read_only');

  await page.getByRole('button', { name: '返回房间列表', exact: true }).click();
  await expect(page.getByRole('button', { name: /只读验收房间/ })).not.toContainText('未读');

  await page.getByRole('button', { name: '设置', exact: true }).click();
  const opacity = page.getByRole('slider', { name: '气泡透明度' });
  await opacity.fill('10');
  await expect(page.locator('output[for="bubble-opacity"]')).toHaveText('10%');
  expect(await page.locator('html').evaluate(element =>
    element.style.getPropertyValue('--bubble-opacity'))).toBe('10%');
  await page.getByLabel('选择我的气泡颜色').fill('#12abef');
  expect(await page.locator('html').evaluate(element =>
    element.style.getPropertyValue('--bubble-self-top'))).toBe('#12abef');

  await page.getByLabel('聊天背景图').setInputFiles({
    name: 'background.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  });
  await expect(page.locator('.success-message')).toHaveText('聊天背景已更新');
  await expect(page.locator('.background-preview')).not.toHaveClass(/empty/);

  await page.getByRole('button', { name: '← 返回', exact: true }).click();
  await page.getByRole('button', { name: /只读验收房间/ }).click();
  await expect.poll(() => page.locator('.room-main').evaluate(element =>
    getComputedStyle(element).backgroundImage)).toContain('blob:');
  await page.reload();
  await expect.poll(() => page.locator('.room-main').evaluate(element =>
    getComputedStyle(element).backgroundImage)).toContain('blob:');
  expect(await page.locator('html').evaluate(element =>
    element.style.getPropertyValue('--bubble-opacity'))).toBe('10%');
  expect(await page.locator('html').evaluate(element =>
    element.style.getPropertyValue('--bubble-self-top'))).toBe('#12abef');

  await page.getByRole('button', { name: '返回房间列表', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '移除背景', exact: true }).click();
  await expect(page.locator('.success-message')).toHaveText('聊天背景已移除');
  await page.getByRole('slider', { name: '气泡透明度' }).fill('100');
  await page.getByLabel('选择我的气泡颜色').fill('#55789c');
});
