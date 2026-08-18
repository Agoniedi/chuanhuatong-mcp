import { apiRequest } from './client';
import { newRequestId } from './request-id';
import type { Room, WorldRoom, WorldRoomDetail } from '../types';

export async function listRooms(): Promise<Room[]> {
  const result = await apiRequest<{ items: Room[] }>('GET', '/v1/rooms');
  return result.items;
}

export async function getRoom(roomId: string): Promise<Room> {
  return apiRequest<Room>('GET', `/v1/rooms/${roomId}`);
}

export function deleteRoom(roomId: string): Promise<void> {
  return apiRequest('DELETE', `/v1/rooms/${roomId}`);
}

export async function listWorldRooms(): Promise<WorldRoom[]> {
  const result = await apiRequest<{ items: WorldRoom[] }>('GET', '/v1/world/rooms');
  return result.items;
}

export function getWorldRoom(roomId: string): Promise<WorldRoomDetail> {
  return apiRequest('GET', `/v1/world/rooms/${roomId}`);
}

export function updateWorldRoom(roomId: string, published: boolean, summary = ''): Promise<{
  room: Room;
  world: WorldRoomDetail | null;
}> {
  return apiRequest('PUT', `/v1/rooms/${roomId}/world`, { published, summary }, {
    operationId: newRequestId(),
  });
}
