import { apiRequest } from './client';
import type { Member } from '../types';

export async function listMembers(roomId: string): Promise<{ items: Member[]; roomRevision: number }> {
  return apiRequest('GET', `/v1/rooms/${roomId}/members`);
}

export function leaveRoom(roomId: string): Promise<void> {
  return apiRequest('DELETE', `/v1/rooms/${roomId}/members/me`);
}

export function removeRoomMember(roomId: string, userId: string): Promise<void> {
  return apiRequest(
    'DELETE',
    `/v1/rooms/${roomId}/members/${encodeURIComponent(userId)}`,
  );
}
