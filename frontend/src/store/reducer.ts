import type { Message, Room, User } from '../types';

export type WsStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';
export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

export interface AppState {
  authStatus: AuthStatus;
  me: User | null;
  rooms: Room[];
  messages: Record<string, Message[]>;
  wsStatus: WsStatus;
  currentRoomId: string | null;
  lastSeqs: Record<string, number>;
  profileVersion: number;
}

export type Action =
  | { type: 'SET_AUTHENTICATED'; me: User }
  | { type: 'SET_ANONYMOUS' }
  | { type: 'SET_ME'; me: User }
  | { type: 'SET_ROOMS'; rooms: Room[] }
  | { type: 'MERGE_MESSAGES'; roomId: string; messages: Message[] }
  | { type: 'APPEND_MESSAGE'; roomId: string; message: Message }
  | { type: 'SET_WS_STATUS'; status: WsStatus }
  | { type: 'SET_CURRENT_ROOM'; roomId: string | null }
  | { type: 'MARK_ROOM_READ'; roomId: string; readSeq: number }
  | { type: 'PROFILE_UPDATED' }
  | { type: 'LOGOUT' };

export const initialState: AppState = {
  authStatus: 'loading',
  me: null,
  rooms: [],
  messages: {},
  wsStatus: 'closed',
  currentRoomId: null,
  lastSeqs: {},
  profileVersion: 0,
};

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_AUTHENTICATED':
      return { ...state, authStatus: 'authenticated', me: action.me };
    case 'SET_ANONYMOUS':
      return { ...initialState, authStatus: 'anonymous' };
    case 'SET_ME':
      return { ...state, me: action.me };
    case 'SET_ROOMS':
      return { ...state, rooms: action.rooms };
    case 'MERGE_MESSAGES': {
      const existing = state.messages[action.roomId] ?? [];
      const byId = new Map(existing.map(message => [message.id, message]));
      for (const message of action.messages) byId.set(message.id, message);
      const messages = [...byId.values()].sort((left, right) => left.seq - right.seq);
      const lastSeq = messages.at(-1)?.seq ?? state.lastSeqs[action.roomId] ?? 0;
      return {
        ...state,
        messages: { ...state.messages, [action.roomId]: messages },
        lastSeqs: {
          ...state.lastSeqs,
          [action.roomId]: Math.max(state.lastSeqs[action.roomId] ?? 0, lastSeq),
        },
      };
    }
    case 'APPEND_MESSAGE': {
      const existing = state.messages[action.roomId] ?? [];
      if (existing.some(message => message.id === action.message.id)) return state;
      const messages = [...existing, action.message]
        .sort((left, right) => left.seq - right.seq);
      return {
        ...state,
        messages: { ...state.messages, [action.roomId]: messages },
        rooms: state.rooms.map(room => {
          if (room.id !== action.roomId) return room;
          const lastSeq = Math.max(room.lastSeq, action.message.seq);
          return {
            ...room,
            lastSeq,
            unreadCount: Math.max(0, lastSeq - room.webReadSeq),
          };
        }),
        lastSeqs: {
          ...state.lastSeqs,
          [action.roomId]: Math.max(
            state.lastSeqs[action.roomId] ?? 0,
            action.message.seq,
          ),
        },
      };
    }
    case 'SET_WS_STATUS':
      return { ...state, wsStatus: action.status };
    case 'SET_CURRENT_ROOM':
      return { ...state, currentRoomId: action.roomId };
    case 'MARK_ROOM_READ':
      return {
        ...state,
        rooms: state.rooms.map(room => room.id === action.roomId
          ? {
              ...room,
              webReadSeq: Math.max(room.webReadSeq, action.readSeq),
              unreadCount: Math.max(0, room.lastSeq - Math.max(room.webReadSeq, action.readSeq)),
            }
          : room),
      };
    case 'PROFILE_UPDATED':
      return { ...state, profileVersion: state.profileVersion + 1 };
    case 'LOGOUT':
      return { ...initialState, authStatus: 'anonymous' };
    default:
      return state;
  }
}
