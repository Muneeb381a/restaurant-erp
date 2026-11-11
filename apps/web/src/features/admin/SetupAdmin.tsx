import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Icon, type IconName } from '../../components/Icon';
import { api } from '../../lib/api';
import { PageHead } from './ui';

export interface SetupStatus {
  restaurant: string;
  steps: { key: string; done: boolean; count?: number; optional?: boolean }[];
  requiredDone: number;
  requiredTotal: number;
  ready: boolean;
}

/** Where each setup step is done in the app, and an icon for it. */
export const SETUP_LINKS: Record<string, { to: string; icon: IconName }> = {
  restaurant: { to: '/admin/settings', icon: 'bag' },
  tables: { to: '/admin/tables', icon: 'tables' },
  menu: { to: '/admin/menu', icon: 'book' },
  printers: { to: '/admin/printers', icon: 'printer' },
  staff: { to: '/admin/users', icon: 'user' },
  payments: { to: '/admin/settings', icon: 'cash' },
  day: { to: '/', icon: 'clock' },
  qrMenu: { to: '/admin/qr-menu', icon: 'search' },
  tax: { to: '/admin/tax', icon: 'receipt' },
};

export function useSetupStatus(enabled = true, staleTime = 30_000) {
  return useQuery({
    queryKey: ['setup'],
    queryFn: () => api<SetupStatus>('/setup/status'),
    enabled,
    staleTime,
  });
}

/** Admin → Setup: what is ready, what is missing, and a button to each missing part. */
export function SetupAdmin() {
  const { t } = useTranslation();
  const status = useSetupStatus(true, 0); // always fresh: the owner has just changed something
  const s = status.data;
  const pct = s ? Math.round((s.requiredDone / s.requiredTotal) * 100) : 0;
  return (
    <div className="max-w-3xl space-y-4 p-4 md:p-6">
      <PageHead title={t('admin.setup')} hint={t('setup.hint')} />
      {s && (
        <div className="card space-y-3 p-4">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="font-semibold">{s.ready ? t('setup.ready') : t('setup.notReady')}</h3>
            <span className="money text-sm text-slate-600">
              {s.requiredDone}/{s.requiredTotal}
            </span>
          </div>
          <div
            className="h-2.5 overflow-hidden rounded-full bg-slate-200"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={t('setup.progress')}
          >
            <div
              className={`h-full rounded-full ${s.ready ? 'bg-emerald-600' : 'bg-amber-500'}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}
      <ul className="card divide-y divide-slate-200 overflow-hidden">
        {(s?.steps ?? []).map((step) => {
          const link = SETUP_LINKS[step.key] ?? { to: '/admin', icon: 'sliders' as IconName };
          return (
            <li
              key={step.key}
              className="flex items-center gap-3 p-4"
              data-testid={`setup-${step.key}`}
            >
              <span
                className={`flex size-10 shrink-0 items-center justify-center rounded-full ${step.done ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-600'}`}
              >
                <Icon name={step.done ? 'check' : link.icon} size={20} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2 font-medium">
                  {t(`setup.step.${step.key}`)}
                  {step.optional && <span className="chip-mute">{t('setup.optional')}</span>}
                  {step.done && <span className="chip-ok">{t('setup.done')}</span>}
                </span>
                <span className="hint block">
                  {t(`setup.why.${step.key}`)}
                  {step.count !== undefined && step.count > 0
                    ? ` · ${t('setup.count', { count: step.count })}`
                    : ''}
                </span>
              </span>
              <Link to={link.to} className={step.done ? 'btn-quiet' : 'btn-primary'}>
                {step.done ? t('setup.review') : t('setup.fix')}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
