export interface User {
  userId: string;
  handle: string;
  displayName: string;
  avatarResourceId: string | null;
  profileRevision: number;
}

export interface Room {
  id: string;
  ownerUserId: string;
  title: string;
  lastSeq: number;
  revision: number;
  historyVisibility: string;
  worldPublished?: boolean;
  worldSummary?: string;
  createdAt: string;
  updatedAt: string;
  webReadSeq: number;
  unreadCount: number;
  memberCount?: number;
}

export interface WorldRoom {
  id: string;
  title: string;
  ownerUserId: string;
  ownerDisplayName: string;
  summary: string;
  publishedAt: string;
  memberCount?: number;
}

export interface WorldRoomDetail extends WorldRoom {
  inviteToken: string;
  inviteExpiresAt: string;
  remainingUses: number;
}

export interface InvitePreview {
  roomTitle: string;
  inviterDisplayName: string;
  expiresAt: string;
  remainingUses: number;
}

export interface MessageContent {
  schemaVersion: number;
  type: string;
  text: string;
}

export interface MessageSender {
  kind: 'human' | 'agent';
  userId: string;
  agentProfileId?: string;
  displayNameSnapshot: string;
  avatarResourceIdSnapshot: string | null;
}

export interface Mention {
  kind: 'user' | 'agent';
  targetId: string;
}

export interface Message {
  id: string;
  roomId: string;
  seq: number;
  clientMessageId: string;
  sender: MessageSender;
  content: MessageContent;
  mentions: Mention[];
  replyToMessageId: string | null;
  generationRequestId?: string;
  triggerThroughSeq?: number;
  recalledAt?: string | null;
  createdAt: string;
}

export interface Member {
  userId: string;
  role: string;
  joinedSeq: number;
  displayName: string;
  avatarResourceId: string | null;
}

export interface AgentBinding {
  bindingId: string;
  roomId: string;
  ownerUserId: string;
  agentProfileId: string;
  agentProfileRevision: number;
  displayName: string;
  avatarResourceId: string | null;
  participationMode: 'off' | 'manual' | 'automatic';
  publishMode: 'reviewRequired' | 'automatic';
  triggerScope: string;
  policyRevision: number;
  updatedAt: string;
}

export interface AgentProfile {
  id: string;
  ownerUserId: string;
  displayName: string;
  avatarResourceId: string | null;
  shortBio: string;
  profileRevision: number;
  createdAt: string;
  updatedAt: string;
}

export interface DeviceInfo {
  userId: string;
  deviceId: string;
  kind: 'mcp' | 'web' | 'legacy';
  label: string;
  active: boolean;
}

export interface McpDeviceCreation {
  token: string;
  deviceId: string;
  label: string;
  mcpUrl: string;
  authorizationHeader: string;
}

export interface WsEvent {
  protocolVersion: number;
  eventId: string;
  type: string;
  occurredAt: string;
  roomId?: string;
  payload: any;
}

export interface ConnectionReadyEvent extends WsEvent {
  type: 'connection.ready';
  payload: {};
}

export interface MessageCreatedEvent extends WsEvent {
  type: 'message.created';
  roomId: string;
  payload: Message;
}

export interface MessageRecalledEvent extends WsEvent {
  type: 'message.recalled';
  roomId: string;
  payload: Message;
}

export interface RoomDeletedEvent extends WsEvent {
  type: 'room.deleted';
  roomId: string;
  payload: { roomId: string };
}

export interface ProfileUpdatedEvent extends WsEvent {
  type: 'profile.updated';
  payload: {
    profileType: 'human' | 'agent';
    ownerUserId: string;
    profile: User | AgentProfile;
  };
}
