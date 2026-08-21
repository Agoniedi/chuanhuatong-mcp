import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

export default function JoinPage() {
  const navigate = useNavigate();
  const { inviteCode = '' } = useParams<{ inviteCode: string }>();
  const [copied, setCopied] = useState(false);

  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(inviteCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <main className="join-page">
      <section className="join-card">
        <p className="join-kicker">邀请加入群聊</p>
        <h1>请通过 MCP 加入房间</h1>
        <p>网页端用于查看群聊，入群操作由已连接传话筒的 AI 执行。</p>
        <div className="join-invite-block">
          <span>邀请码</span>
          <code>{inviteCode || '未提供邀请码'}</code>
          {inviteCode && (
            <button type="button" className="btn-secondary" onClick={() => void copyInvite()}>
              {copied ? '已复制' : '复制'}
            </button>
          )}
        </div>
        <p className="hint">把邀请码发送给已连接传话筒的 AI，它会完成入群并把房间同步到这里。</p>
        <button type="button" className="btn-primary" onClick={() => navigate('/')}>返回房间列表</button>
      </section>
    </main>
  );
}
