export const DEFAULT_BUBBLE_OPACITY = 100;
export const DEFAULT_BUBBLE_COLOR = '#55789c';

const OPACITY_KEY = 'chuanhuatong_bubble_opacity';
const COLOR_KEY = 'chuanhuatong_bubble_color';
const DATABASE_NAME = 'chuanhuatong-appearance';
const STORE_NAME = 'assets';
const BACKGROUND_KEY = 'chat-background';
const MAX_BACKGROUND_SIZE = 10 * 1024 * 1024;

let activeBackgroundUrl: string | null = null;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function readBackground(): Promise<Blob | null> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readonly');
  const request = transaction.objectStore(STORE_NAME).get(BACKGROUND_KEY);
  const background = await new Promise<Blob | null>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result instanceof Blob ? request.result : null);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return background;
}

function displayBackground(background: Blob | null) {
  if (activeBackgroundUrl) URL.revokeObjectURL(activeBackgroundUrl);
  activeBackgroundUrl = background ? URL.createObjectURL(background) : null;
  if (activeBackgroundUrl) {
    document.documentElement.style.setProperty(
      '--chat-background-image',
      `url("${activeBackgroundUrl}")`,
    );
  } else {
    document.documentElement.style.removeProperty('--chat-background-image');
  }
}

export function readBubbleOpacity(): number {
  const saved = Number(localStorage.getItem(OPACITY_KEY));
  return Number.isFinite(saved) && saved >= 10 && saved <= 100
    ? saved
    : DEFAULT_BUBBLE_OPACITY;
}

export function applyBubbleOpacity(opacity: number) {
  const nextOpacity = Math.min(100, Math.max(10, Math.round(opacity)));
  localStorage.setItem(OPACITY_KEY, String(nextOpacity));
  document.documentElement.style.setProperty('--bubble-opacity', `${nextOpacity}%`);
}

export function readBubbleColor(): string {
  const saved = localStorage.getItem(COLOR_KEY);
  return saved && /^#[0-9a-f]{6}$/i.test(saved) ? saved : DEFAULT_BUBBLE_COLOR;
}

function bubbleTextColor(color: string): string {
  const channels = [1, 3, 5].map(index => Number.parseInt(color.slice(index, index + 2), 16) / 255);
  const [red, green, blue] = channels.map(channel =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return luminance > 0.179 ? '#101114' : '#ffffff';
}

export function applyBubbleColor(color: string) {
  const nextColor = /^#[0-9a-f]{6}$/i.test(color) ? color : DEFAULT_BUBBLE_COLOR;
  localStorage.setItem(COLOR_KEY, nextColor);
  document.documentElement.style.setProperty('--bubble-self-top', nextColor);
  document.documentElement.style.setProperty('--bubble-self-bottom', nextColor);
  document.documentElement.style.setProperty('--bubble-self-text', bubbleTextColor(nextColor));
}

export async function initializeAppearance() {
  applyBubbleOpacity(readBubbleOpacity());
  applyBubbleColor(readBubbleColor());
  displayBackground(await readBackground());
}

export async function hasChatBackground(): Promise<boolean> {
  return (await readBackground()) !== null;
}

export async function saveChatBackground(file: File) {
  if (!file.type.startsWith('image/')) throw new Error('请选择图片文件');
  if (file.size > MAX_BACKGROUND_SIZE) throw new Error('聊天背景图不能超过 10 MiB');

  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  transaction.objectStore(STORE_NAME).put(file, BACKGROUND_KEY);
  await transactionComplete(transaction);
  database.close();
  displayBackground(file);
}

export async function clearChatBackground() {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  transaction.objectStore(STORE_NAME).delete(BACKGROUND_KEY);
  await transactionComplete(transaction);
  database.close();
  displayBackground(null);
}
