import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { storageKey } from './tenant';

/**
 * Orders taken while the internet is down (ADR 0026). ONLY two kinds of command are ever kept on the
 * device: "add this dish to an order that is already open" and "send this order to the kitchen".
 * Payments, bills, discounts, voids, refunds and every other money action always need the server.
 *
 * Each command has a random id that is also its Idempotency-Key, so a retry after a lost answer
 * cannot add a dish twice (the server stores the first answer with the key).
 */
export interface QueuedCommand {
  id: string;
  orderId: string;
  kind: 'CREATE' | 'ADD' | 'SEND';
  /** The request body (CREATE: the new order incl. its id; ADD: the dish, variant, quantity, extras, note). */
  body: Record<string, unknown>;
  /** What the cashier sees: the dish name, or "Send to kitchen". */
  label: string;
  qty: number;
  at: number;
  state: 'WAITING' | 'FAILED';
  /** Why the server refused it (FAILED only). */
  error?: string;
}

interface OutboxState {
  items: QueuedCommand[];
  enqueue: (c: Omit<QueuedCommand, 'id' | 'at' | 'state'>) => QueuedCommand;
  remove: (id: string) => void;
  fail: (id: string, error: string) => void;
  retry: (id: string) => void;
  clear: () => void;
}

/** A random id of 8-80 characters that the server accepts as an Idempotency-Key. */
export const newCommandId = (): string => `q-${crypto.randomUUID()}`;

export const useOutbox = create<OutboxState>()(
  persist(
    (set, get) => ({
      items: [],
      enqueue: (c) => {
        const cmd: QueuedCommand = { ...c, id: newCommandId(), at: Date.now(), state: 'WAITING' };
        set({ items: [...get().items, cmd] });
        return cmd;
      },
      remove: (id) => set({ items: get().items.filter((c) => c.id !== id) }),
      fail: (id, error) =>
        set({
          items: get().items.map((c) => (c.id === id ? { ...c, state: 'FAILED', error } : c)),
        }),
      retry: (id) =>
        set({
          items: get().items.map((c) => {
            if (c.id !== id) return c;
            const rest: QueuedCommand = { ...c, state: 'WAITING' };
            delete rest.error;
            return rest;
          }),
        }),
      clear: () => set({ items: [] }),
    }),
    { name: storageKey('erp-outbox') },
  ),
);

/** The next command to send: the oldest one that is waiting (they must go in the order they were made). */
export function nextWaiting(items: readonly QueuedCommand[]): QueuedCommand | undefined {
  return items
    .filter((c) => c.state === 'WAITING')
    .reduce<QueuedCommand | undefined>((a, c) => (!a || c.at < a.at ? c : a), undefined);
}

export const waitingCount = (items: readonly QueuedCommand[]): number =>
  items.filter((c) => c.state === 'WAITING').length;
export const failedCount = (items: readonly QueuedCommand[]): number =>
  items.filter((c) => c.state === 'FAILED').length;
