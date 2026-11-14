import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Navigate, NavLink, Outlet, Route, Routes } from 'react-router-dom';
import { Mark } from '../../components/Brand';
import { Icon } from '../../components/Icon';
import { platformApi, usePlatformAuth, type AuditEntry } from '../../lib/platform-api';
import { PageHead } from '../admin/ui';
import { LanguageToggle } from '../shell/LanguageToggle';
import { PlatformLogin } from './PlatformLogin';
import { TenantDetailPage } from './TenantDetailPage';
import { TenantsPage } from './TenantsPage';

/** The platform admin's screens, served under /platform. */
export function PlatformApp() {
  return (
    <Routes>
      <Route path="/login" element={<PlatformLogin />} />
      <Route element={<PlatformShell />}>
        <Route index element={<TenantsPage />} />
        <Route path="restaurants/:id" element={<TenantDetailPage />} />
        <Route path="activity" element={<ActivityPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function PlatformShell() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const tokens = usePlatformAuth((s) => s.tokens);
  const username = usePlatformAuth((s) => s.username);
  const logout = usePlatformAuth((s) => s.logout);
  if (!tokens) return <Navigate to="/login" replace />;

  async function signOut(): Promise<void> {
    try {
      await platformApi('/auth/logout', { method: 'POST' });
    } catch {
      /* already invalid */
    }
    logout();
    qc.clear();
  }

  const link = ({ isActive }: { isActive: boolean }): string =>
    `flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium ${isActive ? 'bg-white text-slate-900' : 'text-slate-300 hover:bg-white/10 hover:text-white'}`;

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-16 shrink-0 items-center gap-3 bg-slate-900 px-3 text-white sm:px-5">
        <span className="flex size-10 items-center justify-center rounded-xl bg-emerald-600">
          <Mark size={26} />
        </span>
        <div className="me-3 leading-tight">
          <div className="font-semibold tracking-tight">{t('platform.title')}</div>
          <div className="text-[0.7rem] uppercase tracking-[0.12em] text-slate-400">
            {t('platform.subtitle')}
          </div>
        </div>
        <nav className="flex gap-1" aria-label={t('platform.title')}>
          <NavLink to="/" end className={link}>
            {t('platform.restaurants')}
          </NavLink>
          <NavLink to="/activity" className={link}>
            {t('platform.activity')}
          </NavLink>
        </nav>
        <div className="ms-auto flex items-center gap-2">
          <LanguageToggle />
          <span className="hidden text-sm text-slate-300 sm:inline">{username}</span>
          <button
            className="btn-quiet text-slate-200 hover:text-white"
            onClick={() => void signOut()}
          >
            <Icon name="logout" size={18} />
            <span className="hidden sm:inline">{t('shell.logout')}</span>
          </button>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}

/** Everything the platform admin has done, newest first. */
function ActivityPage() {
  const { t } = useTranslation();
  const trail = useQuery({
    queryKey: ['platform', 'audit', 'all'],
    queryFn: async () => (await platformApi<{ items: AuditEntry[] }>('/audit?limit=200')).items,
  });
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-6">
      <PageHead title={t('platform.activity')} hint={t('platform.activityHint')} />
      <div className="dt">
        <table className="min-w-[34rem]">
          <thead>
            <tr>
              <th>{t('platform.when')}</th>
              <th>{t('platform.what')}</th>
              <th>{t('platform.restaurant')}</th>
              <th>{t('platform.by')}</th>
            </tr>
          </thead>
          <tbody>
            {(trail.data ?? []).map((e) => (
              <tr key={e.id}>
                <td className="whitespace-nowrap text-slate-700">
                  {new Date(e.at).toLocaleString()}
                </td>
                <td className="font-medium">{t(`platform.action.${e.action}`, e.action)}</td>
                <td dir="ltr">{e.tenant ?? '–'}</td>
                <td>{e.admin ?? '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
