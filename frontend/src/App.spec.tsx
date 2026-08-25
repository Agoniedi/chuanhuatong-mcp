import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppearancePage, Chat, Rooms } from './App';
import { listAgentBindings } from './api/agent-bindings';
import { listMembers } from './api/members';
import { readChatBackgroundUrl, saveChatBackground, selectChatBackgroundPreset } from './appearance';

vi.mock('./appearance', () => ({
  applyBubbleColor: vi.fn(),
  applyBubbleOpacity: vi.fn(),
  readBubbleColor: vi.fn(() => '#8a6b4f'),
  readBubbleOpacity: vi.fn(() => 100),
  readChatBackgroundUrl: vi.fn(),
  saveChatBackground: vi.fn(),
  selectChatBackgroundPreset: vi.fn(),
}));

vi.mock('./api/agent-bindings', () => ({ listAgentBindings: vi.fn() }));
vi.mock('./api/members', () => ({ listMembers: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
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

  it('clears the stored custom background before selecting the default', async () => {
    const setChatBg = vi.fn();
    vi.mocked(selectChatBackgroundPreset).mockResolvedValue(null);
    render(
      <AppearancePage
        onBack={vi.fn()}
        color="#8a6b4f"
        setColor={vi.fn()}
        opacity={100}
        setOpacity={vi.fn()}
        chatBg="blob:stored-background"
        setChatBg={setChatBg}
        dark={false}
        setDark={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('默认'));

    await waitFor(() => expect(selectChatBackgroundPreset).toHaveBeenCalledWith(null));
    await waitFor(() => expect(setChatBg).toHaveBeenCalledWith(null));
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
        room={{ id: 'room-1', name: '归属测试', desc: '', lastMsg: '', lastTime: '', unread: 0, members: 4, ownerUserId: 'human-owner', ownerLabel: '丰一', code: '', initials: '归', color: '#8a6b4f' }}
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
        currentUserId="human-owner"
        canDelete={false}
        canManageMembers={false}
        onDelete={vi.fn()}
        onRemoveMember={vi.fn()}
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

  it('lets the owner confirm removing another human member', async () => {
    vi.mocked(listMembers).mockResolvedValue({
      items: [
        { userId: 'human-owner', role: 'owner', joinedSeq: 1, displayName: '丰一', avatarResourceId: null },
        { userId: 'human-hz', role: 'member', joinedSeq: 2, displayName: 'HZ', avatarResourceId: null },
      ],
      roomRevision: 1,
    });
    vi.mocked(listAgentBindings).mockResolvedValue([]);
    const onRemoveMember = vi.fn().mockResolvedValue(undefined);

    render(
      <Chat
        room={{ id: 'room-1', name: '移出测试', desc: '', lastMsg: '', lastTime: '', unread: 0, members: 2, ownerUserId: 'human-owner', ownerLabel: '丰一', code: '', initials: '移', color: '#8a6b4f' }}
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
        currentUserId="human-owner"
        canDelete
        canManageMembers
        onDelete={vi.fn()}
        onRemoveMember={onRemoveMember}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '查看成员' }));
    fireEvent.click(await screen.findByRole('button', { name: '将 HZ 移出房间' }));
    expect(screen.getByRole('alertdialog').textContent).toContain('将“HZ”移出房间？');
    expect(screen.getByRole('button', { name: '取消' })).toBe(document.activeElement);
    fireEvent.click(screen.getByRole('button', { name: '确认移出' }));
    await waitFor(() => expect(onRemoveMember).toHaveBeenCalledWith('human-hz'));
    await waitFor(() => expect(screen.queryByText('HZ')).toBeNull());
  });

  it('reloads an open member panel when membership changes in realtime', async () => {
    vi.mocked(listMembers).mockResolvedValue({
      items: [
        { userId: 'human-owner', role: 'owner', joinedSeq: 1, displayName: '丰一', avatarResourceId: null },
        { userId: 'human-hz', role: 'member', joinedSeq: 2, displayName: 'HZ', avatarResourceId: null },
      ],
      roomRevision: 1,
    });
    vi.mocked(listAgentBindings).mockResolvedValue([]);
    const chat = (membersRefreshVersion: number) => (
      <Chat
        room={{ id: 'room-1', name: '实时刷新', desc: '', lastMsg: '', lastTime: '', unread: 0, members: 2, ownerUserId: 'human-owner', ownerLabel: '丰一', code: '', initials: '实', color: '#8a6b4f' }}
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
        currentUserId="human-owner"
        canDelete
        canManageMembers
        membersRefreshVersion={membersRefreshVersion}
        onDelete={vi.fn()}
        onRemoveMember={vi.fn()}
      />
    );
    const { rerender } = render(chat(0));
    fireEvent.click(screen.getByRole('button', { name: '查看成员' }));
    await screen.findByRole('listitem', { name: 'HZ' });

    vi.mocked(listMembers).mockResolvedValue({
      items: [
        { userId: 'human-owner', role: 'owner', joinedSeq: 1, displayName: '丰一', avatarResourceId: null },
      ],
      roomRevision: 2,
    });
    rerender(chat(1));

    await waitFor(() => expect(listMembers).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'HZ' })).toBeNull());
  });
});

