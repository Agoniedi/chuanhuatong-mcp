import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MemoryGroupChatStore } from '../../src/group_chat_store.mjs';
import { createPasswordDigest } from '../../src/passwords.mjs';
import { createLocalServer } from '../../src/server.mjs';

let server: ReturnType<typeof createLocalServer>;
let baseUrl: string;
let inviteToken: string;
let joinableWorldToken: string;

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
    title: '聊天验收房间',
    key: 'e2e-room',
    requestFingerprint: 'e2e-room-fingerprint',
  });
  const published = await store.updateWorldRoom({
    userId: owner.userId,
    roomId: room.body.id,
    published: true,
    summary: '用于验证世界页布局',
  });
  const guestSession = await store.createGuestSession({
    deviceId: 'e2e-guest-device',
    displayName: '外部成员',
  });
  const guest = await store.authenticate(guestSession.accessToken);
  const invite = await store.createInvite({
    userId: owner.userId,
    roomId: room.body.id,
    expectedRoomRevision: published.body.room.revision,
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
  const joinableRoom = await store.createRoom({
    userId: guest.userId,
    title: '待加入房间',
    key: 'e2e-joinable-room',
    requestFingerprint: 'e2e-joinable-room-fingerprint',
  });
  const joinablePublished = await store.updateWorldRoom({
    userId: guest.userId,
    roomId: joinableRoom.body.id,
    published: true,
    summary: '用于验证网页加入流程',
  });
  inviteToken = published.body.world.inviteToken;
  joinableWorldToken = joinablePublished.body.world.inviteToken;
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

test('uses the redesigned shell for real room data and chat actions', async ({ page }) => {
  await page.goto(`${baseUrl}/auth`);
  await page.getByLabel('用户名', { exact: true }).fill('e2e_reader');
  await page.getByLabel('密码', { exact: true }).fill('secret6');
  await page.getByRole('button', { name: '登录', exact: true }).click();

  await expect(page.getByLabel('搜索公开房间', { exact: true })).toBeVisible();
  await expect(page.getByText('我的房间', { exact: true })).toHaveCount(0);
  await page.getByText('聊天验收房间', { exact: true }).click();
  await expect(page.getByText('邀请码', { exact: true })).toBeVisible();
  await expect(page.getByText(inviteToken, { exact: true })).toBeVisible();
  const sheetZIndex = Number(await page.getByTestId('world-room-sheet').evaluate(element => getComputedStyle(element).zIndex));
  await expect(page.getByTestId('bottom-nav')).toHaveCount(0);
  expect(sheetZIndex).toBeGreaterThan(0);
  await page.getByTestId('world-room-sheet').click({ position: { x: 5, y: 5 } });
  await expect(page.getByTestId('bottom-nav')).toBeVisible();

  await page.getByText('待加入房间', { exact: true }).click();
  await expect(page.getByText(joinableWorldToken, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '加入房间', exact: true }).click();
  await expect(page.getByTestId('world-room-sheet')).toHaveCount(0);
  await expect(page.getByText('待加入房间', { exact: true })).toBeVisible();

  await page.locator('[data-testid="bottom-nav"] button').nth(1).click();
  await expect(page.getByText('聊天验收房间', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '分享到世界', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: /聊天验收房间/ })).toBeChecked();
  await page.getByRole('button', { name: '保存分享设置', exact: true }).click();
  await page.getByText('聊天验收房间', { exact: true }).click();
  await expect(page.getByText('来自其他成员的消息', { exact: true })).toBeVisible();
  await expect(page.getByText('来自当前用户的消息', { exact: true })).toBeVisible();

  const input = page.getByRole('textbox', { name: '消息' });
  await input.fill('来自新版网页的新消息');
  const sent = page.waitForResponse(response =>
    response.request().method() === 'POST' && response.url().endsWith('/messages'));
  await page.getByRole('button', { name: '发送', exact: true }).click();
  expect((await sent).status()).toBe(201);
  await expect(page.getByText('来自新版网页的新消息', { exact: true })).toBeVisible();

  const recall = page.waitForResponse(response =>
    response.request().method() === 'POST' && response.url().endsWith('/recall'));
  await page.getByRole('button', { name: '撤回', exact: true }).last().click();
  expect((await recall).status()).toBe(200);
  await expect(page.getByText('这条消息已撤回', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '查看成员', exact: true }).click();
  await expect(page.getByText(/成员 \(/)).toBeVisible();
  await page.getByRole('button', { name: '关闭成员', exact: true }).click();

  const blocked = await page.context().request.post(`${baseUrl}/v1/rooms`, {
    data: { title: 'Cookie must not create this room' },
    headers: { 'Idempotency-Key': 'e2e-cookie-room' },
  });
  expect(blocked.status()).toBe(403);
  expect((await blocked.json()).error.code).toBe('web_read_only');

  await page.getByRole('button', { name: '返回房间列表', exact: true }).click();
  await page.getByText('我', { exact: true }).click();
  await expect(page.getByText('E2E 读者', { exact: true })).toBeVisible();
  await expect(page.getByText('1 个', { exact: true })).toBeVisible();
  await page.getByText('MCP 设备', { exact: true }).click();
  await expect(page.getByLabel('设备名称', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '创建新设备令牌', exact: true }).click();
  const deviceLabel = page.getByLabel('设备名称', { exact: true });
  await expect(deviceLabel).toBeVisible();
  expect((await deviceLabel.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(deviceLabel).toHaveCount(0);
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await page.getByText('个人资料', { exact: true }).click();
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeVisible();
  await page.locator('#profile-avatar-upload').setInputFiles(
    resolve(process.cwd(), 'src/assets/hero.png'),
  );
  const profileSaved = page.waitForResponse(response =>
    response.request().method() === 'PATCH' && response.url().endsWith('/v1/me'));
  await page.getByRole('button', { name: '保存', exact: true }).click();
  expect((await profileSaved).status()).toBe(200);
  await expect(page.getByText('已保存', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '返回', exact: true }).click();
  const customAvatar = page.getByTestId('me-avatar').locator('img');
  await expect(customAvatar).toBeVisible();
  await expect(customAvatar).toHaveAttribute('src', /\/v1\/profile-resources\//);
});

test('keeps the redesigned shell usable on a narrow mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/auth`);
  await page.getByLabel('用户名', { exact: true }).fill('e2e_reader');
  await page.getByLabel('密码', { exact: true }).fill('secret6');
  await page.getByRole('button', { name: '登录', exact: true }).click();

  const titleBox = await page.getByRole('heading', { name: '传话筒', exact: true }).boundingBox();
  const navBox = await page.getByTestId('bottom-nav').boundingBox();
  expect(titleBox).not.toBeNull();
  expect(navBox).not.toBeNull();
  expect(titleBox!.y).toBeLessThanOrEqual(24);
  expect(844 - navBox!.y - navBox!.height).toBeLessThanOrEqual(12);

  await page.locator('[data-testid="bottom-nav"] button').nth(1).click();
  await expect(page.getByText('聊天验收房间', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBeTruthy();
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(process.cwd(), '../output/playwright/mobile-room-list.png') });

  await page.getByText('聊天验收房间', { exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息' })).toBeVisible();
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(process.cwd(), '../output/playwright/mobile-chat.png') });
});
