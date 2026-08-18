import type { Message } from '../types';
import Avatar from './Avatar';

interface Props {
  message: Message;
  isOwn: boolean;
  isGroupStart: boolean;
  isGroupEnd: boolean;
  justArrived: boolean;
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

export default function MessageItem({
  message,
  isOwn,
  isGroupStart,
  isGroupEnd,
  justArrived,
  replyTo,
  onLocateReply,
}: Props) {
  const isAgent = message.sender.kind === 'agent';

  const rowClass = [
    'message-row',
    isOwn ? 'own' : 'other',
    isGroupStart ? 'group-start' : '',
    isGroupEnd ? 'group-end' : '',
    justArrived ? 'just-arrived' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <article className={rowClass} data-message-id={message.id}>
      <div className="msg-avatar-slot">
        {isGroupEnd && (
          <Avatar
            name={message.sender.displayNameSnapshot}
            resourceId={message.sender.avatarResourceIdSnapshot}
            isAgent={isAgent}
            size="small"
          />
        )}
      </div>
      <div className="msg-content">
        {!isOwn && isGroupStart && (
          <div className="msg-name">
            <span className="name-text">{message.sender.displayNameSnapshot}</span>
            {isAgent && <span className="agent-badge">AI</span>}
          </div>
        )}
        <div className="msg-bubble">
          {message.replyToMessageId && (
            <button
              type="button"
              className="reply-summary"
              disabled={!replyTo}
              onClick={() => onLocateReply(message.replyToMessageId!)}
            >
              <span className="reply-quote-name">
                {replyTo?.sender.displayNameSnapshot ?? '较早消息'}
              </span>
              <span className="reply-quote-text">
                {replyTo?.content.text ?? '原消息尚未加载'}
              </span>
            </button>
          )}
          <div className="msg-text">{highlightedText(message.content.text)}</div>
        </div>
      </div>
    </article>
  );
}
