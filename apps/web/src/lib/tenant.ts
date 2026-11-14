import { create } from 'zustand';

/**
 * Where this page lives. One build serves three kinds of address:
 *
 *   /                    single-restaurant install (the till on the restaurant's own network)
 *   /r/<code>/…          cloud: one restaurant, named by its code
 *   /platform/…          cloud: the platform admin who creates and manages restaurants
 *   anything else        cloud: the "enter your restaurant code" page
 *
 * Cloud is switched on at build time (VITE_MULTI_TENANT=true). The mode is read once when the page
 * loads: moving between restaurants is a full page load, so nothing from one can leak into another.
 */
export type Mode =
  | { kind: 'single' }
  | { kind: 'tenant'; slug: string }
  | { kind: 'platform' }
  | { kind: 'landing' };

const TENANT_PATH = /^\/r\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])(?:\/|$)/;

export function detectMode(pathname: string, multi: boolean): Mode {
  if (!multi) return { kind: 'single' };
  const m = TENANT_PATH.exec(pathname);
  if (m) return { kind: 'tenant', slug: m[1]! };
  if (pathname === '/platform' || pathname.startsWith('/platform/')) return { kind: 'platform' };
  return { kind: 'landing' };
}

const MULTI = import.meta.env.VITE_MULTI_TENANT === 'true';

export const mode: Mode = detectMode(
  typeof window === 'undefined' ? '/' : window.location.pathname,
  MULTI,
);

/** Prefix for the router, so every existing route ('/kitchen', '/admin/…') works under /r/<code>. */
export const routerBasename = (m: Mode = mode): string =>
  m.kind === 'tenant' ? `/r/${m.slug}` : m.kind === 'platform' ? '/platform' : '';

/** Where this restaurant's API is. */
export const apiBase = (m: Mode = mode): string =>
  m.kind === 'tenant' ? `/api/v1/r/${m.slug}` : '/api/v1';

/** Health check path for the "server reachable" dot on the sign-in screen. */
export const healthPath = (m: Mode = mode): string =>
  m.kind === 'tenant' ? `/api/v1/r/${m.slug}/health` : '/health';

/** Turns an API path the server wrote (`/api/v1/public/items/…/image`) into one that works for this restaurant. */
export const withApiBase = (path: string, m: Mode = mode): string =>
  path.startsWith('/api/v1/') ? `${apiBase(m)}${path.slice('/api/v1'.length)}` : path;

/** A key that differs per restaurant, so two restaurants open in one browser never share a session. */
export const storageKey = (name: string, m: Mode = mode): string =>
  m.kind === 'tenant' ? `${name}:${m.slug}` : name;

/** The full address of this restaurant's own pages (the QR menu link is built from it). */
export const appOrigin = (m: Mode = mode): string =>
  typeof window === 'undefined' ? '' : `${window.location.origin}${routerBasename(m)}`;

/** Set when the server says this restaurant has been switched off while someone is using it. */
export const useTenantState = create<{ suspended: boolean; reason: string | null }>(() => ({
  suspended: false,
  reason: null,
}));
