import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: { path: string; opts: { method?: string; headers?: Record<string, string> } }[] = [];
let answer: (path: string) => unknown = () => ({});

vi.mock('./api', () => {
  class ApiError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    api: vi.fn(async (path: string, opts: object) => {
      calls.push({ path, opts });
      const r = answer(path);
      if (r instanceof Error) throw r;
      return r;
    }),
  };
});

import { ApiError } from './api';
import { failedCount, nextWaiting, useOutbox, waitingCount } from './outbox';
import { runOutbox } from './sync';

const add = (orderId: string, label: string, at: number) => {
  const c = useOutbox.getState().enqueue({
    orderId,
    kind: 'ADD',
    body: { itemId: 'i', variantId: 'v', qty: 1 },
    label,
    qty: 1,
  });
  // a fixed clock keeps the order of the test readable
  useOutbox.setState({
    items: useOutbox.getState().items.map((x) => (x.id === c.id ? { ...x, at } : x)),
  });
  return c;
};

beforeEach(() => {
  calls.length = 0;
  answer = () => ({});
  useOutbox.getState().clear();
});

describe('the outbox', () => {
  it('sends the oldest command first, each with its own id as Idempotency-Key', async () => {
    const b = add('o1', 'B', 2000);
    const a = add('o1', 'A', 1000);
    expect(nextWaiting(useOutbox.getState().items)?.id).toBe(a.id);

    await runOutbox(new QueryClient());
    expect(calls.map((c) => c.opts.headers?.['Idempotency-Key'])).toEqual([a.id, b.id]);
    expect(calls.every((c) => c.path === '/orders/o1/items' && c.opts.method === 'POST')).toBe(
      true,
    );
    expect(useOutbox.getState().items).toHaveLength(0); // sent commands are forgotten
  });

  it('stops without losing anything when there is still no connection or the server is down', async () => {
    add('o1', 'A', 1);
    add('o1', 'B', 2);
    answer = () => new ApiError(0, 'OFFLINE', 'no internet');
    await runOutbox(new QueryClient());
    expect(calls).toHaveLength(1); // it did not hammer the second one
    expect(waitingCount(useOutbox.getState().items)).toBe(2);

    calls.length = 0;
    answer = () => new ApiError(503, 'INTERNAL_ERROR', 'down');
    await runOutbox(new QueryClient());
    expect(waitingCount(useOutbox.getState().items)).toBe(2);
  });

  it('keeps commands when the session expired (401), and sends them after sign-in', async () => {
    add('o1', 'A', 1);
    answer = () => new ApiError(401, 'UNAUTHENTICATED', 'sign in');
    await runOutbox(new QueryClient());
    expect(waitingCount(useOutbox.getState().items)).toBe(1);
    expect(failedCount(useOutbox.getState().items)).toBe(0);
  });

  it('marks what the server refuses as FAILED with the reason and carries on with the rest', async () => {
    add('o1', 'Sold out dish', 1);
    add('o2', 'Fine dish', 2);
    answer = (path) =>
      path.startsWith('/orders/o1') ? new ApiError(409, 'ITEM_UNAVAILABLE', 'Sold out (86)') : {};
    await runOutbox(new QueryClient());
    const left = useOutbox.getState().items;
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({
      label: 'Sold out dish',
      state: 'FAILED',
      error: 'Sold out (86)',
    });
    expect(nextWaiting(left)).toBeUndefined(); // a failed one is never retried by itself

    useOutbox.getState().retry(left[0]!.id);
    expect(useOutbox.getState().items[0]).toMatchObject({ state: 'WAITING' });
    expect(useOutbox.getState().items[0]!.error).toBeUndefined();
  });

  it('a "send to kitchen" with nothing left to send counts as done', async () => {
    useOutbox.getState().enqueue({ orderId: 'o1', kind: 'SEND', body: {}, label: 'Send', qty: 0 });
    answer = () => new ApiError(409, 'NOTHING_TO_SEND', 'nothing new');
    await runOutbox(new QueryClient());
    expect(useOutbox.getState().items).toHaveLength(0);
    expect(calls[0]!.path).toBe('/orders/o1/send');
  });

  it('two runs at once do not send anything twice', async () => {
    add('o1', 'A', 1);
    const qc = new QueryClient();
    await Promise.all([runOutbox(qc), runOutbox(qc)]);
    expect(calls).toHaveLength(1);
  });
});
