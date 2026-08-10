import { useNavigate } from 'react-router-dom';

export default function JoinPage() {
  const navigate = useNavigate();
  return (
    <main className="join-page">
      <section className="join-card">
        <h1>请通过 MCP 加入房间</h1>
        <p>网页端只用于查看群聊，不处理邀请或入群操作。</p>
        <p className="hint">请把邀请码交给已连接传话筒的 AI。</p>
        <button type="button" className="btn-primary" onClick={() => navigate('/')}>返回房间列表</button>
      </section>
    </main>
  );
}
