import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ApiError, api } from '../../lib/api';
import { useAuth, type Tokens } from '../../lib/auth-store';
import { LanguageToggle } from '../shell/LanguageToggle';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

export function LoginPage() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { lastUsername, setLastUsername, setTokens } = useAuth();
  const [username, setUsername] = useState(lastUsername);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(code: string): Promise<void> {
    if (!username.trim() || code.length < 4 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const tokens = await api<Tokens>('/auth/login-pin', {
        method: 'POST',
        body: { username: username.trim(), pin: code },
        auth: false,
      });
      setLastUsername(username.trim());
      setTokens({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
      nav('/', { replace: true });
    } catch (e) {
      setPin('');
      if (e instanceof ApiError && e.code === 'ACCOUNT_LOCKED') {
        const seconds = Number(e.body.retryAfterSeconds ?? 600);
        setError(t('login.locked', { minutes: Math.max(1, Math.ceil(seconds / 60)) }));
      } else if (e instanceof ApiError && e.status < 500) {
        setError(t('login.wrong'));
      } else {
        setError(t('login.network'));
      }
    } finally {
      setBusy(false);
    }
  }

  const press = (digit: string): void => {
    if (pin.length >= 8) return;
    setPin(pin + digit);
  };

  return (
    <main className="flex min-h-full items-center justify-center p-4">
      <div className="card w-full max-w-sm space-y-4 p-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">{t('login.title')}</h1>
          <LanguageToggle />
        </div>

        <label className="block space-y-1">
          <span className="text-sm text-slate-600">{t('login.username')}</span>
          <input
            className="input"
            autoComplete="username"
            autoCapitalize="none"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>

        <div className="space-y-2" dir="ltr">
          <div
            aria-label={t('login.pin')}
            className="flex min-h-touch items-center justify-center rounded-lg bg-slate-100 text-3xl tracking-[0.5em]"
          >
            {pin ? (
              '•'.repeat(pin.length)
            ) : (
              <span className="text-base tracking-normal text-slate-400">{t('login.pin')}</span>
            )}
          </div>
          <div className="grid grid-cols-3 gap-2">
            {KEYS.map((k) => (
              <button
                key={k}
                type="button"
                className="btn-secondary h-14 text-xl"
                onClick={() => press(k)}
              >
                {k}
              </button>
            ))}
            <button
              type="button"
              className="btn-secondary h-14"
              onClick={() => setPin('')}
              aria-label="clear"
            >
              C
            </button>
            <button type="button" className="btn-secondary h-14 text-xl" onClick={() => press('0')}>
              0
            </button>
            <button
              type="button"
              className="btn-secondary h-14"
              onClick={() => setPin(pin.slice(0, -1))}
              aria-label="backspace"
            >
              ⌫
            </button>
          </div>
        </div>

        {error && (
          <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700">
            {error}
          </p>
        )}

        <button
          type="button"
          className="btn-primary h-14 w-full text-lg"
          disabled={busy || pin.length < 4 || !username.trim()}
          onClick={() => void submit(pin)}
        >
          {t('login.submit')}
        </button>
      </div>
    </main>
  );
}
