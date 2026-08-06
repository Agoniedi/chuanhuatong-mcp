import { useEffect, useCallback, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useApp } from '../store/AppContext';
import { useRealtimeWS } from '../ws/useRealtimeWS';
import MessageList from '../components/MessageList';
import SendBar from '../components/SendBar';
import MemberPanel from '../components/MemberPanel';
import InviteModal from '../components/InviteModal';
import type { WsEvent } from '../types';

export default function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const { state, dispatch, loadMessages } = useApp();
  const [showMembers, setShowMembers] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const wasConnectedRef = useRef(false);
  const room = state.rooms.find(r => r.id === roomId);

  const handleWsEvent = useCallback((event: WsEvent) => {
    if (event.type === 'message.created' && event.roomId && event.payload) {
      dispatch({ type: 'APPEND_MESSAGE', roomId: event.roomId, message: event.payload });
    }
  }, [dispatch]);

  useRealtimeWS(handleWsEvent, (status) => {
    dispatch({ type: 'SET_WS_STATUS', status });
  });

  useEffect(() => {
    if (roomId) {
      dispatch({ type: 'SET_CURRENT_ROOM', roomId });
      loadMessages(roomId, 0);
    }
    return () => {
      dispatch({ type: 'SET_CURRENT_ROOM', roomId: null });
    };
  }, [roomId, dispatch, loadMessages]);

  useEffect(() => {
    const connected = state.wsStatus === 'open';
    if (connected && !wasConnectedRef.current && roomId) {
      loadMessages(roomId, state.lastSeqs[roomId] ?? 0);
    }
    wasConnectedRef.current = connected;
  }, [state.wsStatus, state.lastSeqs, roomId, loadMessages]);

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
          <button onClick={() => setShowInvite(true)} className="btn-secondary">邀请</button>
          <button onClick={() => setShowMembers(!showMembers)} className="btn-secondary">
            {showMembers ? '隐藏成员' : '成员'}
          </button>
        </div>
      </header>
      <div className="room-body">
        <div className="room-main">
          <MessageList
            messages={messages}
            currentUserId={state.me?.userId ?? ''}
          />
          <SendBar roomId={roomId} />
        </div>
        {showMembers && <MemberPanel roomId={roomId} />}
      </div>
      {showInvite && <InviteModal roomId={roomId} onClose={() => setShowInvite(false)} />}
    </div>
  );
}
