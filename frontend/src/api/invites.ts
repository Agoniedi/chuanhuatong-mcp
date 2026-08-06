import { apiRequest } from './client';
import { newRequestId } from './request-id';

export interface InvitePreview {
  roomTitle: string;
  inviterDisplayName: string;
  expiresAt: string;
  remainingUses: number;
}

export async function previewInvite(inviteToken: string): Promise<InvitePreview> {
  const params = new URLSearchParams({ token: inviteToken });
  return apiRequest<InvitePreview>('GET', `/v1/invites/preview?${params}`);
}

export async function acceptInvite(inviteToken: string): Promise<{ room: any; membership: any }> {
  return apiRequest('POST', '/v1/invites/accept', { inviteToken }, {
    operationId: newRequestId(),
  });
}
