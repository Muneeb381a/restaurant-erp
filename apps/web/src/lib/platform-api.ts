import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ApiError } from './api';

/** The platform admin's own session. A different store and key from any restaurant's login. */
interface PlatformAuth {
  tokens: { accessToken: string; refreshToken: string } | null;
  username: string;
  setSession: (t: PlatformAuth['tokens'], username?: string) => void;
  logout: () => void;
}

export const usePlatformAuth = create<PlatformAuth>()(
  persist(
    (set) => ({
      tokens: null,
      username: '',
      setSession: (tokens, username) => set((s) => ({ tokens, username: username ?? s.username })),
      logout: () => set({ tokens: null }),
    }),
    { name: 'erp-platform-auth' },
  ),
);

const BASE = '/api/v1/platform';

let refreshing: Promise<boolean> | null = null;
function refresh(): Promise<boolean> {
  refreshing ??= (async () => {
    const cur = usePlatformAuth.getState().tokens;
    if (!cur) return false;
    const res = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: cur.refreshToken }),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { accessToken: string; refreshToken: string };
    usePlatformAuth.getState().setSession({
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
    });
    return true;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function toError(res: Response): Promise<ApiError> {
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  return new ApiError(
    res.status,
    String(body.code ?? 'HTTP_ERROR'),
    String(body.title ?? res.statusText),
    body,
  );
}

export async function platformApi<T>(
  path: string,
  opts: { method?: 'GET' | 'POST' | 'PATCH'; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  const send = (): Promise<Response> => {
    const tokens = usePlatformAuth.getState().tokens;
    return fetch(`${BASE}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(opts.auth !== false && tokens ? { authorization: `Bearer ${tokens.accessToken}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  };
  let res = await send();
  if (res.status === 401 && opts.auth !== false && usePlatformAuth.getState().tokens) {
    if (await refresh()) res = await send();
    else {
      usePlatformAuth.getState().logout();
      throw await toError(res);
    }
  }
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ───────────────────────────── shapes the screens use ─────────────────────────────

export type TenantStatus = 'PROVISIONING' | 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED' | 'FAILED';

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  plan: string;
  provider: 'NEON' | 'LOCAL';
  region: string | null;
  ownerName: string;
  ownerUsername: string;
  contactPhone: string | null;
  notes: string | null;
  lastError: string | null;
  createdAt: string;
  activatedAt: string | null;
  suspendedAt: string | null;
  suspendedReason: string | null;
}

export interface Provisioned {
  tenant: Tenant;
  owner: { username: string; temporaryPassword: string };
}

export interface TenantHealth {
  reachable: boolean;
  latencyMs: number | null;
  migrations: { applied: number; available: number; upToDate: boolean };
  databaseBytes: number | null;
  error: string | null;
}

export interface AuditEntry {
  id: string;
  at: string;
  action: string;
  detail: Record<string, unknown>;
  admin: string | null;
  tenant: string | null;
  ip: string | null;
}
