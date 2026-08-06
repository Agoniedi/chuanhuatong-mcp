import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useApp } from '../store/AppContext';
import { acceptInvite, previewInvite } from '../api/invites';
import type { InvitePreview } from '../api/invites';

export default function JoinPage() {
  const { inviteCode } = useParams<{ inviteCode: string }>();
  const navigate = useNavigate();
  const { state } = useApp();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!inviteCode) return;
    if (!state.token) {
      navigate(`/auth?redirect=/join/${inviteCode}`);
      return;
    }
    // Fetch preview
    setLoading(true);
    setError(null);
    previewInvite(inviteCode)
      .then(data => setPreview(data))
      .catch(err => setError(err.message ?? '邀请链接无效或已过期'))
      .finally(() => setLoading(false));
  }, [inviteCode, state.token, navigate]);

  const handleJoin = async () => {
    if (!inviteCode) return;
    setJoining(true);
    setError(null);
    try {
      const result = await acceptInvite(inviteCode);
      navigate(`/rooms/${result.room.id}`);
    } catch (err: any) {
      setError(err.message ?? '加入房间失败');
    } finally {
      setJoining(false);
    }
  };

  if (!state.token) {
    return <div className="join-page"><p>请先登录...</p></div>;
  }

  return (
    <div className="join-page">
      <div className="join-card">
        <h1>加入房间</h1>
        {loading ? (
          <p>加载中...</p>
        ) : error ? (
          <>
            <div className="error-message">{error}</div>
            <button onClick={() => navigate('/')} className="btn-ghost">返回首页</button>
          </>
        ) : preview ? (
          <>
            <div className="invite-preview-card">
              <div className="invite-preview-row">
                <span className="invite-preview-label">房间名称</span>
                <span className="invite-preview-value">{preview.roomTitle}</span>
              </div>
              <div className="invite-preview-row">
                <span className="invite-preview-label">邀请人</span>
                <span className="invite-preview-value">{preview.inviterDisplayName}</span>
              </div>
              <div className="invite-preview-row">
                <span className="invite-preview-label">剩余次数</span>
                <span className="invite-preview-value">{preview.remainingUses}</span>
              </div>
              <div className="invite-preview-row">
                <span className="invite-preview-label">过期时间</span>
                <span className="invite-preview-value">{new Date(preview.expiresAt).toLocaleDateString('zh-CN')}</span>
              </div>
            </div>
            <button onClick={handleJoin} className="btn-primary" disabled={joining}>
              {joining ? '加入中...' : '加入房间'}
            </button>
            <button onClick={() => navigate('/')} className="btn-ghost" style={{ marginTop: 8 }}>返回首页</button>
          </>
        ) : null}
      </div>
    </div>
  );
}