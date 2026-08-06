import { apiRequest } from './client';
import type { Member } from '../types';

export async function listMembers(roomId: string): Promise<{ items: Member[]; roomRevision: number }> {
  return apiRequest('GET', `/v1/rooms/${roomId}/members`);
}