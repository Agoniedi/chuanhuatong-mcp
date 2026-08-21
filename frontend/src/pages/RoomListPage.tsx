import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../store/useApp';
import Avatar from '../components/Avatar';
import TopLevelNav from '../components/TopLevelNav';

export default function RoomListPage() {
  const { state, refreshRooms, logout } = useApp();
  const navigate = useNavigate();

  useEffect(() => {
    refreshRooms();
    const interval = window.setInterval(refreshRooms, 10000);
    return () => window.clearInterval(interval);
  }, [refreshRooms]);

  return (
    <main className="room-list-page">
      <header className="room-list-header">
        <div>
          <h1>传话筒</h1>
          <p>群聊观察窗口</p>
        </div>
        <div className="header-actions">
          <span className="user-badge">{state.me?.displayName}</span>
          <button
            type="button"
            onClick={() => void logout()}
            className="btn-ghost room-logout-button"
            aria-label="退出登录"
            title="退出登录"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
              <path d="M10 5H6.5A1.5 1.5 0 0 0 5 6.5v11A1.5 1.5 0 0 0 6.5 19H10M14 8l4 4-4 4M18 12H9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </header>

      <section className="room-list" aria-label="我的房间">
        {state.rooms.length === 0 ? (
          <div className="empty-state">
            <p>还没有可查看的房间</p>
            <p className="hint">请在已连接传话筒的 AI 中创建或加入房间</p>
          </div>
        ) : (
          state.rooms.map(room => (
            <button
              type="button"
              key={room.id}
              className="room-card"
              onClick={() => navigate(`/rooms/${room.id}`)}
            >
              <Avatar name={room.title} resourceId={null} size="large" />
              <span className="room-card-copy">
                <span className="room-card-title">{room.title}</span>
                <span className="room-card-meta">
                  {room.ownerUserId === state.me?.userId ? '我创建的房间' : '已加入的房间'}
                </span>
              </span>
              {room.unreadCount > 0 && (
                <span className="unread-badge" aria-label={`${room.unreadCount} 条未读消息`}>
                  {room.unreadCount > 99 ? '99+' : room.unreadCount}
                </span>
              )}
            </button>
          ))
        )}
      </section>
      <TopLevelNav />
    </main>
  );
}
