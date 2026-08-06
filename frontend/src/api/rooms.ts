import { apiRequest } from './client';
import { newRequestId } from './request-id';
import type { Room } from '../types';

export async function listRooms(): Promise<Room[]> {
  const result = await apiRequest<{ items: Room[] }>('GET', '/v1/rooms');
  return result.items;
}

export async function getRoom(roomId: string): Promise<Room> {
  return apiRequest<Room>('GET', `/v1/rooms/${roomId}`);
}

export async function createRoom(title: string): Promise<Room> {
  const idempotencyKey = newRequestId();
  return apiRequest<Room>('POST', '/v1/rooms', { title }, { idempotencyKey });
}
