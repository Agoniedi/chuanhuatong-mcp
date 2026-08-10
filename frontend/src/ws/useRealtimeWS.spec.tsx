import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WsEvent } from '../types';
import { useRealtimeWS } from './useRealtimeWS';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.onopen?.();
  }

  message(data: string) {
    this.onmessage?.({ data });
  }

  closed() {
    this.onclose?.();
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useRealtimeWS', () => {
  it('connects with same-origin cookies, parses events, and reconnects', async () => {
    const onEvent = vi.fn<(event: WsEvent) => void>();
    const onStatusChange = vi.fn();
    const { unmount } = renderHook(() => useRealtimeWS(onEvent, onStatusChange));
    const first = FakeWebSocket.instances[0];

    expect(first.url).toBe(`ws://${location.host}/v1/realtime`);
    expect(onStatusChange).toHaveBeenLastCalledWith('connecting');

    act(() => first.open());
    expect(onStatusChange).toHaveBeenLastCalledWith('open');

    const event: WsEvent = {
      protocolVersion: 1,
      eventId: 'event-1',
      type: 'message.created',
      occurredAt: '2026-08-09T00:00:00.000Z',
      payload: {},
    };
    act(() => first.message(JSON.stringify(event)));
    act(() => first.message('{invalid json'));
    expect(onEvent).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith(event);

    act(() => first.closed());
    expect(onStatusChange).toHaveBeenLastCalledWith('reconnecting');
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(onStatusChange).toHaveBeenLastCalledWith('connecting');

    const second = FakeWebSocket.instances[1];
    unmount();
    expect(second.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('uses the latest event callback without reconnecting', () => {
    const firstHandler = vi.fn();
    const secondHandler = vi.fn();
    const onStatusChange = vi.fn();
    const { rerender } = renderHook(
      ({ onEvent }) => useRealtimeWS(onEvent, onStatusChange),
      { initialProps: { onEvent: firstHandler } },
    );

    rerender({ onEvent: secondHandler });
    act(() => FakeWebSocket.instances[0].message(JSON.stringify({
      protocolVersion: 1,
      eventId: 'event-2',
      type: 'profile.updated',
      occurredAt: '2026-08-09T00:00:00.000Z',
    })));

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(firstHandler).not.toHaveBeenCalled();
    expect(secondHandler).toHaveBeenCalledOnce();
  });
});
