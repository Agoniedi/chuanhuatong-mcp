import { useEffect, useRef } from 'react';
import MessageItem from './MessageItem';
import type { Message } from '../types';

interface Props {
  messages: Message[];
  currentUserId: string;
}

export default function MessageList({ messages, currentUserId }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  if (messages.length === 0) {
    return (
      <div className="message-list-empty">
        <p>暂无消息</p>
        <p className="hint">发送第一条消息开始聊天</p>
      </div>
    );
  }

  return (
    <div className="message-list">
      {messages.map(msg => (
        <MessageItem
          key={msg.id}
          message={msg}
          isOwn={msg.sender.userId === currentUserId}
        />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}