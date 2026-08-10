import { useCallback, useEffect, useRef, useState } from 'react';
import type { Message } from '../types';
import MessageItem from './MessageItem';

interface Props {
  messages: Message[];
  currentUserId: string;
  hasMoreBefore: boolean;
  onLoadOlder: () => Promise<void>;
  onReachedLatest: (seq: number) => void;
}

export default function MessageList({
  messages,
  currentUserId,
  hasMoreBefore,
  onLoadOlder,
  onReachedLatest,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const previousLengthRef = useRef(0);
  const previousLastMessageIdRef = useRef<string | null>(null);
  const atBottomRef = useRef(true);
  const loadingOlderRef = useRef(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const list = listRef.current;
    if (!list) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    list.scrollTo({ top: list.scrollHeight, behavior: reduceMotion ? 'auto' : behavior });
    atBottomRef.current = true;
    setPendingCount(0);
    const latestSeq = messages.at(-1)?.seq;
    if (latestSeq !== undefined) onReachedLatest(latestSeq);
  }, [messages, onReachedLatest]);

  const loadOlder = async () => {
    const list = listRef.current;
    if (!list || !hasMoreBefore || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const previousHeight = list.scrollHeight;
    try {
      await onLoadOlder();
      requestAnimationFrame(() => {
        if (listRef.current) {
          listRef.current.scrollTop += listRef.current.scrollHeight - previousHeight;
        }
      });
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  };

  const locateReply = (messageId: string) => {
    const target = listRef.current?.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(messageId)}"]`,
    );
    if (!target) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({
      behavior: reduceMotion ? 'auto' : 'smooth',
      block: 'center',
    });
    target.classList.remove('message-located');
    requestAnimationFrame(() => target.classList.add('message-located'));
    window.setTimeout(() => target.classList.remove('message-located'), 1200);
  };

  const messagesById = new Map(messages.map(message => [message.id, message]));

  useEffect(() => {
    const previousLength = previousLengthRef.current;
    const latestMessageId = messages.at(-1)?.id ?? null;
    const addedAtEnd = latestMessageId !== previousLastMessageIdRef.current;
    const added = Math.max(0, messages.length - previousLength);
    if (previousLength === 0 && messages.length > 0) {
      requestAnimationFrame(() => scrollToLatest('auto'));
    } else if (addedAtEnd && added > 0) {
      if (atBottomRef.current) {
        requestAnimationFrame(() => scrollToLatest('smooth'));
      } else {
        setPendingCount(count => count + added);
      }
    }
    previousLengthRef.current = messages.length;
    previousLastMessageIdRef.current = latestMessageId;
  }, [messages, scrollToLatest]);

  const handleScroll = () => {
    const list = listRef.current;
    if (!list) return;
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
    atBottomRef.current = atBottom;
    if (atBottom) {
      setPendingCount(0);
      const latestSeq = messages.at(-1)?.seq;
      if (latestSeq !== undefined) onReachedLatest(latestSeq);
    }
    if (list.scrollTop < 64) void loadOlder();
  };

  if (messages.length === 0) {
    return (
      <div className="message-list-empty">
        <p>暂无消息</p>
        <p className="hint">通过 MCP 发布的群聊消息会显示在这里</p>
      </div>
    );
  }

  return (
    <div className="message-list-shell">
      <div className="message-list" ref={listRef} onScroll={handleScroll}>
        {hasMoreBefore && (
          <button type="button" className="load-older-button" onClick={() => void loadOlder()} disabled={loadingOlder}>
            {loadingOlder ? '正在加载...' : '加载更早消息'}
          </button>
        )}
        {messages.map(message => (
          <MessageItem
            key={message.id}
            message={message}
            isOwn={message.sender.userId === currentUserId}
            replyTo={message.replyToMessageId
              ? messagesById.get(message.replyToMessageId)
              : undefined}
            onLocateReply={locateReply}
          />
        ))}
      </div>
      {pendingCount > 0 && (
        <button type="button" className="new-message-button" onClick={() => scrollToLatest()}>
          {pendingCount} 条新消息
        </button>
      )}
    </div>
  );
}
