import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../../lib/auth-store';
import { LoginPage } from './LoginPage';

// the page also pings /health to show whether the server is up; only the sign-in calls are asserted
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const respond = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
    String(url).includes('/health')
      ? Promise.resolve(respond(200, { status: 'ok' }))
      : fetchMock(url, init),
  );
  fetchMock.mockReset();
  useAuth.setState({ tokens: null, lastUsername: '' });
});
afterEach(() => vi.unstubAllGlobals());

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<p>floor</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function enter(username: string, pin: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/username/i), username);
  for (const digit of pin) await user.click(screen.getByRole('button', { name: digit }));
  return user;
}

describe('LoginPage', () => {
  it('keeps Sign in disabled until a username and a 4-digit PIN are entered', async () => {
    renderLogin();
    const submit = screen.getByRole('button', { name: 'Sign in' });
    expect(submit).toBeDisabled();
    await enter('cashier', '123');
    expect(submit).toBeDisabled();
    await userEvent.setup().click(screen.getByRole('button', { name: '4' }));
    expect(submit).toBeEnabled();
  });

  it('opens on the password form with the username filled in when the platform link says so', () => {
    window.history.pushState({}, '', '/?login=password&user=owner');
    try {
      renderLogin();
      expect(screen.getByLabelText('Password')).toBeInTheDocument();
      expect(screen.getByDisplayValue('owner')).toBeInTheDocument();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('signs in with username + PIN, stores the tokens and remembers the username', async () => {
    fetchMock.mockResolvedValueOnce(respond(200, { accessToken: 'a', refreshToken: 'r' }));
    renderLogin();
    const user = await enter('cashier', '1234');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.getByText('floor')).toBeInTheDocument());
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
      username: 'cashier',
      pin: '1234',
    });
    expect(useAuth.getState().tokens).toEqual({ accessToken: 'a', refreshToken: 'r' });
    expect(useAuth.getState().lastUsername).toBe('cashier');
  });

  it('shows a clear message and clears the PIN on wrong credentials', async () => {
    fetchMock.mockResolvedValueOnce(respond(401, { code: 'INVALID_CREDENTIALS', title: 'x' }));
    renderLogin();
    const user = await enter('cashier', '9999');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong username or PIN');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled(); // PIN was cleared
    expect(useAuth.getState().tokens).toBeNull();
  });

  it('tells the user how long an account is locked', async () => {
    fetchMock.mockResolvedValueOnce(
      respond(423, { code: 'ACCOUNT_LOCKED', title: 'locked', retryAfterSeconds: 540 }),
    );
    renderLogin();
    const user = await enter('cashier', '1234');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Try again in 9 min');
  });

  it('reports an unreachable server differently from wrong credentials', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    renderLogin();
    const user = await enter('cashier', '1234');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot reach the server');
  });

  it('switches to Urdu and right-to-left', async () => {
    renderLogin();
    await userEvent.setup().click(screen.getByRole('button', { name: 'اردو' }));
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('ur');
    expect(screen.getAllByText('لاگ اِن').length).toBeGreaterThan(0);
    await userEvent.setup().click(screen.getByRole('button', { name: 'English' }));
    expect(document.documentElement.dir).toBe('ltr');
  });
});
