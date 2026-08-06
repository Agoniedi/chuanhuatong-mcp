import { useState } from 'react';
import { newRequestId } from '../api/request-id';

interface Props {
  roomId: string;
  onClose: () => void;
}

export default function InviteModal({ roomId, onClose }: Props) {
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      // Use the room endpoint to get an invite
      const { listRooms } = await import('../api/rooms');
      const rooms = await listRooms();
      const room = rooms.find(r => r.id === roomId);
      if (!room) throw new Error('房间不存在');

      // Create invite via API
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const response = await fetch(`/v1/rooms/${roomId}/invites`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('chuanhuatong_token')}`,
          'Idempotency-Key': newRequestId(),
        },
        body: JSON.stringify({
          expectedRoomRevision: room.revision,
          expiresAt,
          maxUses: 10,
        }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data?.error?.message ?? '创建邀请失败');
      }
      const data = await response.json();
      setInviteToken(data.inviteToken);
    } catch (err: any) {
      setError(err.message ?? '创建邀请失败');
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = () => {
    if (!inviteToken) return;
    const link = `${window.location.origin}/join/${inviteToken}`;
    navigator.clipboard.writeText(link).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <h3>邀请成员</h3>
        <button className="modal-close" onClick={onClose}>×</button>

        {!inviteToken ? (
          <div>
            <p>创建邀请链接，发送给其他人加入房间</p>
            {error && <div className="error-message">{error}</div>}
            <button onClick={handleCreate} className="btn-primary" disabled={creating}>
              {creating ? '创建中...' : '创建邀请链接'}
            </button>
          </div>
        ) : (
          <div className="invite-result">
            <p>邀请链接已创建：</p>
            <div className="invite-link-box">
              <code>{window.location.origin}/join/{inviteToken}</code>
            </div>
            <button onClick={handleCopy} className="btn-primary">
              {copied ? '已复制' : '复制链接'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
