import { apiRequest } from './client';
import { newRequestId } from './request-id';
import type { Message } from '../types';

export interface MessagePage {
  items: Message[];
  highWaterSeq: number;
  hasMore: boolean;
  nextBeforeSeq?: number | null;
}

export function listLatestMessages(
  roomId: string,
  beforeSeq: number | null = null,
  limit = 100,
): Promise<MessagePage> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (beforeSeq !== null) params.set('beforeSeq', String(beforeSeq));
  return apiRequest('GET', `/v1/rooms/${roomId}/messages?${params}`);
}

export function listMessagesAfter(
  roomId: string,
  afterSeq: number,
  limit = 200,
): Promise<MessagePage> {
  const params = new URLSearchParams({
    afterSeq: String(afterSeq),
    limit: String(limit),
  });
  return apiRequest('GET', `/v1/rooms/${roomId}/messages?${params}`);
}

export function sendMessage(roomId: string, text: string): Promise<Message> {
  const clientMessageId = newRequestId();
  return apiRequest('POST', `/v1/rooms/${roomId}/messages`, {
    clientMessageId,
    content: { schemaVersion: 1, type: 'text', text },
  }, { idempotencyKey: clientMessageId });
}

export function recallMessage(roomId: string, messageId: string): Promise<Message> {
  return apiRequest('POST', `/v1/rooms/${roomId}/messages/${messageId}/recall`, {});
}

export function markRoomRead(roomId: string, readSeq: number): Promise<{
  roomId: string;
  webReadSeq: number;
}> {
  return apiRequest('PUT', `/v1/rooms/${roomId}/read`, { readSeq });
}
