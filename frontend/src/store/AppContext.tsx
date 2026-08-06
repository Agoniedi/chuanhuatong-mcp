import React, { createContext, useContext, useReducer, useEffect, useCallback } from 'react';
import { getToken, setToken, clearToken } from '../api/client';
import { getMe } from '../api/auth';
import { listRooms } from '../api/rooms';
import type { User, Room, Message } from '../types';

type WsStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

interface AppState {
  token: string | null;
  me: User | null;
  rooms: Room[];
  messages: Record<string, Message[]>;
  wsStatus: WsStatus;
  currentRoomId: string | null;
  lastSeqs: Record<string, number>;
}

type Action =
  | { type: 'SET_TOKEN'; token: string | null }
  | { type: 'SET_ME'; me: User }
  | { type: 'SET_ROOMS'; rooms: Room[] }
  | { type: 'ADD_ROOM'; room: Room }
  | { type: 'MERGE_MESSAGES'; roomId: string; messages: Message[] }
  | { type: 'APPEND_MESSAGE'; roomId: string; message: Message }
  | { type: 'SET_WS_STATUS'; status: WsStatus }
  | { type: 'SET_CURRENT_ROOM'; roomId: string | null }
  | { type: 'LOGOUT' };

const initialState: AppState = {
  token: getToken(),
  me: null,
  rooms: [],
  messages: {},
  wsStatus: 'closed',
  currentRoomId: null,
  lastSeqs: {},
};

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_TOKEN':
      return { ...state, token: action.token };
    case 'SET_ME':
      return { ...state, me: action.me };
    case 'SET_ROOMS':
      return { ...state, rooms: action.rooms };
    case 'ADD_ROOM':
      return { ...state, rooms: [...state.rooms, action.room] };
    case 'MERGE_MESSAGES': {
      const roomMsgs = state.messages[action.roomId] ?? [];
      const messagesById = new Map(roomMsgs.map(message => [message.id, message]));
      for (const message of action.messages) messagesById.set(message.id, message);
      const updated = [...messagesById.values()]
        .sort((a, b) => Number(a.seq) - Number(b.seq));
      const lastSeq = updated.at(-1)?.seq ?? state.lastSeqs[action.roomId] ?? 0;
      return {
        ...state,
        messages: { ...state.messages, [action.roomId]: updated },
        lastSeqs: {
          ...state.lastSeqs,
          [action.roomId]: Math.max(state.lastSeqs[action.roomId] ?? 0, lastSeq),
        },
      };
    }
    case 'APPEND_MESSAGE': {
      const roomMsgs = state.messages[action.roomId] ?? [];
      const exists = roomMsgs.some(m => m.id === action.message.id);
      if (exists) return state;
      const updated = [...roomMsgs, action.message]
        .sort((a, b) => Number(a.seq) - Number(b.seq));
      return {
        ...state,
        messages: { ...state.messages, [action.roomId]: updated },
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
    case 'LOGOUT':
      clearToken();
      return { ...initialState, token: null };
    default:
      return state;
  }
}

interface AppContextType {
  state: AppState;
  dispatch: React.Dispatch<Action>;
  login: (token: string) => Promise<void>;
  logout: () => void;
  refreshRooms: () => Promise<void>;
  loadMessages: (roomId: string, afterSeq?: number) => Promise<Message[]>;
}

const AppContext = createContext<AppContextType | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const login = useCallback(async (token: string) => {
    setToken(token);
    dispatch({ type: 'SET_TOKEN', token });
    const me = await getMe();
    dispatch({ type: 'SET_ME', me });
  }, []);

  const logout = useCallback(() => {
    dispatch({ type: 'LOGOUT' });
  }, []);

  const refreshRooms = useCallback(async () => {
    const rooms = await listRooms();
    dispatch({ type: 'SET_ROOMS', rooms });
  }, []);

  const loadMessages = useCallback(async (roomId: string, afterSeq = 0) => {
    const { listMessages } = await import('../api/messages');
    const messages: Message[] = [];
    let cursor = afterSeq;
    while (true) {
      const result = await listMessages(roomId, cursor, 200);
      messages.push(...result.items);
      if (result.items.length > 0) {
        cursor = result.items[result.items.length - 1].seq;
      }
      if (!result.hasMore || result.items.length === 0) break;
    }
    dispatch({ type: 'MERGE_MESSAGES', roomId, messages });
    return messages;
  }, []);

  useEffect(() => {
    if (state.token && !state.me) {
      getMe().then(me => {
        dispatch({ type: 'SET_ME', me });
        return listRooms();
      }).then(rooms => {
        dispatch({ type: 'SET_ROOMS', rooms });
      }).catch(() => {
        if (getToken()) {
          clearToken();
          dispatch({ type: 'SET_TOKEN', token: null });
        }
      });
    }
  }, [state.token, state.me]);

  return (
    <AppContext.Provider value={{ state, dispatch, login, logout, refreshRooms, loadMessages }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
