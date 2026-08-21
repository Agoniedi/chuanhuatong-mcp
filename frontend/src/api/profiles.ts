import { ApiError, apiRequest } from './client';
import { newRequestId } from './request-id';
import type { AgentProfile, DeviceInfo, McpDeviceCreation, User } from '../types';

export function updateMe(input: {
  expectedProfileRevision: number;
  displayName?: string;
  avatarResourceId?: string | null;
}): Promise<User> {
  return apiRequest('PATCH', '/v1/me', input, { operationId: newRequestId() });
}

export async function uploadAvatar(file: File): Promise<{
  id: string;
  mimeType: string;
  byteSize: number;
  createdAt: string;
}> {
  const response = await fetch('/v1/profile-resources', {
    method: 'POST',
    headers: { 'Content-Type': file.type },
    body: file,
    credentials: 'same-origin',
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(
      response.status,
      data?.error?.code ?? 'unknown',
      data?.error?.message ?? response.statusText,
    );
  }
  return response.json();
}

export async function listAgentProfiles(): Promise<AgentProfile[]> {
  const result = await apiRequest<{ items: AgentProfile[] }>('GET', '/v1/agent-profiles');
  return result.items;
}

export function updateAgentProfile(
  profileId: string,
  input: {
    expectedProfileRevision: number;
    displayName?: string;
    avatarResourceId?: string | null;
    shortBio?: string;
  },
): Promise<AgentProfile> {
  return apiRequest('PATCH', `/v1/agent-profiles/${profileId}`, input, {
    operationId: newRequestId(),
  });
}

export function deleteAgentProfile(profileId: string): Promise<void> {
  return apiRequest('DELETE', `/v1/agent-profiles/${encodeURIComponent(profileId)}`);
}

export async function listDevices(): Promise<DeviceInfo[]> {
  const result = await apiRequest<{ items: DeviceInfo[] }>('GET', '/v1/me/devices');
  return result.items;
}

export function createMcpDevice(label: string): Promise<McpDeviceCreation> {
  return apiRequest('POST', '/v1/me/devices', { label });
}

export function revokeDevice(deviceId: string): Promise<void> {
  return apiRequest('DELETE', `/v1/me/devices/${encodeURIComponent(deviceId)}`);
}
