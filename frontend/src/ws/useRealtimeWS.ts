import { useEffect, useRef, useCallback } from 'react';
import { getToken } from '../api/client';
import type { WsEvent } from '../types';

type WsStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';
type WsEventHandler = (event: WsEvent) => void;

const INITIAL_RETRY_MS = 1000;
const MAX_RETRY_MS = 30000;

export function useRealtimeWS(
  onEvent: WsEventHandler,
  onStatusChange: (status: WsStatus) => void,
) {
  const wsRef = useRef<WebSocket | null>(null);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onEventRef = useRef(onEvent);
  const onStatusChangeRef = useRef(onStatusChange);
  onEventRef.current = onEvent;
  onStatusChangeRef.current = onStatusChange;

  const connect = useCallback(() => {
    const token = getToken();
    if (!token) return;

    onStatusChangeRef.current('connecting');
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/v1/realtime?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      retryCountRef.current = 0;
      onStatusChangeRef.current('open');
    };

    ws.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as WsEvent;
        onEventRef.current(event);
      } catch { /* ignore parse errors */ }
    };

    ws.onclose = () => {
      if (wsRef.current === ws) {
        onStatusChangeRef.current('reconnecting');
        const delay = Math.min(
          INITIAL_RETRY_MS * Math.pow(2, retryCountRef.current),
          MAX_RETRY_MS,
        );
        const jitter = delay * (0.8 + Math.random() * 0.4);
        retryCountRef.current += 1;
        retryTimerRef.current = setTimeout(connect, jitter);
      }
    };

    ws.onerror = () => {
      ws.close();
    };

    wsRef.current = ws;
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    };
  }, [connect]);
}