import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getWorldRoom, listWorldRooms, updateWorldRoom } from '../api/rooms';
import { useApp } from '../store/useApp';
import type { Room, WorldRoom, WorldRoomDetail } from '../types';
import TopLevelNav from '../components/TopLevelNav';

function formatDate(iso: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).format(new Date(iso));
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const input = document.createElement('textarea');
  input.value = value;
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand('copy');
  input.remove();
  if (!copied) throw new Error('copy_failed');
}

function RoomIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 7.5A2.5 2.5 0 0 1 7.5 5h9A2.5 2.5 0 0 1 19 7.5v6a2.5 2.5 0 0 1-2.5 2.5H12l-3.8 3v-3H7.5A2.5 2.5 0 0 1 5 13.5v-6Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M8.5 9.5h7M8.5 12.5h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export default function WorldPage() {
  const navigate = useNavigate();
  const { state, refreshRooms } = useApp();
  const [worldRooms, setWorldRooms] = useState<WorldRoom[]>([]);
  const [selectedRoom, setSelectedRoom] = useState<WorldRoom | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<WorldRoomDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [editingRoom, setEditingRoom] = useState<Room | null>(null);
  const [summaryDraft, setSummaryDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const ownedRooms = useMemo(
    () => state.rooms.filter(room => room.ownerUserId === state.me?.userId),
    [state.me?.userId, state.rooms],
  );

  const loadWorldRooms = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setWorldRooms(await listWorldRooms());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '世界加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWorldRooms();
  }, [loadWorldRooms]);

  useEffect(() => {
    if (!selectedRoom && !editingRoom) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSelectedRoom(null);
        setSelectedDetail(null);
        setEditingRoom(null);
      }
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [editingRoom, selectedRoom]);

  const openEditor = (room: Room) => {
    setEditingRoom(room);
    setSummaryDraft(room.worldSummary ?? '');
    setError(null);
  };

  const openDetails = async (room: WorldRoom) => {
    setSelectedRoom(room);
    setSelectedDetail(null);
    setDetailLoading(true);
    setCopyState('idle');
    try {
      setSelectedDetail(await getWorldRoom(room.id));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '房间详情加载失败');
    } finally {
      setDetailLoading(false);
    }
  };

  const saveWorldRoom = async () => {
    if (!editingRoom) return;
    setSaving(true);
    setError(null);
    try {
      await updateWorldRoom(editingRoom.id, true, summaryDraft.trim());
      setEditingRoom(null);
      await Promise.all([loadWorldRooms(), refreshRooms()]);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '发布失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  const unpublishRoom = async (room: Room) => {
    setSaving(true);
    setError(null);
    try {
      await updateWorldRoom(room.id, false);
      await Promise.all([loadWorldRooms(), refreshRooms()]);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '取消分享失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  const copyInvite = async () => {
    if (!selectedDetail) return;
    setCopyState('idle');
    try {
      await copyText(selectedDetail.inviteToken);
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 1600);
    } catch {
      setCopyState('failed');
    }
  };

  return (
    <main className="world-page">
      <header className="world-header">
        <div className="world-heading">
          <button type="button" className="btn-ghost world-back-button" onClick={() => navigate('/')} aria-label="返回房间列表">
            <svg viewBox="0 0 20 20" width="18" height="18" fill="none" aria-hidden="true">
              <path d="M12.5 5 7.5 10l5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <div>
            <h1>世界</h1>
            <p>发现别人愿意分享的群聊房间</p>
          </div>
        </div>
        <div className="header-actions">
          <button type="button" className="btn-ghost world-refresh-button" onClick={() => void loadWorldRooms()} disabled={loading} aria-label="刷新世界" title="刷新世界">
            <svg viewBox="0 0 20 20" width="18" height="18" fill="none" aria-hidden="true">
              <path d="M16 9a6 6 0 0 0-10.7-3.7L4 6.8M4 4v2.8h2.8M4 11a6 6 0 0 0 10.7 3.7l1.3-1.5M16 16v-2.8h-2.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </header>

      {error && <div className="world-error" role="alert">{error}</div>}

      <section className="world-section" aria-labelledby="world-discover-heading">
        <div className="world-section-heading">
          <div>
            <h2 id="world-discover-heading">正在分享</h2>
            <p>打开详情，获取房间简介和邀请码</p>
          </div>
          <span className="world-count">{worldRooms.length} 个房间</span>
        </div>
        {loading ? (
          <div className="world-grid" aria-label="正在加载世界房间">
            {[1, 2, 3].map(item => <div className="world-card world-card-skeleton" key={item} />)}
          </div>
        ) : worldRooms.length === 0 ? (
          <div className="world-empty">
            <RoomIcon />
            <p>还没有公开分享的房间</p>
            <span>在下方选择一个自己创建的房间，把它放进世界。</span>
          </div>
        ) : (
          <div className="world-grid">
            {worldRooms.map(room => (
              <button type="button" className="world-card" key={room.id} onClick={() => void openDetails(room)}>
                <span className="world-card-icon"><RoomIcon /></span>
                <span className="world-card-title">{room.title}</span>
                <span className="world-card-owner">房主 · {room.ownerDisplayName}</span>
                <span className="world-card-summary">{room.summary || '房主还没有填写房间简介。'}</span>
                <span className="world-card-link">查看详情 <span aria-hidden="true">→</span></span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="world-section world-manage-section" aria-labelledby="world-manage-heading">
        <div className="world-section-heading">
          <div>
            <h2 id="world-manage-heading">分享我的房间</h2>
            <p>只有你创建的房间可以发布到世界</p>
          </div>
        </div>
        {ownedRooms.length === 0 ? (
          <div className="world-manage-empty">你还没有创建房间。</div>
        ) : (
          <div className="world-manage-list">
            {ownedRooms.map(room => (
              <div className="world-manage-row" key={room.id}>
                <div className="world-manage-info">
                  <strong>{room.title}</strong>
                  <span>{room.worldPublished ? '已发布到世界' : '仅自己和成员可见'}</span>
                </div>
                <div className="world-manage-actions">
                  <button type="button" className="btn-secondary" onClick={() => openEditor(room)} disabled={saving}>
                    {room.worldPublished ? '编辑展示' : '分享到世界'}
                  </button>
                  {room.worldPublished && (
                    <button type="button" className="btn-ghost danger" onClick={() => void unpublishRoom(room)} disabled={saving}>取消分享</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {selectedRoom && (
        <div className="world-dialog-backdrop" role="presentation" onClick={() => { setSelectedRoom(null); setSelectedDetail(null); }}>
          <section className="world-dialog" role="dialog" aria-modal="true" aria-labelledby="world-detail-title" onClick={event => event.stopPropagation()}>
            <div className="world-dialog-header">
              <div>
                <p className="world-dialog-kicker">房间详情</p>
                <h2 id="world-detail-title">{selectedRoom.title}</h2>
              </div>
              <button type="button" className="btn-ghost world-dialog-close" onClick={() => { setSelectedRoom(null); setSelectedDetail(null); }} aria-label="关闭详情">×</button>
            </div>
            <p className="world-dialog-owner">房主 · {selectedRoom.ownerDisplayName}</p>
            {detailLoading || !selectedDetail ? (
              <div className="world-dialog-loading">{detailLoading ? '正在加载详情...' : '详情加载失败，请关闭后重试。'}</div>
            ) : (
              <>
                <div className="world-dialog-summary">{selectedDetail.summary || '房主还没有填写房间简介。'}</div>
                <div className="world-invite-block">
                  <div className="world-invite-label"><span>邀请码</span><span>剩余 {selectedDetail.remainingUses} 次</span></div>
                  <div className="world-invite-row">
                    <code>{selectedDetail.inviteToken}</code>
                    <button type="button" className="btn-secondary" onClick={() => void copyInvite()}>
                      {copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制'}
                    </button>
                  </div>
                  <p className="world-invite-expiry">有效期至 {formatDate(selectedDetail.inviteExpiresAt)}</p>
                </div>
              </>
            )}
            <button type="button" className="btn-primary world-dialog-action" onClick={() => { setSelectedRoom(null); setSelectedDetail(null); }}>完成</button>
          </section>
        </div>
      )}

      {editingRoom && (
        <div className="world-dialog-backdrop" role="presentation" onClick={() => setEditingRoom(null)}>
          <section className="world-dialog" role="dialog" aria-modal="true" aria-labelledby="world-edit-title" onClick={event => event.stopPropagation()}>
            <div className="world-dialog-header">
              <div>
                <p className="world-dialog-kicker">分享房间</p>
                <h2 id="world-edit-title">{editingRoom.title}</h2>
              </div>
              <button type="button" className="btn-ghost world-dialog-close" onClick={() => setEditingRoom(null)} aria-label="关闭分享设置">×</button>
            </div>
            <label className="world-summary-label" htmlFor="world-summary">房间简介</label>
            <textarea
              id="world-summary"
              className="world-summary-input"
              value={summaryDraft}
              maxLength={300}
              onChange={event => setSummaryDraft(event.target.value)}
              placeholder="用一句话介绍这个房间适合讨论什么"
              autoFocus
            />
            <div className="world-summary-footer"><span>简介会展示给世界中的访客</span><span>{summaryDraft.length}/300</span></div>
            <button type="button" className="btn-primary world-dialog-action" onClick={() => void saveWorldRoom()} disabled={saving}>
              {saving ? '正在发布...' : editingRoom.worldPublished ? '保存展示信息' : '发布到世界'}
            </button>
          </section>
        </div>
      )}
      <TopLevelNav />
    </main>
  );
}
