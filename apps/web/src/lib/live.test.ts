import { describe, expect, it } from 'vitest';
import { parseFrames, pollMs, useLive } from './live';

describe('parseFrames', () => {
  it('reads complete events and keeps a partial one for the next chunk', () => {
    const a = parseFrames('retry: 3000\n\nevent: ready\ndata: {}\n\nevent: change\ndata: {"top');
    expect(a.events).toEqual([{ event: 'ready', data: '{}' }]);
    expect(a.rest).toBe('event: change\ndata: {"top');
    const b = parseFrames(`${a.rest}ic":"orders"}\n\n: keep-alive\n\n`);
    expect(b.events).toEqual([{ event: 'change', data: '{"topic":"orders"}' }]);
    expect(b.rest).toBe('');
  });

  it('ignores comment heartbeats', () => {
    expect(parseFrames(': keep-alive\n\n').events).toEqual([]);
  });
});

describe('pollMs', () => {
  it('polls fast until the stream is connected, then slowly', () => {
    useLive.setState({ connected: false });
    expect(pollMs(3000)).toBe(3000);
    useLive.setState({ connected: true });
    expect(pollMs(3000)).toBe(30_000);
    useLive.setState({ connected: false });
  });
});
