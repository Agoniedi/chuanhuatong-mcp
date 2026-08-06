import { useState } from 'react';
import { sendMessage } from '../api/messages';

interface Props {
  roomId: string;
}

export default function SendBar({ roomId }: Props) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const content = text.trim();
    if (!content) return;
    setSending(true);
    try {
      await sendMessage(roomId, content);
      setText('');
    } catch (err) {
      console.error('发送失败', err);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend(e);
    }
  };

  return (
    <form className="send-bar" onSubmit={handleSend}>
      <input
        type="text"
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="输入消息... (Enter 发送)"
        maxLength={32768}
        disabled={sending}
        autoFocus
      />
      <button type="submit" className="btn-primary" disabled={sending || !text.trim()}>
        {sending ? '发送中...' : '发送'}
      </button>
    </form>
  );
}