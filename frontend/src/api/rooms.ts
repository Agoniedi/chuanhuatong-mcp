import { apiRequest } from './client';
import type { Room } from '../types';

export async function listRooms(): Promise<Room[]> {
  const result = await apiRequest<{ items: Room[] }>('GET', '/v1/rooms');
  return result.items;
}

export async function getRoom(roomId: string): Promise<Room> {
  return apiRequest<Room>('GET', `/v1/rooms/${roomId}`);
}
