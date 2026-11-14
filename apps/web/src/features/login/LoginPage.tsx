import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Jali, Mark } from '../../components/Brand';
import { Icon, type IconName } from '../../components/Icon';
import { ApiError, api } from '../../lib/api';
import { useAuth, type Tokens } from '../../lib/auth-store';
import { healthPath } from '../../lib/tenant';
import { useTenantInfo } from '../landing/TenantGate';
import { LanguageToggle } from '../shell/LanguageToggle';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;
const MAX_PIN = 8;

/** Is the server on the network answering? Shown on the sign-in screen so "wrong PIN" is never a guess. */
function useServerUp(): boolean | null {
  const [up, setUp] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    const ping = async (): Promise<void> => {
      try {
        const r = await fetch(healthPath(), { cache: 'no-store' });
        if (alive) setUp(r.ok);
      } catch {
        if (alive) setUp(false);
      }
    };
    void ping();
    const id = setInterval(() => void ping(), 10_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return up;
}

const FEATURES: { icon: IconName; key: string }[] = [
  { icon: 'tables', key: 'login.f1' },
  { icon: 'receipt', key: 'login.f2' },
  { icon: 'globe', key: 'login.f3' },
];

export function LoginPage() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { lastUsername, setLastUsername, setTokens } = useAuth();
  const [username, setUsername] = useState(lastUsername);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(false);
  // managers and owners may sign in with a password; staff use the PIN pad
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState('');
  const up = useServerUp();
  const tenant = useTenantInfo();
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const hour = new Date().getHours();
  const greeting =
    hour < 12 ? t('login.morning') : hour < 17 ? t('login.afternoon') : t('login.evening');

  async function submit(code: string): Promise<void> {
    if (!username.trim() || code.length < (usePassword ? 1 : 4) || busy) return;
    setBusy(true);
    setError(null);
    try {
      const tokens = await api<Tokens>(usePassword ? '/auth/login' : '/auth/login-pin', {
        method: 'POST',
        body: usePassword
          ? { username: username.trim(), password: code }
          : { username: username.trim(), pin: code },
        auth: false,
      });
      setLastUsername(username.trim());
      setTokens({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
      nav('/', { replace: true });
    } catch (e) {
      setPin('');
      setPassword('');
      setShake(true);
      setTimeout(() => setShake(false), 400);
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
    setError(null);
    setPin((p) => (p.length >= MAX_PIN ? p : p + digit));
  };

  // a hardware keyboard works too: digits, Backspace, Enter, Escape (unless typing the username)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        if (e.key === 'Enter' && el.tagName === 'INPUT' && pinRef.current.length === 0) return;
        if (e.key !== 'Enter') return;
      }
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') setPin((p) => p.slice(0, -1));
      else if (e.key === 'Escape') setPin('');
      else if (e.key === 'Enter') document.getElementById('signin-go')?.click();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const slots = Math.max(4, pin.length);
  const ready = usePassword
    ? password.length > 0 && username.trim().length > 0
    : pin.length >= 4 && username.trim().length > 0;

  return (
    <main className="grid min-h-full lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      {/* brand panel */}
      <section className="relative hidden overflow-hidden bg-emerald-800 text-white lg:flex lg:flex-col lg:justify-between lg:p-12">
        <Jali className="absolute inset-0 text-white opacity-[0.07]" />
        <div className="relative flex items-center gap-3 text-xl font-semibold tracking-tight">
          <Mark size={34} />
          Restaurant POS
        </div>
        <div className="relative max-w-md space-y-8">
          <h2 className="text-balance text-4xl font-semibold leading-tight tracking-tight">
            {t('login.tagline')}
          </h2>
          <ul className="space-y-4">
            {FEATURES.map((f) => (
              <li key={f.key} className="flex items-start gap-3 text-emerald-100">
                <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/10 text-white">
                  <Icon name={f.icon} size={20} />
                </span>
                <span className="pt-1">{t(f.key)}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-sm text-emerald-200">{t('login.footer')}</p>
      </section>

      {/* sign-in */}
      <section className="flex flex-col bg-slate-50">
        <header className="flex items-center justify-between gap-3 p-4 lg:p-6">
          <div className="flex items-center gap-2 font-semibold tracking-tight text-emerald-800 lg:invisible">
            <Mark size={26} />
            Restaurant POS
          </div>
          <LanguageToggle />
        </header>

        <div className="flex flex-1 items-center justify-center px-4 pb-8">
          <div className="w-full max-w-sm space-y-5">
            <div>
              <p className="micro">{greeting}</p>
              <h1 className="mt-1 text-3xl font-semibold tracking-tight">{t('login.title')}</h1>
              {tenant && (
                <p
                  className="mt-1 text-lg font-medium text-emerald-800"
                  data-testid="restaurant-name"
                >
                  {tenant.name}
                </p>
              )}
              <p className="hint mt-1">{t('login.sub')}</p>
            </div>

            <label className="block space-y-1.5">
              <span className="label">{t('login.username')}</span>
              <div className="relative">
                <Icon
                  name="user"
                  size={20}
                  className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-slate-500"
                />
                <input
                  className="input ps-11 text-lg"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                />
              </div>
            </label>

            {usePassword && (
              <label className="block space-y-1.5">
                <span className="label">{t('login.password')}</span>
                <input
                  className="input text-lg"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => {
                    setError(null);
                    setPassword(e.target.value);
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && ready && void submit(password)}
                />
              </label>
            )}

            <div className={`space-y-3 ${usePassword ? 'hidden' : ''}`} dir="ltr">
              <div className="flex items-baseline justify-between">
                <span className="label">{t('login.pin')}</span>
                <button
                  type="button"
                  className="text-sm font-medium text-slate-700 underline-offset-2 hover:underline disabled:opacity-40"
                  disabled={!pin}
                  onClick={() => setPin('')}
                >
                  {t('login.clear')}
                </button>
              </div>
              <div
                role="img"
                aria-label={t('login.pinEntered', { count: pin.length })}
                className={`flex h-14 items-center justify-center gap-3 rounded-lg border bg-white ${error ? 'border-rose-400' : 'border-slate-300'} ${shake ? 'animate-[shake_.35s]' : ''}`}
              >
                {Array.from({ length: slots }, (_, i) => (
                  <span
                    key={i}
                    className={`size-3.5 rounded-full border-2 transition-colors ${i < pin.length ? 'border-slate-900 bg-slate-900' : 'border-slate-400'}`}
                  />
                ))}
              </div>
              <div className="grid grid-cols-3 gap-2">
                {KEYS.map((k) => (
                  <button key={k} type="button" className="key" onClick={() => press(k)}>
                    {k}
                  </button>
                ))}
                <span />
                <button type="button" className="key" onClick={() => press('0')}>
                  0
                </button>
                <button
                  type="button"
                  className="key"
                  onClick={() => setPin((p) => p.slice(0, -1))}
                  aria-label={t('login.backspace')}
                >
                  <Icon name="chevronLeft" size={22} />
                </button>
              </div>
            </div>

            {error && (
              <p
                role="alert"
                className="flex items-center gap-2 rounded-lg bg-rose-50 p-3 text-sm font-medium text-rose-800"
              >
                <Icon name="alert" size={18} />
                {error}
              </p>
            )}

            <button
              id="signin-go"
              type="button"
              className="btn-primary btn-lg w-full"
              disabled={busy || !ready}
              onClick={() => void submit(usePassword ? password : pin)}
            >
              {busy ? t('common.loading') : t('login.submit')}
            </button>
            <button
              type="button"
              className="block w-full text-center text-sm font-medium text-slate-700 underline-offset-2 hover:underline"
              onClick={() => {
                setUsePassword(!usePassword);
                setError(null);
                setPin('');
                setPassword('');
              }}
            >
              {usePassword ? t('login.usePin') : t('login.usePassword')}
            </button>
          </div>
        </div>

        <footer className="flex items-center justify-center gap-2 p-4 text-sm text-slate-600">
          <span
            className={`size-2.5 rounded-full ${up === null ? 'bg-slate-400' : up ? 'bg-emerald-600' : 'bg-rose-600'}`}
          />
          {up === null ? t('login.checking') : up ? t('login.serverUp') : t('login.network')}
        </footer>
      </section>
    </main>
  );
}
