import type { QueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
import { api } from './api';
import { useAuth } from './auth-store';

/** True while the live stream is connected: screens then poll slowly (a safety net) instead of every 3 s. */
export const useLive = create<{ connected: boolean }>(() => ({ connected: false }));

export const pollMs = (fast: number, slow = 30_000): number =>
  useLive.getState().connected ? slow : fast;

/** Which cached queries a change in each topic makes stale. */
const KEYS: Record<string, string[]> = {
  orders: ['floor', 'order', 'bill', 'bills', 'refundable', 'shift', 'khata'],
  day: ['day', 'shift', 'floor', 'bills'],
  khata: ['khata'],
  menu: ['menu'],
  printers: ['printers-health', 'floor'],
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
    await api('/auth/me'); // refreshes an expired access token the usual way
    const tokens = useAuth.getState().tokens;
    if (!tokens || stopped) return;
    abort = new AbortController();
    const res = await fetch('/api/v1/events', {
      headers: { authorization: `Bearer ${tokens.accessToken}`, accept: 'text/event-stream' },
      signal: abort.signal,
    });
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
          void qc.invalidateQueries(); // anything missed while disconnected
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
