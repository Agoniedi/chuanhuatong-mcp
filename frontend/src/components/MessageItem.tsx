import type { Message } from '../types';

interface Props {
  message: Message;
  isOwn: boolean;
}

function AvatarFallback({ name, isAgent }: { name: string; isAgent: boolean }) {
  const initial = name.charAt(0).toUpperCase();
  return (
    <div className={`avatar-fallback ${isAgent ? 'avatar-agent' : 'avatar-human'}`}>
      {isAgent ? '🤖' : initial}
    </div>
  );
}

export default function MessageItem({ message, isOwn }: Props) {
  const isAgent = message.sender.kind === 'agent';
  const time = new Date(message.createdAt).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className={`message-item ${isOwn ? 'message-own' : ''} ${isAgent ? 'message-agent' : ''}`}>
      <div className="message-sender">
        {!isOwn && !isAgent && <AvatarFallback name={message.sender.displayNameSnapshot} isAgent={false} />}
        {!isOwn && isAgent && <AvatarFallback name={message.sender.displayNameSnapshot} isAgent={true} />}
        <span className="sender-name">
          {isAgent && <span className="agent-badge">AI</span>}
          {message.sender.displayNameSnapshot}
        </span>
        <span className="message-time">{time}</span>
      </div>
      <div className="message-bubble">
        <div className="message-text">{message.content.text}</div>
      </div>
    </div>
  );
}