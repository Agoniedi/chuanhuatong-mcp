import { describe, expect, it } from 'vitest';
import type { Message, Room } from '../types';
import { initialState, reducer } from './reducer';
import type { AppState } from './reducer';

const room: Room = {
  id: 'room-test',
  ownerUserId: 'user-owner',
  title: 'Test room',
  lastSeq: 4,
  revision: 1,
  historyVisibility: 'from_start',
  createdAt: '2026-08-09T00:00:00.000Z',
  updatedAt: '2026-08-09T00:00:00.000Z',
  webReadSeq: 3,
  unreadCount: 1,
};

function message(id: string, seq: number): Message {
  return {
    id,
    roomId: room.id,
    seq,
    clientMessageId: `client-${id}`,
    sender: {
      kind: 'human',
      userId: 'user-owner',
      displayNameSnapshot: 'Owner',
      avatarResourceIdSnapshot: null,
    },
    content: { schemaVersion: 1, type: 'text', text: id },
    mentions: [],
    replyToMessageId: null,
    createdAt: '2026-08-09T00:00:00.000Z',
  };
}

function state(changes: Partial<AppState> = {}): AppState {
  return {
    ...initialState,
    rooms: [room],
    ...changes,
  };
}

describe('app reducer', () => {
  it('merges message pages by ID and keeps sequence order', () => {
    const existing = message('message-2', 2);
    const result = reducer(
      state({ messages: { [room.id]: [existing] }, lastSeqs: { [room.id]: 2 } }),
      {
        type: 'MERGE_MESSAGES',
        roomId: room.id,
        messages: [message('message-3', 3), message('message-1', 1), existing],
      },
    );

    expect(result.messages[room.id].map(item => item.id)).toEqual([
      'message-1',
      'message-2',
      'message-3',
    ]);
    expect(result.lastSeqs[room.id]).toBe(3);
  });

  it('deduplicates realtime messages and derives unread count from Web read state', () => {
    const nextMessage = message('message-6', 6);
    const current = state();
    const appended = reducer(current, {
      type: 'APPEND_MESSAGE',
      roomId: room.id,
      message: nextMessage,
    });

    expect(appended.rooms[0]).toMatchObject({ lastSeq: 6, webReadSeq: 3, unreadCount: 3 });
    expect(appended.lastSeqs[room.id]).toBe(6);
    expect(reducer(appended, {
      type: 'APPEND_MESSAGE',
      roomId: room.id,
      message: nextMessage,
    })).toBe(appended);
  });

  it('advances Web read state monotonically', () => {
    const withLatest = state({ rooms: [{ ...room, lastSeq: 6 }] });
    const advanced = reducer(withLatest, {
      type: 'MARK_ROOM_READ',
      roomId: room.id,
      readSeq: 5,
    });
    const stale = reducer(advanced, {
      type: 'MARK_ROOM_READ',
      roomId: room.id,
      readSeq: 4,
    });

    expect(advanced.rooms[0]).toMatchObject({ webReadSeq: 5, unreadCount: 1 });
    expect(stale.rooms[0]).toMatchObject({ webReadSeq: 5, unreadCount: 1 });
  });
});
