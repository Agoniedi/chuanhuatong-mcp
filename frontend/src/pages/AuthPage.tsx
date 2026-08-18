import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { resetPassword } from '../api/auth';
import { useApp } from '../store/useApp';

type Mode = 'login' | 'register' | 'reset';

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export default function AuthPage() {
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [bindingCode, setBindingCode] = useState('');
  const [resetCode, setResetCode] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirmation, setPasswordConfirmation] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { login, register } = useApp();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const switchMode = (nextMode: Mode) => {
    setMode(nextMode);
    setError(null);
    setNotice(null);
    setPassword('');
    setPasswordConfirmation('');
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === 'login') {
        await login(username.trim(), password);
        navigate(searchParams.get('redirect') ?? '/', { replace: true });
        return;
      }
      if (password !== passwordConfirmation) {
        setError('两次输入的密码不一致');
        return;
      }
      if (mode === 'register') {
        await register({
          username: username.trim(),
          displayName: displayName.trim(),
          password,
          passwordConfirmation,
          bindingCode: bindingCode.trim(),
        });
        navigate('/', { replace: true });
        return;
      }
      await resetPassword({
        username: username.trim(),
        newPassword: password,
        passwordConfirmation,
        resetCode: resetCode.trim(),
      });
      setNotice('密码已重置，请使用新密码登录');
      setMode('login');
      setPassword('');
      setPasswordConfirmation('');
    } catch (error) {
      setError(errorMessage(error, mode === 'login' ? '登录失败' : '操作失败'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="auth-title">
        <h1 id="auth-title">传话筒</h1>
        <p className="auth-subtitle">网页端用于安静地查看群聊</p>

        <div className="auth-tabs" role="tablist" aria-label="账号操作">
          <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => switchMode('login')}>登录</button>
          <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => switchMode('register')}>绑定账号</button>
          <button type="button" className={mode === 'reset' ? 'active' : ''} onClick={() => switchMode('reset')}>重置密码</button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="username">用户名</label>
            <input
              id="username"
              value={username}
              onChange={event => setUsername(event.target.value)}
              minLength={3}
              maxLength={32}
              autoComplete="username"
              autoFocus
              disabled={loading}
              required
            />
          </div>

          {mode === 'register' && (
            <>
              <div className="form-group">
                <label htmlFor="displayName">显示名称</label>
                <input
                  id="displayName"
                  value={displayName}
                  onChange={event => setDisplayName(event.target.value)}
                  maxLength={80}
                  disabled={loading}
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="bindingCode">网页绑定码</label>
                <input
                  id="bindingCode"
                  value={bindingCode}
                  onChange={event => setBindingCode(event.target.value.toUpperCase())}
                  placeholder="XXXX-XXXX"
                  maxLength={9}
                  autoComplete="one-time-code"
                  disabled={loading}
                  required
                />
                <p className="form-help">请让已连接传话筒的 AI 为你生成绑定码</p>
              </div>
            </>
          )}

          {mode === 'reset' && (
            <div className="form-group">
              <label htmlFor="resetCode">密码重置码</label>
              <input
                id="resetCode"
                value={resetCode}
                onChange={event => setResetCode(event.target.value.toUpperCase())}
                placeholder="XXXX-XXXX"
                maxLength={9}
                autoComplete="one-time-code"
                disabled={loading}
                required
              />
            </div>
          )}

          <div className="form-group">
            <label htmlFor="password">{mode === 'reset' ? '新密码' : '密码'}</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={event => setPassword(event.target.value)}
              minLength={6}
              maxLength={128}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              disabled={loading}
              required
            />
          </div>

          {mode !== 'login' && (
            <div className="form-group">
              <label htmlFor="passwordConfirmation">确认密码</label>
              <input
                id="passwordConfirmation"
                type="password"
                value={passwordConfirmation}
                onChange={event => setPasswordConfirmation(event.target.value)}
                minLength={6}
                maxLength={128}
                autoComplete="new-password"
                disabled={loading}
                required
              />
            </div>
          )}

          {error && <div className="error-message" role="alert">{error}</div>}
          {notice && <div className="success-message" role="status">{notice}</div>}
          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? '请稍候...' : mode === 'login' ? '登录' : mode === 'register' ? '绑定并登录' : '重置密码'}
          </button>
        </form>
      </section>
    </main>
  );
}
