import { apiRequest } from './client';
import type { AgentBinding } from '../types';

export async function listAgentBindings(roomId: string): Promise<AgentBinding[]> {
  const result = await apiRequest<{ items: AgentBinding[] }>('GET', `/v1/rooms/${roomId}/agent-bindings`);
  return result.items;
}