import { useCallback, useEffect, useRef, useState } from 'react';
import type { Message } from '../types';
import MessageItem from './MessageItem';

interface Props {
  messages: Message[];
  currentUserId: string;
  hasMoreBefore: boolean;
  onLoadOlder: () => Promise<void>;
  onReachedLatest: (seq: number) => void;
  onRecall: (message: Message) => Promise<void>;
}

// 同组：同一发言人、且与上一条相隔 < 5 分钟
const GROUP_GAP_MS = 5 * 60 * 1000;
// 跨过此间隔时插入居中时间分隔
const TIME_DIVIDER_MS = 5 * 60 * 1000;

function senderKey(message: Message): string {
  return `${message.sender.kind}:${message.sender.userId}:${message.sender.agentProfileId ?? ''}`;
}

function dayLabel(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(date)) / 86_400_000);
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString('zh-CN', {
    year: sameYear ? undefined : 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

type Row =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'time'; key: string; label: string }
  | {
      kind: 'message';
      message: Message;
      isOwn: boolean;
      isGroupStart: boolean;
      isGroupEnd: boolean;
    };

function buildRows(messages: Message[], currentUserId: string): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    const prev = messages[i - 1];
    const next = messages[i + 1];
    const time = new Date(message.createdAt).getTime();

    const newDay = !prev || dayLabel(prev.createdAt) !== dayLabel(message.createdAt);
    if (newDay) {
      rows.push({ kind: 'day', key: `day-${message.id}`, label: dayLabel(message.createdAt) });
    }
    if (newDay || (prev && time - new Date(prev.createdAt).getTime() >= TIME_DIVIDER_MS)) {
      rows.push({ kind: 'time', key: `time-${message.id}`, label: timeLabel(message.createdAt) });
    }

    const brokeAbove =
      newDay ||
      !prev ||
      senderKey(prev) !== senderKey(message) ||
      time - new Date(prev.createdAt).getTime() >= GROUP_GAP_MS;

    const newDayBelow = next && dayLabel(next.createdAt) !== dayLabel(message.createdAt);
    const breaksBelow =
      !next ||
      newDayBelow ||
      senderKey(next) !== senderKey(message) ||
      new Date(next.createdAt).getTime() - time >= GROUP_GAP_MS;

    rows.push({
      kind: 'message',
      message,
      isOwn: message.sender.kind === 'human' && message.sender.userId === currentUserId,
      isGroupStart: brokeAbove,
      isGroupEnd: Boolean(breaksBelow),
    });
  }
  return rows;
}

export default function MessageList({
  messages,
  currentUserId,
  hasMoreBefore,
  onLoadOlder,
  onReachedLatest,
  onRecall,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const previousLengthRef = useRef(0);
  const previousLastMessageIdRef = useRef<string | null>(null);
  const atBottomRef = useRef(true);
  const loadingOlderRef = useRef(false);
  const justArrivedIdRef = useRef<string | null>(null);
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
      justArrivedIdRef.current = latestMessageId;
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

  const rows = buildRows(messages, currentUserId);

  return (
    <div className="message-list-shell">
      <div className="message-list" ref={listRef} onScroll={handleScroll}>
        {hasMoreBefore && (
          <button type="button" className="load-older-button" onClick={() => void loadOlder()} disabled={loadingOlder}>
            {loadingOlder ? '正在加载...' : '加载更早消息'}
          </button>
        )}
        {rows.map(row => {
          if (row.kind === 'day') {
            return <div className="day-divider" key={row.key}>{row.label}</div>;
          }
          if (row.kind === 'time') {
            return <div className="time-divider" key={row.key}>{row.label}</div>;
          }
          const { message } = row;
          return (
            <MessageItem
              key={message.id}
              message={message}
              isOwn={row.isOwn}
              isGroupStart={row.isGroupStart}
              isGroupEnd={row.isGroupEnd}
              justArrived={justArrivedIdRef.current === message.id}
              currentUserId={currentUserId}
              replyTo={message.replyToMessageId
                ? messagesById.get(message.replyToMessageId)
                : undefined}
              onLocateReply={locateReply}
              onRecall={onRecall}
            />
          );
        })}
      </div>
      {pendingCount > 0 && (
        <button type="button" className="new-message-button" onClick={() => scrollToLatest()}>
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 3.5v9M4 8.5l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {pendingCount} 条新消息
        </button>
      )}
    </div>
  );
}
