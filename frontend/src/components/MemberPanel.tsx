import { useEffect, useState } from 'react';
import { listMembers } from '../api/members';
import { listAgentBindings } from '../api/agent-bindings';
import type { Member, AgentBinding } from '../types';

const participationStatus = {
  off: { label: '停用', className: 'status-off' },
  manual: { label: '手动', className: 'status-manual' },
  automatic: { label: '自动', className: 'status-auto' },
} as const;

interface Props {
  roomId: string;
}

export default function MemberPanel({ roomId }: Props) {
  const [members, setMembers] = useState<Member[]>([]);
  const [agentBindings, setAgentBindings] = useState<AgentBinding[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      listMembers(roomId),
      listAgentBindings(roomId),
    ])
      .then(([memberResult, bindings]) => {
        setMembers(memberResult.items);
        setAgentBindings(bindings);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [roomId]);

  const totalCount = members.length + agentBindings.length;

  return (
    <div className="member-panel">
      <h3>成员 ({totalCount})</h3>
      {loading ? (
        <p className="hint">加载中...</p>
      ) : (
        <>
          {/* Human members */}
          {members.length > 0 && (
            <div className="member-section">
              <div className="member-section-label">成员</div>
              <ul>
                {members.map(m => (
                  <li key={m.userId} className="member-item">
                    <span className="member-role-badge">
                      {m.role === 'owner' ? '房主' : m.role === 'admin' ? '管理' : '成员'}
                    </span>
                    <span className="member-icon">👤</span>
                    <span>{m.displayName}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Agent members */}
          {agentBindings.length > 0 && (
            <div className="member-section">
              <div className="member-section-label">Agent</div>
              <ul>
                {agentBindings.map(b => {
                  const status = participationStatus[b.participationMode];
                  return (
                    <li key={b.bindingId} className="member-item member-agent-item">
                      <span className="member-role-badge agent-badge-inline">AI</span>
                      <span className="member-icon">🤖</span>
                      <span className="member-agent-name">{b.displayName}</span>
                      <span className={`member-agent-status ${status.className}`}>
                        {status.label}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {totalCount === 0 && <p className="hint">暂无成员</p>}
        </>
      )}
    </div>
  );
}
