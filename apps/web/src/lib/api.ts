import { useAuth, type Tokens } from './auth-store';

/** RFC 7807 problem+json from the API, with its stable `code`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const BASE = '/api/v1';

let refreshing: Promise<Tokens | null> | null = null;

/** Rotates the refresh token once even if several requests expire together (single flight). */
function refreshTokens(): Promise<Tokens | null> {
  if (!refreshing) {
    const current = useAuth.getState().tokens;
    refreshing = (async () => {
      if (!current) return null;
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as Tokens;
      const next = { accessToken: data.accessToken, refreshToken: data.refreshToken };
      useAuth.getState().setTokens(next);
      return next;
    })().finally(() => {
      refreshing = null;
    });
  }
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

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Order version for optimistic locking → `If-Match` */
  ifMatch?: number;
  /** Send this text as the body (CSV import) instead of JSON. */
  rawText?: { content: string; contentType: string };
  /** "text" returns the body as a string (CSV export). */
  responseType?: 'json' | 'text';
  auth?: boolean;
}

/**
 * Typed fetch for the API: bearer token, one transparent refresh on 401, problem+json errors.
 * A failed refresh logs the user out (the router then shows the login screen).
 */
export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const send = (tokens: Tokens | null): Promise<Response> =>
    fetch(`${BASE}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.rawText
          ? { 'content-type': opts.rawText.contentType }
          : opts.body !== undefined
            ? { 'content-type': 'application/json' }
            : {}),
        ...(opts.auth !== false && tokens ? { authorization: `Bearer ${tokens.accessToken}` } : {}),
        ...(opts.ifMatch !== undefined ? { 'if-match': String(opts.ifMatch) } : {}),
      },
      body: opts.rawText
        ? opts.rawText.content
        : opts.body !== undefined
          ? JSON.stringify(opts.body)
          : undefined,
    });

  let res = await send(useAuth.getState().tokens);
  if (res.status === 401 && opts.auth !== false && useAuth.getState().tokens) {
    const fresh = await refreshTokens();
    if (!fresh) {
      useAuth.getState().logout();
      throw await toError(res);
    }
    res = await send(fresh);
  }
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  if (opts.responseType === 'text') return (await res.text()) as T;
  return (await res.json()) as T;
}
