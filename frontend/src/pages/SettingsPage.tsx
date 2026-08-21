import { useEffect, useState } from 'react';
import { changePassword } from '../api/auth';
import {
  createMcpDevice,
  listAgentProfiles,
  listDevices,
  revokeDevice,
  updateAgentProfile,
  updateMe,
  uploadAvatar,
} from '../api/profiles';
import Avatar from '../components/Avatar';
import {
  applyBubbleColor,
  applyBubbleOpacity,
  clearChatBackground,
  hasChatBackground,
  readBubbleColor,
  readBubbleOpacity,
  saveChatBackground,
} from '../appearance';
import { useApp } from '../store/useApp';
import type { AgentProfile, DeviceInfo, McpDeviceCreation } from '../types';
import TopLevelNav from '../components/TopLevelNav';

function messageFrom(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function mcpServerAddress(mcpUrl: string) {
  const url = new URL(mcpUrl);
  url.search = '';
  return url.toString();
}

function AgentEditor({
  profile,
  onSaved,
}: {
  profile: AgentProfile;
  onSaved: (profile: AgentProfile) => void;
}) {
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [shortBio, setShortBio] = useState(profile.shortBio);
  const [avatar, setAvatar] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const uploaded = avatar ? await uploadAvatar(avatar) : null;
      const updated = await updateAgentProfile(profile.id, {
        expectedProfileRevision: profile.profileRevision,
        displayName: displayName.trim(),
        shortBio,
        ...(uploaded ? { avatarResourceId: uploaded.id } : {}),
      });
      setAvatar(null);
      onSaved(updated);
    } catch (error) {
      setError(messageFrom(error, 'AI 资料保存失败'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="settings-item agent-editor" onSubmit={save}>
      <div className="settings-item-heading agent-editor-heading">
        <Avatar
          name={profile.displayName}
          resourceId={profile.avatarResourceId}
          isAgent
          size="large"
        />
        <div className="agent-editor-title">
          <h3>{profile.displayName}</h3>
          <span className="agent-label">AI 资料 · MCP 消息身份</span>
        </div>
      </div>
      <div className="settings-grid">
        <div className="form-group">
          <label htmlFor={`agent-name-${profile.id}`}>名称</label>
          <input id={`agent-name-${profile.id}`} value={displayName} onChange={event => setDisplayName(event.target.value)} maxLength={80} required />
        </div>
        <div className="form-group">
          <label htmlFor={`agent-avatar-${profile.id}`}>头像</label>
          <input id={`agent-avatar-${profile.id}`} type="file" accept="image/jpeg,image/png,image/webp" onChange={event => setAvatar(event.target.files?.[0] ?? null)} />
        </div>
      </div>
      <div className="form-group">
        <label htmlFor={`agent-bio-${profile.id}`}>简介</label>
        <textarea id={`agent-bio-${profile.id}`} value={shortBio} onChange={event => setShortBio(event.target.value)} maxLength={500} rows={2} />
      </div>
      {error && <p className="error-text">{error}</p>}
      <div className="agent-editor-footer">
        <span>资料更新后会同步到后续 Agent 消息</span>
        <button type="submit" className="btn-primary" disabled={saving}>{saving ? '保存中...' : '保存 AI 资料'}</button>
      </div>
    </form>
  );
}

export default function SettingsPage() {
  const { state, dispatch } = useApp();
  const [displayName, setDisplayName] = useState(state.me?.displayName ?? '');
  const [avatar, setAvatar] = useState<File | null>(null);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [deviceLabel, setDeviceLabel] = useState('新的 MCP 设备');
  const [createdDevice, setCreatedDevice] = useState<McpDeviceCreation | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const [deviceCreating, setDeviceCreating] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordConfirmation, setPasswordConfirmation] = useState('');
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [bubbleOpacity, setBubbleOpacity] = useState(readBubbleOpacity);
  const [bubbleColor, setBubbleColor] = useState(readBubbleColor);
  const [backgroundPresent, setBackgroundPresent] = useState(false);
  const [appearanceSaving, setAppearanceSaving] = useState(false);
  const [copiedCredential, setCopiedCredential] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listAgentProfiles(), listDevices()])
      .then(([agentProfiles, deviceItems]) => {
        setProfiles(agentProfiles);
        setDevices(deviceItems);
      })
      .catch(error => setError(messageFrom(error, '设置加载失败')));
  }, []);

  useEffect(() => {
    void hasChatBackground().then(setBackgroundPresent);
  }, []);

  const saveProfile = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!state.me) return;
    setProfileSaving(true);
    setError(null);
    setNotice(null);
    try {
      const uploaded = avatar ? await uploadAvatar(avatar) : null;
      const updated = await updateMe({
        expectedProfileRevision: state.me.profileRevision,
        displayName: displayName.trim(),
        ...(uploaded ? { avatarResourceId: uploaded.id } : {}),
      });
      dispatch({ type: 'SET_ME', me: updated });
      setAvatar(null);
      setNotice('个人资料已保存');
    } catch (error) {
      setError(messageFrom(error, '个人资料保存失败'));
    } finally {
      setProfileSaving(false);
    }
  };

  const createDevice = async (event: React.FormEvent) => {
    event.preventDefault();
    setDeviceCreating(true);
    setError(null);
    try {
      const created = await createMcpDevice(deviceLabel.trim());
      setCreatedDevice(created);
      setDevices(await listDevices());
    } catch (error) {
      setError(messageFrom(error, '设备 Token 创建失败'));
    } finally {
      setDeviceCreating(false);
    }
  };

  const deactivate = async (deviceId: string) => {
    if (!window.confirm('停用后，这台 MCP 设备当前的 Token 会立即永久失效，且无法恢复。确定停用吗？')) {
      return;
    }
    setError(null);
    try {
      await revokeDevice(deviceId);
      setDevices(await listDevices());
    } catch (error) {
      setError(messageFrom(error, '设备停用失败'));
    }
  };

  const copyCredential = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedCredential(key);
      window.setTimeout(() => setCopiedCredential(current => current === key ? null : current), 1600);
    } catch {
      setCopiedCredential(null);
    }
  };

  const savePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    setPasswordSaving(true);
    setError(null);
    setNotice(null);
    try {
      await changePassword({ currentPassword, newPassword, passwordConfirmation });
      setCurrentPassword('');
      setNewPassword('');
      setPasswordConfirmation('');
      setNotice('密码已修改，其他网页会话已退出');
    } catch (error) {
      setError(messageFrom(error, '密码修改失败'));
    } finally {
      setPasswordSaving(false);
    }
  };

  const changeBubbleOpacity = (value: number) => {
    applyBubbleOpacity(value);
    setBubbleOpacity(value);
  };

  const changeBubbleColor = (value: string) => {
    applyBubbleColor(value);
    setBubbleColor(value);
  };

  const changeChatBackground = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setAppearanceSaving(true);
    setError(null);
    setNotice(null);
    try {
      await saveChatBackground(file);
      setBackgroundPresent(true);
      setNotice('聊天背景已更新');
    } catch (error) {
      setError(messageFrom(error, '聊天背景更新失败'));
    } finally {
      input.value = '';
      setAppearanceSaving(false);
    }
  };

  const removeChatBackground = async () => {
    setAppearanceSaving(true);
    setError(null);
    setNotice(null);
    try {
      await clearChatBackground();
      setBackgroundPresent(false);
      setNotice('聊天背景已移除');
    } catch (error) {
      setError(messageFrom(error, '聊天背景移除失败'));
    } finally {
      setAppearanceSaving(false);
    }
  };

  return (
    <main className="settings-page">
      <header className="settings-header">
        <div>
          <h1>个人设置</h1>
          <p>管理公开资料和自己的设备</p>
        </div>
      </header>

      {error && <div className="error-message" role="alert">{error}</div>}
      {notice && <div className="success-message" role="status">{notice}</div>}

      <section className="settings-section">
        <h2>聊天外观</h2>
        <div className="appearance-controls">
          <div className="appearance-background-row">
            <div
              className={`background-preview ${backgroundPresent ? '' : 'empty'}`}
              aria-hidden="true"
            />
            <div className="appearance-file">
              <label htmlFor="chat-background">聊天背景图</label>
              <input
                id="chat-background"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                disabled={appearanceSaving}
                onChange={event => void changeChatBackground(event)}
              />
            </div>
            <button
              type="button"
              className="btn-ghost"
              disabled={!backgroundPresent || appearanceSaving}
              onClick={() => void removeChatBackground()}
            >
              移除背景
            </button>
          </div>
          <div className="appearance-opacity">
            <div className="appearance-opacity-label">
              <label htmlFor="bubble-opacity">气泡透明度</label>
              <output htmlFor="bubble-opacity">{bubbleOpacity}%</output>
            </div>
            <input
              id="bubble-opacity"
              type="range"
              min="10"
              max="100"
              step="1"
              value={bubbleOpacity}
              onChange={event => changeBubbleOpacity(Number(event.target.value))}
            />
          </div>
          <div className="appearance-color">
            <label htmlFor="bubble-color">我的气泡颜色</label>
            <div className="appearance-color-row">
              <input
                id="bubble-color"
                type="color"
                value={bubbleColor}
                onChange={event => changeBubbleColor(event.target.value)}
                aria-label="选择我的气泡颜色"
              />
              <output htmlFor="bubble-color">{bubbleColor.toUpperCase()}</output>
            </div>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h2>我的资料</h2>
        <form onSubmit={saveProfile} className="settings-form">
          <div className="settings-item-heading">
            <Avatar name={state.me?.displayName ?? ''} resourceId={state.me?.avatarResourceId ?? null} size="large" />
            <span>@{state.me?.handle}</span>
          </div>
          <div className="settings-grid">
            <div className="form-group">
              <label htmlFor="settings-display-name">显示名称</label>
              <input id="settings-display-name" value={displayName} onChange={event => setDisplayName(event.target.value)} maxLength={80} required />
            </div>
            <div className="form-group">
              <label htmlFor="settings-avatar">头像</label>
              <input id="settings-avatar" type="file" accept="image/jpeg,image/png,image/webp" onChange={event => setAvatar(event.target.files?.[0] ?? null)} />
              <p className="form-help">JPEG、PNG 或 WebP，最大 2 MiB</p>
            </div>
          </div>
          <button type="submit" className="btn-secondary" disabled={profileSaving}>{profileSaving ? '保存中...' : '保存个人资料'}</button>
        </form>
      </section>

      <section className="settings-section">
        <div className="settings-section-heading">
          <div>
            <h2>我的 AI</h2>
            <p>管理 MCP 消息使用的 Agent 资料</p>
          </div>
          <span className="settings-section-count">{profiles.length} 个资料</span>
        </div>
        {profiles.length === 0 ? (
          <div className="agent-empty">
            <strong>还没有 AI 资料</strong>
            <span>首次通过 MCP 发布 AI 消息时会自动创建对应资料。</span>
          </div>
        ) : profiles.map(profile => (
          <AgentEditor
            key={profile.id}
            profile={profile}
            onSaved={updated => setProfiles(items => items.map(item => item.id === updated.id ? updated : item))}
          />
        ))}
      </section>

      <section className="settings-section">
        <div className="settings-section-heading">
          <div>
            <h2>MCP 设备</h2>
            <p>连接到传话筒的 AI 客户端</p>
          </div>
          <span className="settings-section-count">
            {devices.filter(device => device.kind === 'mcp' && device.active).length} 个可用
          </span>
        </div>
        <div className="device-list">
          {devices.filter(device => device.kind === 'mcp').length === 0 ? (
            <div className="device-empty">还没有连接的 MCP 设备</div>
          ) : devices.filter(device => device.kind === 'mcp').map(device => (
            <div className="device-row" key={device.deviceId}>
              <span className={`device-status ${device.active ? 'active' : 'inactive'}`} aria-hidden="true" />
              <div className="device-row-copy">
                <strong>{device.label}</strong>
                <span>{device.active ? '可用' : '已停用'}</span>
              </div>
              {device.active && <button type="button" className="btn-ghost danger" onClick={() => void deactivate(device.deviceId)}>停用</button>}
            </div>
          ))}
        </div>
        <form onSubmit={createDevice} className="device-create-form">
          <div className="form-group device-label-field">
            <label htmlFor="device-label">添加设备</label>
            <input id="device-label" value={deviceLabel} onChange={event => setDeviceLabel(event.target.value)} maxLength={80} required />
          </div>
          <button type="submit" className="btn-primary" disabled={deviceCreating}>{deviceCreating ? '创建中...' : '创建 Token'}</button>
        </form>
        {createdDevice && (
          <div className="credential-box">
            <div className="credential-heading">
              <strong>设备已创建</strong>
              <span>请立即保存，关闭后不会再次显示</span>
            </div>
            <label>服务器地址</label>
            <div className="credential-copy-row">
              <code>{mcpServerAddress(createdDevice.mcpUrl)}</code>
              <button type="button" className="btn-ghost" onClick={() => void copyCredential('server', mcpServerAddress(createdDevice.mcpUrl))}>
                {copiedCredential === 'server' ? '已复制' : '复制'}
              </button>
            </div>
            <label>请求头名称</label>
            <div className="credential-copy-row">
              <code>Authorization</code>
              <button type="button" className="btn-ghost" onClick={() => void copyCredential('header-name', 'Authorization')}>
                {copiedCredential === 'header-name' ? '已复制' : '复制'}
              </button>
            </div>
            <label>请求头值</label>
            <div className="credential-copy-row">
              <code>{createdDevice.authorizationHeader}</code>
              <button type="button" className="btn-ghost" onClick={() => void copyCredential('header-value', createdDevice.authorizationHeader)}>
                {copiedCredential === 'header-value' ? '已复制' : '复制'}
              </button>
            </div>
            <div className="credential-guide">
              <strong>Kelivo 配置方法</strong>
              <ol>
                <li>新增 MCP 服务器，传输类型选择 Streamable HTTP。</li>
                <li>填写上方服务器地址。</li>
                <li>添加自定义请求头，并完整填写请求头名称和值。</li>
                <li>保存后等待连接完成，工具数量应显示 19。</li>
              </ol>
              <p>请求头值中的 <code>Bearer</code> 与 Token 之间有一个空格。</p>
            </div>
            <button type="button" className="btn-ghost" onClick={() => setCreatedDevice(null)}>我已保存</button>
          </div>
        )}
      </section>

      <section className="settings-section">
        <h2>修改密码</h2>
        <form className="settings-form password-form" onSubmit={savePassword}>
          <div className="form-group">
            <label htmlFor="current-password">当前密码</label>
            <input id="current-password" type="password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} minLength={6} maxLength={128} autoComplete="current-password" required />
          </div>
          <div className="settings-grid">
            <div className="form-group">
              <label htmlFor="new-password">新密码</label>
              <input id="new-password" type="password" value={newPassword} onChange={event => setNewPassword(event.target.value)} minLength={6} maxLength={128} autoComplete="new-password" required />
            </div>
            <div className="form-group">
              <label htmlFor="confirm-password">确认新密码</label>
              <input id="confirm-password" type="password" value={passwordConfirmation} onChange={event => setPasswordConfirmation(event.target.value)} minLength={6} maxLength={128} autoComplete="new-password" required />
            </div>
          </div>
          <button type="submit" className="btn-secondary" disabled={passwordSaving}>{passwordSaving ? '修改中...' : '修改密码'}</button>
        </form>
      </section>
      <TopLevelNav />
    </main>
  );
}
