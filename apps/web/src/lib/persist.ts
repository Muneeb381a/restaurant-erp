import type { QueryClient } from '@tanstack/react-query';
import { storageKey } from './tenant';

/**
 * Keeps the few screens a till needs on the device, so that after a reload with no internet it can
 * still show who is signed in, the menu, the floor and the orders it has already opened. Only these
 * keys are stored, only on this device, and everything is wiped on sign-out (ADR 0026).
 */
const KEYS = new Set(['me', 'menu', 'order', 'floor', 'day', 'shift']);
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const MAX_ORDERS = 30;
const NAME = (): string => storageKey('erp-cache');

interface Entry {
  key: unknown[];
  data: unknown;
  at: number;
}

function read(): Entry[] {
  try {
    const raw = localStorage.getItem(NAME());
    return raw ? (JSON.parse(raw) as Entry[]) : [];
  } catch {
    return [];
  }
}

/** Puts what was saved back into the query cache, before the first screen is drawn. */
export function hydrateCache(qc: QueryClient): void {
  const now = Date.now();
  for (const e of read()) {
    if (!Array.isArray(e.key) || now - e.at > MAX_AGE_MS) continue;
    qc.setQueryData(e.key, e.data, { updatedAt: e.at });
  }
}

/** Saves the allowed queries as they arrive (a short pause between writes). */
export function persistCache(qc: QueryClient): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = (): void => {
    const entries: Entry[] = [];
    for (const q of qc.getQueryCache().getAll()) {
      if (!KEYS.has(String(q.queryKey[0])) || q.state.status !== 'success') continue;
      entries.push({ key: [...q.queryKey], data: q.state.data, at: q.state.dataUpdatedAt });
    }
    const orders = entries
      .filter((e) => e.key[0] === 'order')
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_ORDERS);
    const keep = entries.filter((e) => e.key[0] !== 'order').concat(orders);
    try {
      localStorage.setItem(NAME(), JSON.stringify(keep));
    } catch {
      /* storage full or blocked: the app works without it */
    }
  };
  qc.getQueryCache().subscribe((ev) => {
    if (ev.type !== 'updated' || ev.action.type !== 'success') return;
    if (!KEYS.has(String(ev.query.queryKey[0]))) return;
    clearTimeout(timer);
    timer = setTimeout(save, 2000);
  });
}

/** Sign-out: nothing of this restaurant stays behind on the device. */
export function clearCache(): void {
  try {
    localStorage.removeItem(NAME());
  } catch {
    /* ignore */
  }
}
