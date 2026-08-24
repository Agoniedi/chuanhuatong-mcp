import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppearancePage, Chat } from './App';
import { listAgentBindings } from './api/agent-bindings';
import { listMembers } from './api/members';
import { readChatBackgroundUrl, saveChatBackground } from './appearance';

vi.mock('./appearance', () => ({
  applyBubbleColor: vi.fn(),
  applyBubbleOpacity: vi.fn(),
  readBubbleColor: vi.fn(() => '#8a6b4f'),
  readBubbleOpacity: vi.fn(() => 100),
  readChatBackgroundUrl: vi.fn(),
  saveChatBackground: vi.fn(),
}));

vi.mock('./api/agent-bindings', () => ({ listAgentBindings: vi.fn() }));
vi.mock('./api/members', () => ({ listMembers: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AppearancePage', () => {
  it('persists an uploaded custom chat background before displaying it', async () => {
    const file = new File(['background'], 'background.png', { type: 'image/png' });
    const setChatBg = vi.fn();
    vi.mocked(readChatBackgroundUrl).mockResolvedValue('blob:persisted-background');

    const { container } = render(
      <AppearancePage
        onBack={vi.fn()}
        color="#8a6b4f"
        setColor={vi.fn()}
        opacity={100}
        setOpacity={vi.fn()}
        chatBg={null}
        setChatBg={setChatBg}
        dark={false}
        setDark={vi.fn()}
      />,
    );

    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    fireEvent.change(input!, { target: { files: [file] } });

    await waitFor(() => expect(saveChatBackground).toHaveBeenCalledWith(file));
    await waitFor(() => expect(setChatBg).toHaveBeenCalledWith('blob:persisted-background'));
    expect(screen.getByText('自定义')).toBeTruthy();
  });
});

describe('Chat member panel', () => {
  it('groups each AI under its owning human member', async () => {
    vi.mocked(listMembers).mockResolvedValue({
      items: [
        { userId: 'human-owner', role: 'owner', joinedSeq: 1, displayName: '丰一', avatarResourceId: null },
        { userId: 'human-hz', role: 'member', joinedSeq: 2, displayName: 'HZ', avatarResourceId: null },
      ],
      roomRevision: 1,
    });
    vi.mocked(listAgentBindings).mockResolvedValue([
      {
        bindingId: 'binding-xiaoxiaotang', roomId: 'room-1', ownerUserId: 'human-owner',
        agentProfileId: 'agent-xiaoxiaotang', agentProfileRevision: 1, displayName: '夏小棠',
        avatarResourceId: null, participationMode: 'automatic', publishMode: 'automatic',
        triggerScope: 'allMessages', policyRevision: 1, updatedAt: '2026-08-24T00:00:00.000Z',
      },
      {
        bindingId: 'binding-claude', roomId: 'room-1', ownerUserId: 'human-hz',
        agentProfileId: 'agent-claude', agentProfileRevision: 1, displayName: 'Claude Code',
        avatarResourceId: null, participationMode: 'manual', publishMode: 'reviewRequired',
        triggerScope: 'mentionsOnly', policyRevision: 1, updatedAt: '2026-08-24T00:00:00.000Z',
      },
    ]);

    render(
      <Chat
        room={{ id: 'room-1', name: '归属测试', desc: '', lastMsg: '', lastTime: '', unread: 0, members: 4, owner: 'human-owner', code: '', initials: '归', color: '#8a6b4f' }}
        onBack={vi.fn()}
        bubColor="#8a6b4f"
        bubOpacity={100}
        chatBg={null}
        msgs={[]}
        onSend={vi.fn()}
        onRecall={vi.fn()}
        hasMoreBefore={false}
        onLoadOlder={vi.fn()}
        onReachedLatest={vi.fn()}
        wsStatus="open"
        canDelete={false}
        onDelete={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '查看成员' }));

    const ownerAgents = await screen.findByRole('list', { name: '丰一 的 AI' });
    const hzAgents = screen.getByRole('list', { name: 'HZ 的 AI' });
    expect(within(ownerAgents).getByText('夏小棠')).toBeTruthy();
    expect(within(ownerAgents).queryByText('Claude Code')).toBeNull();
    expect(within(hzAgents).getByText('Claude Code')).toBeTruthy();
    expect(screen.getByText('成员 (4)')).toBeTruthy();
  });
});