describe('Rooms long-press actions', () => {
  const rooms = [
    { id: 'room-a', name: '普通房间', desc: '', lastMsg: '', lastTime: '', unread: 0, members: 2, ownerUserId: 'other-user', ownerLabel: '其他用户', code: '', initials: '普', color: '#8a6b4f' },
    { id: 'room-b', name: '置顶房间', desc: '', lastMsg: '', lastTime: '', unread: 0, members: 3, ownerUserId: 'other-user', ownerLabel: '其他用户', code: '', initials: '置', color: '#8e7cc3' },
  ];

  it('announces unread context and opens a room with Space', () => {
    const onRoom = vi.fn();
    const unreadRoom = { ...rooms[0], unread: 3, lastMsg: '新的讨论内容' };
    render(
      <Rooms
        rooms={[unreadRoom]}
        currentUserId="current-user"
        pinnedRoomIds={new Set()}
        onRoom={onRoom}
        onShareSheet={vi.fn()}
        onTogglePin={vi.fn()}
        onExit={vi.fn()}
      />,
    );

    const row = screen.getByRole('button', {
      name: '普通房间，3 条未读，最后消息：新的讨论内容',
    });
    fireEvent.keyDown(row, { key: ' ' });
    expect(onRoom).toHaveBeenCalledWith(unreadRoom);
  });

  it('shows pin and exit actions after a long press', async () => {
    vi.useFakeTimers();
    const onTogglePin = vi.fn();
    const onExit = vi.fn().mockResolvedValue(undefined);
    render(
      <Rooms
        rooms={rooms}
        currentUserId="current-user"
        pinnedRoomIds={new Set(['room-b'])}
        onRoom={vi.fn()}
        onShareSheet={vi.fn()}
        onTogglePin={onTogglePin}
        onExit={onExit}
      />,
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: /^置顶房间/ }));
    act(() => vi.advanceTimersByTime(500));
    fireEvent.click(screen.getByRole('button', { name: '取消置顶' }));
    expect(onTogglePin).toHaveBeenCalledWith('room-b');

    fireEvent.pointerDown(screen.getByRole('button', { name: /^普通房间/ }));
    act(() => vi.advanceTimersByTime(500));
    fireEvent.click(screen.getByRole('button', { name: '退出' }));
    expect(screen.getByRole('alertdialog').textContent).toContain('退出后，此房间会从房间列表中删除');
    fireEvent.click(screen.getByRole('button', { name: '退出房间' }));
    await vi.runAllTimersAsync();
    expect(onExit).toHaveBeenCalledWith(rooms[0]);
  });

  it('cancels a long press after the pointer moves beyond the drag threshold', () => {
    vi.useFakeTimers();
    const onRoom = vi.fn();
    render(
      <Rooms
        rooms={rooms}
        currentUserId="current-user"
        pinnedRoomIds={new Set()}
        onRoom={onRoom}
        onShareSheet={vi.fn()}
        onTogglePin={vi.fn()}
        onExit={vi.fn()}
      />,
    );

    const room = screen.getByRole('button', { name: /^普通房间/ });
    fireEvent.pointerDown(room, { clientX: 20, clientY: 20 });
    fireEvent.pointerMove(room, { clientX: 35, clientY: 20 });
    act(() => vi.advanceTimersByTime(500));
    fireEvent.click(room);

    expect(screen.queryByRole('button', { name: '置顶' })).toBeNull();
    expect(screen.queryByRole('button', { name: '退出' })).toBeNull();
    expect(onRoom).not.toHaveBeenCalled();
  });

  it('shows a Chinese message instead of a backend error detail', async () => {
    vi.useFakeTimers();
    const onExit = vi.fn().mockRejectedValue(new Error('Room membership required'));
    render(
      <Rooms
        rooms={rooms}
        currentUserId="current-user"
        pinnedRoomIds={new Set()}
        onRoom={vi.fn()}
        onShareSheet={vi.fn()}
        onTogglePin={vi.fn()}
        onExit={onExit}
      />,
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: /^普通房间/ }));
    act(() => vi.advanceTimersByTime(500));
    fireEvent.click(screen.getByRole('button', { name: '退出' }));
    fireEvent.click(screen.getByRole('button', { name: '退出房间' }));

    await act(async () => Promise.resolve());
    expect(screen.getByRole('alert').textContent).toBe('操作失败，请重试');
    expect(screen.queryByText('Room membership required')).toBeNull();
  });

  it('shows a destructive room action as dissolve for the owner and closes with Escape', () => {
    vi.useFakeTimers();
    const ownedRoom = { ...rooms[0], id: 'room-owned', name: '我的房间', ownerUserId: 'current-user', ownerLabel: '我' };
    render(
      <Rooms
        rooms={[ownedRoom]}
        currentUserId="current-user"
        pinnedRoomIds={new Set()}
        onRoom={vi.fn()}
        onShareSheet={vi.fn()}
        onTogglePin={vi.fn()}
        onExit={vi.fn()}
      />,
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: /^我的房间/ }));
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole('button', { name: '解散房间' })).toBeTruthy();

    fireEvent.keyDown(screen.getByRole('dialog', { name: '我的房间 房间操作' }), { key: 'Escape' });
    expect(screen.queryByRole('button', { name: '解散房间' })).toBeNull();
  });
});
