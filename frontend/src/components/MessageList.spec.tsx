import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../types';
import MessageList from './MessageList';

function message(
  id: string,
  seq: number,
  sender: Message['sender'],
): Message {
  return {
    id,
    roomId: 'room-test',
    seq,
    clientMessageId: `client-${id}`,
    sender,
    content: { schemaVersion: 1, type: 'text', text: id },
    mentions: [],
    replyToMessageId: null,
    createdAt: `2026-08-11T00:0${seq}:00.000Z`,
  };
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 0));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MessageList', () => {
  it('keeps an agent owned by the current user visibly separate from human messages', () => {
    const currentUserId = 'user-owner';
    const { container } = render(
      <MessageList
        messages={[
          message('human-message', 1, {
            kind: 'human',
            userId: currentUserId,
            displayNameSnapshot: 'Owner',
            avatarResourceIdSnapshot: null,
          }),
          message('agent-message', 2, {
            kind: 'agent',
            userId: currentUserId,
            agentProfileId: 'agent-owner',
            displayNameSnapshot: 'Owner Agent',
            avatarResourceIdSnapshot: null,
          }),
        ]}
        currentUserId={currentUserId}
        hasMoreBefore={false}
        onLoadOlder={async () => {}}
        onReachedLatest={vi.fn()}
      />,
    );

    const humanRow = screen.getByText('human-message').closest('article');
    const agentRow = screen.getByText('agent-message').closest('article');

    expect(humanRow?.classList.contains('own')).toBe(true);
    expect(humanRow?.querySelector('.avatar-human')).not.toBeNull();
    expect(agentRow?.classList.contains('other')).toBe(true);
    expect(within(agentRow!).getByText('Owner Agent')).not.toBeNull();
    expect(within(agentRow!).getAllByText('AI')).not.toHaveLength(0);
    expect(container.querySelectorAll('.time-divider')).toHaveLength(1);
    expect(container.querySelector('.time-divider')?.textContent).toBe(
      new Date('2026-08-11T00:01:00.000Z').toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
      }),
    );
  });
});
