import { useEffect, useCallback, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useApp } from '../store/useApp';
import { useRealtimeWS } from '../ws/useRealtimeWS';
import MessageList from '../components/MessageList';
import MemberPanel from '../components/MemberPanel';
import SendBar from '../components/SendBar';
import { markRoomRead, recallMessage } from '../api/messages';
import { deleteRoom } from '../api/rooms';
import type { MessageRecalledEvent, ProfileUpdatedEvent, RoomDeletedEvent, User, WsEvent } from '../types';

export default function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const { state, dispatch, loadLatestMessages, loadMessagesAfter } = useApp();
  const [showMembers, setShowMembers] = useState(false);
  const [hasMoreBefore, setHasMoreBefore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [roomActionError, setRoomActionError] = useState<string | null>(null);
  const [deletingRoom, setDeletingRoom] = useState(false);
  const wasConnectedRef = useRef(false);
  const hasConnectedRef = useRef(false);
  const lastMarkedReadRef = useRef(0);
  const room = state.rooms.find(r => r.id === roomId);

  const handleWsEvent = useCallback((event: WsEvent) => {
    if (event.type === 'message.created' && event.roomId && event.payload) {
      dispatch({ type: 'APPEND_MESSAGE', roomId: event.roomId, message: event.payload });
    } else if (event.type === 'message.recalled') {
      const recallEvent = event as MessageRecalledEvent;
      dispatch({
        type: 'REPLACE_MESSAGE',
        roomId: recallEvent.roomId,
        message: recallEvent.payload,
      });
    } else if (event.type === 'room.deleted') {
      const deletedEvent = event as RoomDeletedEvent;
      dispatch({ type: 'REMOVE_ROOM', roomId: deletedEvent.roomId });
      if (deletedEvent.roomId === roomId) navigate('/');
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
  }, [dispatch, navigate, roomId, state.me?.userId]);

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

  const handleRecall = useCallback(async (message: MessageRecalledEvent['payload']) => {
    if (!roomId) return;
    const recalled = await recallMessage(roomId, message.id);
    dispatch({ type: 'REPLACE_MESSAGE', roomId, message: recalled });
  }, [dispatch, roomId]);

  const handleDeleteRoom = async () => {
    if (!roomId || !window.confirm('确定删除这个房间吗？房间及全部消息将永久删除。')) return;
    setDeletingRoom(true);
    setRoomActionError(null);
    try {
      await deleteRoom(roomId);
      dispatch({ type: 'REMOVE_ROOM', roomId });
      navigate('/');
    } catch {
      setRoomActionError('房间删除失败，请重试');
      setDeletingRoom(false);
    }
  };

  if (!roomId) return null;

  const messages = state.messages[roomId] ?? [];
  const wsLabel = state.wsStatus === 'open' ? '已连接'
    : state.wsStatus === 'connecting' ? '连接中'
    : state.wsStatus === 'reconnecting' ? '重连中'
    : '未连接';

  return (
    <div className="room-page">
      <header className="room-header">
        <button onClick={() => navigate('/')} className="btn-ghost" aria-label="返回房间列表">
          <svg viewBox="0 0 20 20" width="18" height="18" fill="none" aria-hidden="true">
            <path d="M12.5 5l-5 5 5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="room-title-group">
          <h2>{room?.title ?? '加载中...'}</h2>
          <div className="room-subline">
            <span className={`ws-status ${state.wsStatus}`}>{wsLabel}</span>
          </div>
        </div>
        <div className="header-actions">
          {room?.ownerUserId === state.me?.userId && (
            <button
              type="button"
              onClick={() => void handleDeleteRoom()}
              className="btn-ghost danger room-delete-button"
              aria-label="删除房间"
              title="删除房间"
              disabled={deletingRoom}
            >
              <svg viewBox="0 0 20 20" width="18" height="18" fill="none" aria-hidden="true">
                <path d="M4.5 6h11M8 3.5h4M6.2 6l.6 10h6.4l.6-10M8.3 9v4.5M11.7 9v4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
          <button
            onClick={() => setShowMembers(!showMembers)}
            className="btn-secondary"
            aria-pressed={showMembers}
          >
            {showMembers ? '隐藏成员' : '成员'}
          </button>
        </div>
      </header>
      {roomActionError && <div className="room-action-error" role="alert">{roomActionError}</div>}
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
              onRecall={handleRecall}
            />
          )}
          <SendBar
            roomId={roomId}
            onSent={message => dispatch({ type: 'APPEND_MESSAGE', roomId, message })}
          />
        </div>
        {showMembers && (
          <>
            <div
              className="panel-scrim"
              onClick={() => setShowMembers(false)}
              aria-hidden="true"
            />
            <MemberPanel roomId={roomId} profileVersion={state.profileVersion} />
          </>
        )}
      </div>
    </div>
  );
}
