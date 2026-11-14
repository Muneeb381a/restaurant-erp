import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate } from 'react-router-dom';
import { Mark } from '../../components/Brand';
import { ApiError } from '../../lib/api';
import { platformApi, usePlatformAuth } from '../../lib/platform-api';

/** The platform admin signs in with a username and a password: no PIN, and nothing shared with a restaurant's login. */
export function PlatformLogin() {
  const { t } = useTranslation();
  const tokens = usePlatformAuth((s) => s.tokens);
  const setSession = usePlatformAuth((s) => s.setSession);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (tokens) return <Navigate to="/" replace />;

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const out = await platformApi<{ accessToken: string; refreshToken: string }>('/auth/login', {
        method: 'POST',
        body: { username: username.trim(), password },
        auth: false,
      });
      setSession({ accessToken: out.accessToken, refreshToken: out.refreshToken }, username.trim());
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'ACCOUNT_LOCKED'
          ? t('platform.locked')
          : err instanceof ApiError && err.status === 401
            ? t('platform.badLogin')
            : t('common.error'),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-full items-center justify-center bg-slate-900 p-4">
      <form
        onSubmit={(e) => void submit(e)}
        className="w-full max-w-sm space-y-5 rounded-2xl bg-white p-6 shadow-sheet"
      >
        <div className="flex items-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-xl bg-emerald-600 text-white">
            <Mark size={28} />
          </span>
          <div className="leading-tight">
            <h1 className="text-xl font-semibold tracking-tight">{t('platform.title')}</h1>
            <p className="hint">{t('platform.loginHint')}</p>
          </div>
        </div>
        <label className="block space-y-1">
          <span className="label">{t('platform.username')}</span>
          <input
            className="input"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
          />
        </label>
        <label className="block space-y-1">
          <span className="label">{t('platform.password')}</span>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700">
            {error}
          </p>
        )}
        <button className="btn-primary btn-lg w-full" disabled={busy || !username || !password}>
          {t('platform.signIn')}
        </button>
      </form>
    </main>
  );
}
