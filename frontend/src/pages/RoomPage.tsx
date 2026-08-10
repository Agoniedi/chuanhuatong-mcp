import { useEffect, useCallback, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useApp } from '../store/useApp';
import { useRealtimeWS } from '../ws/useRealtimeWS';
import MessageList from '../components/MessageList';
import MemberPanel from '../components/MemberPanel';
import { markRoomRead } from '../api/messages';
import type { ProfileUpdatedEvent, User, WsEvent } from '../types';

export default function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const { state, dispatch, loadLatestMessages, loadMessagesAfter } = useApp();
  const [showMembers, setShowMembers] = useState(false);
  const [hasMoreBefore, setHasMoreBefore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const wasConnectedRef = useRef(false);
  const hasConnectedRef = useRef(false);
  const lastMarkedReadRef = useRef(0);
  const room = state.rooms.find(r => r.id === roomId);

  const handleWsEvent = useCallback((event: WsEvent) => {
    if (event.type === 'message.created' && event.roomId && event.payload) {
      dispatch({ type: 'APPEND_MESSAGE', roomId: event.roomId, message: event.payload });
    } else if (event.type === 'profile.updated') {
      const profileEvent = event as ProfileUpdatedEvent;
      if (
        profileEvent.payload.profileType === 'human' &&
        profileEvent.payload.ownerUserId === state.me?.userId
      ) {
        dispatch({ type: 'SET_ME', me: profileEvent.payload.profile as User });
      }
      dispatch({ type: 'PROFILE_UPDATED' });
    }
  }, [dispatch, state.me?.userId]);

  useRealtimeWS(handleWsEvent, (status) => {
    dispatch({ type: 'SET_WS_STATUS', status });
  });

  useEffect(() => {
    if (roomId) {
      dispatch({ type: 'SET_CURRENT_ROOM', roomId });
      setLoading(true);
      setError(null);
      lastMarkedReadRef.current = 0;
      loadLatestMessages(roomId)
        .then(page => setHasMoreBefore(page.hasMore))
        .catch(error => setError(error instanceof Error ? error.message : '消息加载失败'))
        .finally(() => setLoading(false));
    }
    return () => {
      dispatch({ type: 'SET_CURRENT_ROOM', roomId: null });
    };
  }, [roomId, dispatch, loadLatestMessages]);

  useEffect(() => {
    const connected = state.wsStatus === 'open';
    if (connected && !wasConnectedRef.current && roomId) {
      if (hasConnectedRef.current) {
        void loadMessagesAfter(roomId, state.lastSeqs[roomId] ?? 0);
      } else {
        hasConnectedRef.current = true;
      }
    }
    wasConnectedRef.current = connected;
  }, [state.wsStatus, state.lastSeqs, roomId, loadMessagesAfter]);

  const loadOlder = useCallback(async () => {
    if (!roomId) return;
    const oldestSeq = state.messages[roomId]?.[0]?.seq;
    if (oldestSeq === undefined) return;
    const page = await loadLatestMessages(roomId, oldestSeq);
    setHasMoreBefore(page.hasMore);
  }, [loadLatestMessages, roomId, state.messages]);

  const reachedLatest = useCallback((readSeq: number) => {
    if (!roomId || readSeq <= lastMarkedReadRef.current) return;
    const previousReadSeq = lastMarkedReadRef.current;
    lastMarkedReadRef.current = readSeq;
    void markRoomRead(roomId, readSeq)
      .then(result => dispatch({
        type: 'MARK_ROOM_READ',
        roomId,
        readSeq: result.webReadSeq,
      }))
      .catch(() => {
        lastMarkedReadRef.current = previousReadSeq;
      });
  }, [dispatch, roomId]);

  if (!roomId) return null;

  const messages = state.messages[roomId] ?? [];
  const wsLabel = state.wsStatus === 'open' ? '已连接'
    : state.wsStatus === 'connecting' ? '连接中'
    : state.wsStatus === 'reconnecting' ? '重连中'
    : '未连接';

  return (
    <div className="room-page">
      <header className="room-header">
        <button onClick={() => navigate('/')} className="btn-ghost">← 返回</button>
        <h2>{room?.title ?? '加载中...'}</h2>
        <div className="header-actions">
          <span className={`ws-status ${state.wsStatus}`}>{wsLabel}</span>
          <button onClick={() => setShowMembers(!showMembers)} className="btn-secondary">
            {showMembers ? '隐藏成员' : '成员'}
          </button>
        </div>
      </header>
      <div className="room-body">
        <div className="room-main">
          {loading && messages.length === 0 ? (
            <div className="message-loading" aria-label="正在加载消息" />
          ) : error && messages.length === 0 ? (
            <div className="message-list-empty"><p>{error}</p></div>
          ) : (
            <MessageList
              key={roomId}
              messages={messages}
              currentUserId={state.me?.userId ?? ''}
              hasMoreBefore={hasMoreBefore}
              onLoadOlder={loadOlder}
              onReachedLatest={reachedLatest}
            />
          )}
        </div>
        {showMembers && (
          <MemberPanel roomId={roomId} profileVersion={state.profileVersion} />
        )}
      </div>
    </div>
  );
}
