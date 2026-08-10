import type { Message } from '../types';
import Avatar from './Avatar';

interface Props {
  message: Message;
  isOwn: boolean;
  replyTo?: Message;
  onLocateReply: (messageId: string) => void;
}

function highlightedText(text: string) {
  return text.split(/(@[\p{L}\p{N}_-]+)/gu).map((part, index) =>
    part.startsWith('@')
      ? <mark className="message-mention" key={`${part}-${index}`}>{part}</mark>
      : part,
  );
}

export default function MessageItem({ message, isOwn, replyTo, onLocateReply }: Props) {
  const isAgent = message.sender.kind === 'agent';
  const time = new Date(message.createdAt).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <article
      className={`message-item ${isOwn ? 'message-own' : ''} ${isAgent ? 'message-agent' : ''}`}
      data-message-id={message.id}
    >
      <div className="message-sender">
        {!isOwn && (
          <Avatar
            name={message.sender.displayNameSnapshot}
            resourceId={message.sender.avatarResourceIdSnapshot}
            isAgent={isAgent}
            size="small"
          />
        )}
        <span className="sender-name">
          {isAgent && <span className="agent-badge">AI</span>}
          {message.sender.displayNameSnapshot}
        </span>
        <time className="message-time" dateTime={message.createdAt}>{time}</time>
      </div>
      <div className="message-bubble">
        {message.replyToMessageId && (
          <button
            type="button"
            className="reply-summary"
            disabled={!replyTo}
            onClick={() => onLocateReply(message.replyToMessageId!)}
          >
            <span>{replyTo?.sender.displayNameSnapshot ?? '较早消息'}</span>
            <span>{replyTo?.content.text ?? '原消息尚未加载'}</span>
          </button>
        )}
        <div className="message-text">{highlightedText(message.content.text)}</div>
      </div>
    </article>
  );
}
