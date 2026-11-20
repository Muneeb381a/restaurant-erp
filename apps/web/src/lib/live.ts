import type { QueryClient } from '@tanstack/react-query';
import { isDown } from './net';
import { create } from 'zustand';
import { api } from './api';
import { useAuth } from './auth-store';
import { apiBase } from './tenant';

/** True while the live stream is connected: screens then poll slowly (a safety net) instead of every 3 s. */
export const useLive = create<{ connected: boolean; polling: boolean }>(() => ({
  connected: false,
  polling: false,
}));

export const pollMs = (fast: number, slow = 30_000): number => {
  const s = useLive.getState();
  if (s.connected) return slow;
  if (isDown()) return Math.max(fast, 10_000); // no server to ask: do not hammer it
  // no live stream on this server (serverless): refresh at a calmer pace than the offline retry
  return s.polling ? Math.max(fast, POLLING_MIN_MS) : fast;
};

/** Fastest refresh when the server has no live stream: every screen asks the server this often. */
const POLLING_MIN_MS = 8_000;

/** Which cached queries a change in each topic makes stale. */
const KEYS: Record<string, string[]> = {
  orders: ['floor', 'order', 'bill', 'bills', 'refundable', 'shift', 'khata', 'kitchen'],
  day: ['day', 'shift', 'floor', 'bills'],
  khata: ['khata'],
  menu: ['menu'],
  printers: ['printers-health', 'floor', 'kitchen'],
  misc: ['settings', 'branch', 'payment-methods', 'me'],
};

/** Pulls the `event:` / `data:` pairs out of a text/event-stream buffer; returns what is left over. */
export function parseFrames(buffer: string): {
  events: { event: string; data: string }[];
  rest: string;
} {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  const events = parts
    .map((frame) => {
      let event = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      return { event, data };
    })
    .filter((e) => e.data !== '' || e.event !== 'message');
  return { events, rest };
}

/**
 * Keeps one Server-Sent Events connection to `/api/v1/events` while signed in. The stream carries
 * only "something changed in <topic>"; this refetches through the normal API. Reconnects with backoff.
 * Returns a function that stops it.
 */
export function startLive(qc: QueryClient): () => void {
  let stopped = false;
  let abort: AbortController | null = null;
  let pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let connectedBefore = false;

  const flush = (): void => {
    timer = null;
    for (const key of pending) void qc.invalidateQueries({ queryKey: [key] });
    pending = new Set();
  };
  const schedule = (topic: string): void => {
    for (const k of KEYS[topic] ?? KEYS.misc!) pending.add(k);
    if (!timer) timer = setTimeout(flush, 150); // several quick writes become one refresh
  };

  async function connectOnce(): Promise<void> {
    // refreshes an expired access token the usual way; shares the cached answer with the screen's own
    // useMe, so the page start does not ask twice
    await qc.fetchQuery({ queryKey: ['me'], queryFn: () => api('/auth/me'), staleTime: 60_000 });
    const tokens = useAuth.getState().tokens;
    if (!tokens || stopped) return;
    abort = new AbortController();
    const res = await fetch(`${apiBase()}/events`, {
      headers: { authorization: `Bearer ${tokens.accessToken}`, accept: 'text/event-stream' },
      signal: abort.signal,
    });
    if (res.status === 501) {
      // the server runs without a live stream: screens poll, and there is nothing to retry
      useLive.setState({ polling: true, connected: false });
      stopped = true;
      return;
    }
    if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseFrames(buffer);
      buffer = rest;
      for (const e of events) {
        if (e.event === 'ready') {
          useLive.setState({ connected: true });
          // only a RE-connection can have missed changes; on the first one the screens have just loaded
          if (connectedBefore) void qc.invalidateQueries();
          connectedBefore = true;
        } else if (e.event === 'change') {
          try {
            schedule((JSON.parse(e.data) as { topic?: string }).topic ?? 'misc');
          } catch {
            schedule('misc');
          }
        }
      }
    }
  }

  void (async () => {
    let delay = 1000;
    while (!stopped) {
      try {
        await connectOnce();
        delay = 1000;
      } catch {
        /* offline or token problem: retry below */
      }
      useLive.setState({ connected: false });
      if (stopped) break;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 15_000);
    }
  })();

  return () => {
    stopped = true;
    abort?.abort();
    if (timer) clearTimeout(timer);
    useLive.setState({ connected: false });
  };
}
