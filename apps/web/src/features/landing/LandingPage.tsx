import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Jali, Mark } from '../../components/Brand';
import { LanguageToggle } from '../shell/LanguageToggle';

const KEY = 'erp-last-restaurant';
const read = (): string => {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
};

/** Where a restaurant's staff start in cloud mode: type the restaurant code, then go to its own sign-in. */
export function LandingPage() {
  const { t } = useTranslation();
  const [code, setCode] = useState(read);
  const [state, setState] = useState<'idle' | 'checking' | 'notFound' | 'off'>('idle');

  async function go(e: FormEvent): Promise<void> {
    e.preventDefault();
    const slug = code.trim().toLowerCase();
    if (!slug) return;
    setState('checking');
    try {
      const res = await fetch(`/api/v1/public/tenants/${encodeURIComponent(slug)}`);
      if (res.status === 404) return setState('notFound');
      const info = (await res.json()) as { slug: string; available: boolean };
      if (!info.available) return setState('off');
      try {
        localStorage.setItem(KEY, info.slug);
      } catch {
        /* private mode */
      }
      window.location.assign(`/r/${info.slug}/`);
    } catch {
      setState('notFound');
    }
  }

  return (
    <main className="relative flex min-h-full items-center justify-center overflow-hidden bg-slate-900 p-4">
      <Jali className="pointer-events-none absolute inset-0 size-full text-white/[.04]" />
      <form
        onSubmit={(e) => void go(e)}
        className="relative w-full max-w-sm space-y-5 rounded-2xl bg-white p-6 shadow-sheet"
      >
        <div className="flex items-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-xl bg-emerald-600 text-white">
            <Mark size={28} />
          </span>
          <h1 className="me-auto text-xl font-semibold tracking-tight">{t('landing.title')}</h1>
          <LanguageToggle />
        </div>
        <label className="block space-y-1">
          <span className="label">{t('landing.prompt')}</span>
          <div className="flex items-center gap-2" dir="ltr">
            <span className="text-slate-500">/r/</span>
            <input
              className="input"
              value={code}
              onChange={(e) => {
                setCode(e.target.value.toLowerCase());
                setState('idle');
              }}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              autoFocus
            />
          </div>
          <span className="hint block">{t('landing.codeHint')}</span>
        </label>
        {state === 'notFound' && (
          <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700">
            {t('landing.notFound')}
          </p>
        )}
        {state === 'off' && (
          <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
            {t('landing.off')}
          </p>
        )}
        <button
          className="btn-primary btn-lg w-full"
          disabled={!code.trim() || state === 'checking'}
        >
          {state === 'checking' ? t('landing.checking') : t('landing.continue')}
        </button>
        <p className="text-center text-xs text-slate-500">
          <a className="underline" href="/platform">
            {t('landing.platform')}
          </a>
        </p>
      </form>
    </main>
  );
}
