import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../types';
import MessageList from './MessageList';

function message(
  id: string,
  seq: number,
  sender: Message['sender'],
  changes: Partial<Message> = {},
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
    ...changes,
  };
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 0));
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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
        onRecall={vi.fn()}
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

  it('allows recalling recent messages from the current user and their agent only', async () => {
    vi.useFakeTimers();
    const currentUserId = 'user-owner';
    const onRecall = vi.fn(async () => {});
    const recent = new Date().toISOString();
    render(
      <MessageList
        messages={[
          message('own-human', 1, {
            kind: 'human',
            userId: currentUserId,
            displayNameSnapshot: 'Owner',
            avatarResourceIdSnapshot: null,
          }, { createdAt: recent }),
          message('own-agent', 2, {
            kind: 'agent',
            userId: currentUserId,
            agentProfileId: 'agent-owner',
            displayNameSnapshot: 'Owner Agent',
            avatarResourceIdSnapshot: null,
          }, { createdAt: recent }),
          message('other-human', 3, {
            kind: 'human',
            userId: 'user-other',
            displayNameSnapshot: 'Other',
            avatarResourceIdSnapshot: null,
          }, { createdAt: recent }),
          message('recalled-human', 4, {
            kind: 'human',
            userId: currentUserId,
            displayNameSnapshot: 'Owner',
            avatarResourceIdSnapshot: null,
          }, {
            content: { schemaVersion: 1, type: 'text', text: '' },
            recalledAt: recent,
            createdAt: recent,
          }),
        ]}
        currentUserId={currentUserId}
        hasMoreBefore={false}
        onLoadOlder={async () => {}}
        onReachedLatest={vi.fn()}
        onRecall={onRecall}
      />,
    );

    expect(screen.queryByRole('menuitem', { name: '撤回' })).toBeNull();
    expect(screen.getByText('消息已撤回')).not.toBeNull();

    const agentBubble = screen.getByText('own-agent').closest('.msg-bubble')!;
    fireEvent.pointerDown(agentBubble, { button: 0, clientX: 20, clientY: 20 });
    act(() => vi.advanceTimersByTime(499));
    expect(screen.queryByRole('menuitem', { name: '撤回' })).toBeNull();
    act(() => vi.advanceTimersByTime(1));

    const recallAction = screen.getByRole('menuitem', { name: '撤回' });
    expect(recallAction).not.toBeNull();
    await act(async () => fireEvent.click(recallAction));
    expect(onRecall).toHaveBeenCalledWith(expect.objectContaining({ id: 'own-agent' }));
  });
});
