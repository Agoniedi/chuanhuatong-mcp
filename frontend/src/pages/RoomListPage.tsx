import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../store/AppContext';
import { createRoom } from '../api/rooms';

export default function RoomListPage() {
  const { state, dispatch, refreshRooms, logout } = useApp();
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    refreshRooms();
  }, [refreshRooms]);

  // Poll every 10s as a fallback to refresh rooms
  useEffect(() => {
    const interval = setInterval(() => {
      refreshRooms();
    }, 10000);
    return () => clearInterval(interval);
  }, [refreshRooms]);

  const handleCreateRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    const title = newTitle.trim();
    if (!title) return;
    setCreating(true);
    setError(null);
    try {
      const room = await createRoom(title);
      dispatch({ type: 'ADD_ROOM', room });
      setShowCreate(false);
      setNewTitle('');
      navigate(`/rooms/${room.id}`);
    } catch (err: any) {
      setError(err.message ?? '创建房间失败');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="room-list-page">
      <header className="room-list-header">
        <h1>传话筒</h1>
        <div className="header-actions">
          <span className="user-badge">{state.me?.displayName}</span>
          <button onClick={() => setShowCreate(!showCreate)} className="btn-secondary">
            {showCreate ? '取消' : '新建房间'}
          </button>
          <button onClick={logout} className="btn-ghost">退出</button>
        </div>
      </header>

      {showCreate && (
        <form onSubmit={handleCreateRoom} className="create-room-form">
          <input
            type="text"
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            placeholder="房间名称"
            maxLength={120}
            autoFocus
            disabled={creating}
          />
          <button type="submit" className="btn-primary" disabled={creating}>
            {creating ? '创建中...' : '创建'}
          </button>
          {error && <div className="error-message">{error}</div>}
        </form>
      )}

      <div className="room-list">
        {state.rooms.length === 0 ? (
          <div className="empty-state">
            <p>暂无房间</p>
            <p className="hint">创建或通过邀请加入一个房间</p>
          </div>
        ) : (
          state.rooms.map(room => (
            <div
              key={room.id}
              className="room-card"
              onClick={() => navigate(`/rooms/${room.id}`)}
            >
              <div className="room-card-title">{room.title}</div>
              <div className="room-card-meta">
                {room.ownerUserId === state.me?.userId ? '我创建' : '成员'}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}