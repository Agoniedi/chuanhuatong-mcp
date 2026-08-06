import { useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useApp } from '../store/AppContext';
import { register } from '../api/auth';

export default function AuthPage() {
  const [displayName, setDisplayName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const registrationAttempt = useRef<{ displayName: string; key: string } | null>(null);
  const { login } = useApp();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = displayName.trim();
    if (!name || name.length < 1 || name.length > 80) {
      setError('显示名称为 1-80 个字符');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      if (registrationAttempt.current?.displayName !== name) {
        registrationAttempt.current = {
          displayName: name,
          key: crypto.randomUUID(),
        };
      }
      const result = await register(name, registrationAttempt.current.key);
      await login(result.token);
      navigate(searchParams.get('redirect') ?? '/', { replace: true });
    } catch (err: any) {
      setError(err.message ?? '注册失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>传话筒</h1>
        <p className="auth-subtitle">群聊消息中转站</p>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="displayName">显示名称</label>
            <input
              id="displayName"
              type="text"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              placeholder="输入你的名字"
              maxLength={80}
              autoFocus
              disabled={loading}
            />
          </div>
          {error && <div className="error-message">{error}</div>}
          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? '注册中...' : '加入聊天'}
          </button>
        </form>
      </div>
    </div>
  );
}
