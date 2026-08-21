import React, { useCallback, useEffect, useReducer } from 'react';
import {
  getMe,
  login as loginRequest,
  logout as logoutRequest,
  registerWebAccount,
} from '../api/auth';
import { listRooms } from '../api/rooms';
import { listLatestMessages, listMessagesAfter } from '../api/messages';
import type { MessagePage } from '../api/messages';
import type { User } from '../types';
import { AppContext } from './context';
import { initialState, reducer } from './reducer';
import type { Action, AppState } from './reducer';

interface RegistrationInput {
  username: string;
  displayName: string;
  password: string;
  passwordConfirmation: string;
  bindingCode: string;
}

export interface AppContextType {
  state: AppState;
  dispatch: React.Dispatch<Action>;
  login: (username: string, password: string) => Promise<void>;
  register: (input: RegistrationInput) => Promise<void>;
  logout: () => Promise<void>;
  refreshRooms: () => Promise<void>;
  loadLatestMessages: (roomId: string, beforeSeq?: number | null) => Promise<MessagePage>;
  loadMessagesAfter: (roomId: string, afterSeq: number) => Promise<MessagePage>;
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const loadAuthenticatedState = useCallback(async (me: User) => {
    dispatch({ type: 'SET_AUTHENTICATED', me });
    const rooms = await listRooms();
    dispatch({ type: 'SET_ROOMS', rooms });
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const me = await loginRequest(username, password);
    await loadAuthenticatedState(me);
  }, [loadAuthenticatedState]);

  const register = useCallback(async (input: RegistrationInput) => {
    const me = await registerWebAccount(input);
    await loadAuthenticatedState(me);
  }, [loadAuthenticatedState]);

  const logout = useCallback(async () => {
    try {
      await logoutRequest();
    } finally {
      dispatch({ type: 'LOGOUT' });
    }
  }, []);

  const refreshRooms = useCallback(async () => {
    const rooms = await listRooms();
    dispatch({ type: 'SET_ROOMS', rooms });
  }, []);

  const loadLatestMessages = useCallback(async (
    roomId: string,
    beforeSeq: number | null = null,
  ) => {
    const result = await listLatestMessages(roomId, beforeSeq);
    dispatch({ type: 'MERGE_MESSAGES', roomId, messages: result.items });
    return result;
  }, []);

  const loadMessagesAfter = useCallback(async (roomId: string, afterSeq: number) => {
    const result = await listMessagesAfter(roomId, afterSeq);
    dispatch({ type: 'MERGE_MESSAGES', roomId, messages: result.items });
    return result;
  }, []);

  useEffect(() => {
    let cancelled = false;
    getMe()
      .then(async me => {
        if (cancelled) return;
        await loadAuthenticatedState(me);
      })
      .catch(() => {
        if (!cancelled) dispatch({ type: 'SET_ANONYMOUS' });
      });
    return () => {
      cancelled = true;
    };
  }, [loadAuthenticatedState]);

  return (
    <AppContext.Provider value={{
      state,
      dispatch,
      login,
      register,
      logout,
      refreshRooms,
      loadLatestMessages,
      loadMessagesAfter,
    }}>
      {children}
    </AppContext.Provider>
  );
}
