import type { QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { ApiError, api } from './api';
import { useAuth } from './auth-store';
import { useOnline } from './online';
import { nextWaiting, useOutbox, waitingCount, type QueuedCommand } from './outbox';

function sendCommand(c: QueuedCommand): Promise<unknown> {
  if (c.kind === 'CREATE')
    return api('/orders', { method: 'POST', body: c.body, headers: { 'Idempotency-Key': c.id } });
  return c.kind === 'ADD'
    ? api(`/orders/${c.orderId}/items`, {
        method: 'POST',
        body: c.body,
        headers: { 'Idempotency-Key': c.id },
      })
    : api(`/orders/${c.orderId}/send`, { method: 'POST', body: c.body });
}

let running = false;

/**
 * Sends what was kept while the internet was down, oldest first, one at a time.
 *  - success → forgotten;  no connection / server trouble / signed out → stop, try again later;
 *  - the server REFUSES it (order closed, dish sold out, …) → marked FAILED with the reason, for a person to read.
 * A repeat is safe: ADD carries its id as Idempotency-Key, and a SEND with nothing left to send counts as done.
 */
export async function runOutbox(qc: QueryClient): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const next = nextWaiting(useOutbox.getState().items);
      if (!next) break;
      try {
        await sendCommand(next);
        useOutbox.getState().remove(next.id);
      } catch (e) {
        if (!(e instanceof ApiError)) break;
        if (e.code === 'OFFLINE' || e.status >= 500 || e.status === 401) break; // not the command's fault
        if (next.kind === 'SEND' && e.code === 'NOTHING_TO_SEND') {
          useOutbox.getState().remove(next.id);
        } else {
          useOutbox.getState().fail(next.id, e.message);
        }
      }
      await qc.invalidateQueries({ queryKey: ['order', next.orderId] });
      qc.removeQueries({ queryKey: ['floor'] });
    }
  } finally {
    running = false;
  }
}

/** Mounted once in the shell: sends the kept commands whenever the connection is back. */
export function useOutboxSync(qc: QueryClient): void {
  const online = useOnline();
  const signedIn = useAuth((s) => s.tokens !== null);
  const waiting = useOutbox((s) => waitingCount(s.items));
  useEffect(() => {
    if (!online || !signedIn || waiting === 0) return;
    void runOutbox(qc);
    const timer = setInterval(() => void runOutbox(qc), 10_000); // the server may still be waking up
    return () => clearInterval(timer);
  }, [online, signedIn, waiting, qc]);
}
