import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from './api';
import { useAuth } from './auth-store';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  useAuth.setState({ tokens: { accessToken: 'old-access', refreshToken: 'old-refresh' } });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const authHeader = (call: number): string | undefined =>
  (fetchMock.mock.calls[call]![1]!.headers as Record<string, string>).authorization;

describe('api()', () => {
  it('sends the bearer token and parses JSON', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ok: true }));
    expect(await api<{ ok: boolean }>('/floor')).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/v1/floor');
    expect(authHeader(0)).toBe('Bearer old-access');
  });

  it('sends JSON bodies and If-Match', async () => {
    fetchMock.mockResolvedValueOnce(json(200, {}));
    await api('/orders/1', { method: 'PATCH', body: { guests: 2 }, ifMatch: 7 });
    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.method).toBe('PATCH');
    expect(init.body).toBe('{"guests":2}');
    expect((init.headers as Record<string, string>)['if-match']).toBe('7');
  });

  it('turns problem+json into an ApiError with the stable code and body', async () => {
    fetchMock.mockResolvedValueOnce(
      json(409, { code: 'TABLE_OCCUPIED', title: 'busy', orderId: 'o1' }),
    );
    const err = await api('/orders', { method: 'POST', body: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 409,
      code: 'TABLE_OCCUPIED',
      message: 'busy',
      body: { orderId: 'o1' },
    });
  });

  it('returns undefined for 204', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await api('/auth/logout', { method: 'POST' })).toBeUndefined();
  });

  it('refreshes once on 401 and retries with the new token', async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, { code: 'UNAUTHENTICATED', title: 'expired' }))
      .mockResolvedValueOnce(json(200, { accessToken: 'new-access', refreshToken: 'new-refresh' }))
      .mockResolvedValueOnce(json(200, { ok: 1 }));
    expect(await api('/floor')).toEqual({ ok: 1 });
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/v1/auth/refresh');
    expect(authHeader(2)).toBe('Bearer new-access');
    expect(useAuth.getState().tokens).toEqual({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
    });
  });

  it('shares ONE refresh between concurrent requests (rotating refresh tokens must not be replayed)', async () => {
    fetchMock.mockImplementation(async (url) => {
      if (url.endsWith('/auth/refresh'))
        return json(200, { accessToken: 'new-access', refreshToken: 'new-refresh' });
      const headers = (fetchMock.mock.calls.find((c) => c[0] === url) ?? [])[1];
      void headers;
      return json(200, { ok: true });
    });
    // first attempts fail with 401, retries succeed
    let calls = 0;
    fetchMock.mockImplementation(async (url, init) => {
      if (url.endsWith('/auth/refresh'))
        return json(200, { accessToken: 'new-access', refreshToken: 'new-refresh' });
      calls++;
      const token = (init!.headers as Record<string, string>).authorization;
      return token === 'Bearer old-access'
        ? json(401, { code: 'UNAUTHENTICATED' })
        : json(200, { n: calls });
    });
    const results = await Promise.all([api('/a'), api('/b'), api('/c')]);
    expect(results).toHaveLength(3);
    expect(fetchMock.mock.calls.filter((c) => c[0].endsWith('/auth/refresh'))).toHaveLength(1);
  });

  it('logs out when the refresh fails', async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, { code: 'UNAUTHENTICATED', title: 'expired' }))
      .mockResolvedValueOnce(json(401, { code: 'REFRESH_REUSED' }));
    await expect(api('/floor')).rejects.toBeInstanceOf(ApiError);
    expect(useAuth.getState().tokens).toBeNull();
  });

  it('does not attach or refresh tokens for unauthenticated calls (login)', async () => {
    fetchMock.mockResolvedValueOnce(json(401, { code: 'INVALID_CREDENTIALS', title: 'nope' }));
    await expect(
      api('/auth/login-pin', { method: 'POST', body: {}, auth: false }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(authHeader(0)).toBeUndefined();
    expect(useAuth.getState().tokens).not.toBeNull();
  });
});
