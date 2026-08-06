import { apiRequest } from './client';
import type { Message } from '../types';

export async function listMessages(roomId: string, afterSeq: number = 0, limit: number = 50): Promise<{ items: Message[]; highWaterSeq: number; hasMore: boolean }> {
  const params = new URLSearchParams({ afterSeq: String(afterSeq), limit: String(limit) });
  return apiRequest('GET', `/v1/rooms/${roomId}/messages?${params}`);
}

export async function sendMessage(roomId: string, text: string): Promise<Message> {
  const clientMessageId = crypto.randomUUID();
  return apiRequest<Message>('POST', `/v1/rooms/${roomId}/messages`, {
    clientMessageId,
    content: { schemaVersion: 1, type: 'text', text },
    mentions: [],
  }, { idempotencyKey: clientMessageId });
}