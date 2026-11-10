import { parseRupees } from '@erp/domain';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, Outlet, useNavigate } from 'react-router-dom';
import { ApiError, api } from '../../lib/api';
import { useAuth } from '../../lib/auth-store';
import { can, useDay, useMe, useShift } from '../../lib/queries';
import { LanguageToggle } from './LanguageToggle';

/** Auth guard + top bar (business day, shift, user, language) around every signed-in screen. */
export function Shell() {
  const tokens = useAuth((s) => s.tokens);
  if (!tokens) return <Navigate to="/login" replace />;
  return <SignedIn />;
}

function SignedIn() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const nav = useNavigate();
  const logoutLocal = useAuth((s) => s.logout);
  const me = useMe();
  const day = useDay();
  const shift = useShift();
  const [floatOpen, setFloatOpen] = useState(false);

  const openDay = useMutation({
    mutationFn: () => api('/business-days/open', { method: 'POST', body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['day'] }),
  });

  async function logout(): Promise<void> {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      /* already invalid */
    }
    logoutLocal();
    qc.clear();
    nav('/login', { replace: true });
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-2 bg-slate-900 px-3 py-2 text-white">
        <Link to="/" className="me-auto text-lg font-bold">
          {t('app.title')}
        </Link>

        {day.data ? (
          <span className="rounded-full bg-emerald-700 px-3 py-1 text-sm">
            {t('shell.day')}: {day.data.businessDate}
          </span>
        ) : (
          <>
            <span className="rounded-full bg-amber-600 px-3 py-1 text-sm">{t('shell.noDay')}</span>
            {can(me.data, 'day.open') && (
              <button
                className="btn-primary"
                disabled={openDay.isPending}
                onClick={() => openDay.mutate()}
              >
                {t('shell.openDay')}
              </button>
            )}
          </>
        )}

        {day.data &&
          (shift.data ? (
            <span className="rounded-full bg-emerald-700 px-3 py-1 text-sm">
              {t('shell.shift')} ✓
            </span>
          ) : (
            can(me.data, 'shift.open') && (
              <button className="btn-secondary text-slate-900" onClick={() => setFloatOpen(true)}>
                {t('shell.openShift')}
              </button>
            )
          ))}

        <span className="text-sm text-slate-300">{me.data?.fullName}</span>
        <LanguageToggle />
        <button className="btn-secondary text-slate-900" onClick={() => void logout()}>
          {t('shell.logout')}
        </button>
      </header>

      <main className="min-h-0 flex-1 overflow-auto">
        <Outlet />
      </main>

      {floatOpen && <OpenShiftDialog onClose={() => setFloatOpen(false)} />}
    </div>
  );
}

function OpenShiftDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [value, setValue] = useState('0');
  const [error, setError] = useState<string | null>(null);

  const open = useMutation({
    mutationFn: (openingFloatPaisa: number) =>
      api('/shifts/open', { method: 'POST', body: { openingFloatPaisa } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['shift'] });
      onClose();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t('common.error')),
  });

  function submit(): void {
    try {
      open.mutate(parseRupees(value));
    } catch {
      setError(t('common.error'));
    }
  }

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/50 p-4">
      <div className="card w-full max-w-sm space-y-3 p-5">
        <h2 className="text-xl font-bold">{t('shell.openShift')}</h2>
        <label className="block space-y-1">
          <span className="text-sm text-slate-600">{t('shell.float')}</span>
          <input
            className="input"
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-rose-700">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <button className="btn-secondary flex-1" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn-primary flex-1" disabled={open.isPending} onClick={submit}>
            {t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
