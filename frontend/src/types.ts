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
  createdAt: string;
  updatedAt: string;
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

export interface RegisterResponse {
  token: string;
  userId: string;
  displayName: string;
  handle: string;
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
