import { useEffect, useRef, useState } from 'react';
import type { Message } from '../types';
import Avatar from './Avatar';

const RECALL_WINDOW_MS = 5 * 60 * 1000;
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_TOLERANCE = 8;

interface Props {
  message: Message;
  isOwn: boolean;
  isGroupStart: boolean;
  isGroupEnd: boolean;
  justArrived: boolean;
  replyTo?: Message;
  currentUserId: string;
  onLocateReply: (messageId: string) => void;
  onRecall: (message: Message) => Promise<void>;
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
  currentUserId,
  onLocateReply,
  onRecall,
}: Props) {
  const isAgent = message.sender.kind === 'agent';
  const [now, setNow] = useState(Date.now());
  const [recalling, setRecalling] = useState(false);
  const [recallError, setRecallError] = useState<string | null>(null);
  const [showActions, setShowActions] = useState(false);
  const actionAreaRef = useRef<HTMLDivElement>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const pressStartRef = useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);
  const recallDeadline = new Date(message.createdAt).getTime() + RECALL_WINDOW_MS;
  const canRecall = !message.recalledAt
    && message.sender.userId === currentUserId
    && now <= recallDeadline;

  useEffect(() => {
    if (!canRecall) return;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(0, recallDeadline - Date.now() + 1),
    );
    return () => window.clearTimeout(timer);
  }, [canRecall, recallDeadline]);

  useEffect(() => {
    if (!showActions) return;
    const closeActions = (event: PointerEvent) => {
      if (!actionAreaRef.current?.contains(event.target as Node)) setShowActions(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowActions(false);
    };
    document.addEventListener('pointerdown', closeActions);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeActions);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [showActions]);

  useEffect(() => {
    if (!canRecall) setShowActions(false);
    return () => {
      if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current);
    };
  }, [canRecall]);

  const cancelLongPress = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    pressStartRef.current = null;
  };

  const startLongPress = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!canRecall || event.button !== 0) return;
    cancelLongPress();
    pressStartRef.current = { x: event.clientX, y: event.clientY };
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = null;
      pressStartRef.current = null;
      suppressClickRef.current = true;
      setRecallError(null);
      setShowActions(true);
    }, LONG_PRESS_MS);
  };

  const trackLongPress = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = pressStartRef.current;
    if (!start) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_MOVE_TOLERANCE) {
      cancelLongPress();
    }
  };

  const finishLongPress = () => {
    cancelLongPress();
    if (suppressClickRef.current) {
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    }
  };

  const handleRecall = async () => {
    setShowActions(false);
    setRecalling(true);
    setRecallError(null);
    try {
      await onRecall(message);
    } catch {
      setNow(Date.now());
      setRecallError('撤回失败，请重试');
    } finally {
      setRecalling(false);
    }
  };

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
      <div
        className="msg-content"
        ref={actionAreaRef}
        tabIndex={canRecall ? 0 : undefined}
        aria-label={canRecall ? `${message.sender.displayNameSnapshot} 发送的消息操作` : undefined}
        aria-haspopup={canRecall ? 'menu' : undefined}
        aria-expanded={canRecall ? showActions : undefined}
        onKeyDown={(event) => {
          if (canRecall && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
            event.preventDefault();
            setShowActions(true);
          }
        }}
      >
        {!isOwn && isGroupStart && (
          <div className="msg-name">
            <span className="name-text">{message.sender.displayNameSnapshot}</span>
            {isAgent && <span className="agent-badge">AI</span>}
          </div>
        )}
        <div
          className={`msg-bubble${message.recalledAt ? ' recalled' : ''}${canRecall ? ' can-recall' : ''}`}
          onPointerDown={startLongPress}
          onPointerMove={trackLongPress}
          onPointerUp={finishLongPress}
          onPointerCancel={cancelLongPress}
          onClickCapture={(event) => {
            if (!suppressClickRef.current) return;
            event.preventDefault();
            event.stopPropagation();
            suppressClickRef.current = false;
          }}
          onContextMenu={(event) => {
            if (!canRecall) return;
            event.preventDefault();
            cancelLongPress();
            setShowActions(true);
          }}
        >
          {!message.recalledAt && message.replyToMessageId && (
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
                {replyTo?.recalledAt ? '消息已撤回' : replyTo?.content.text ?? '原消息尚未加载'}
              </span>
            </button>
          )}
          <div className="msg-text">
            {message.recalledAt ? '消息已撤回' : highlightedText(message.content.text)}
          </div>
        </div>
        {showActions && canRecall && (
          <div className="message-action-menu" role="menu">
            <button
              type="button"
              role="menuitem"
              className="message-action-recall"
              disabled={recalling}
              onClick={() => void handleRecall()}
            >
              {recalling ? '撤回中...' : '撤回'}
            </button>
          </div>
        )}
        {recallError && canRecall && (
          <span className="message-recall-error" role="alert">{recallError}</span>
        )}
      </div>
    </article>
  );
}
