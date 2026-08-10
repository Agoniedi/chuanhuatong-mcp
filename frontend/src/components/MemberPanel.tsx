import { useEffect, useState } from 'react';
import { listAgentBindings } from '../api/agent-bindings';
import { listMembers } from '../api/members';
import type { AgentBinding, Member } from '../types';
import Avatar from './Avatar';

interface Props {
  roomId: string;
  profileVersion: number;
}

export default function MemberPanel({ roomId, profileVersion }: Props) {
  const [members, setMembers] = useState<Member[]>([]);
  const [agentBindings, setAgentBindings] = useState<AgentBinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([listMembers(roomId), listAgentBindings(roomId)])
      .then(([memberResult, bindings]) => {
        setMembers(memberResult.items);
        setAgentBindings(bindings);
      })
      .catch(error => setError(error instanceof Error ? error.message : '成员加载失败'))
      .finally(() => setLoading(false));
  }, [roomId, profileVersion]);

  const totalCount = members.length + agentBindings.length;

  return (
    <aside className="member-panel" aria-label="房间成员">
      <h3>成员 <span>{totalCount}</span></h3>
      {loading ? (
        <div className="member-skeleton" aria-label="正在加载成员" />
      ) : error ? (
        <p className="error-text">{error}</p>
      ) : members.length === 0 ? (
        <p className="hint">暂无成员</p>
      ) : (
        <ul className="member-groups">
          {members.map(member => {
            const agents = agentBindings.filter(binding => binding.ownerUserId === member.userId);
            return (
              <li key={member.userId} className="member-group">
                <div className="member-item">
                  <Avatar name={member.displayName} resourceId={member.avatarResourceId} />
                  <span className="member-name">{member.displayName}</span>
                  {member.role !== 'member' && (
                    <span className="member-role-badge">
                      {member.role === 'owner' ? '房主' : '管理'}
                    </span>
                  )}
                </div>
                {agents.length > 0 && (
                  <ul className="member-agents">
                    {agents.map(agent => (
                      <li key={agent.bindingId} className="member-item member-agent-item">
                        <Avatar
                          name={agent.displayName}
                          resourceId={agent.avatarResourceId}
                          isAgent
                          size="small"
                        />
                        <span className="member-agent-name">{agent.displayName}</span>
                        <span className="agent-badge agent-badge-inline">AI</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
