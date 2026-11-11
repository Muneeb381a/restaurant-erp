import { useTranslation } from 'react-i18next';
import { Navigate, NavLink, Outlet, useLocation } from 'react-router-dom';
import { Icon, type IconName } from '../../components/Icon';
import { can, useMe } from '../../lib/queries';

/** Which admin sections exist, the permission each needs (the API enforces them too), and their group. */
export const ADMIN_SECTIONS = [
  { path: 'menu', label: 'admin.menu', permission: 'menu.manage', group: 'admin.groupMenu' },
  {
    path: 'tables',
    label: 'admin.tables',
    permission: 'settings.manage',
    group: 'admin.groupMenu',
  },
  {
    path: 'qr-menu',
    label: 'admin.qrMenu',
    permission: 'settings.manage',
    group: 'admin.groupMenu',
  },
  { path: 'stock', label: 'admin.stock', permission: 'report.view', group: 'admin.groupStock' },
  {
    path: 'purchases',
    label: 'admin.purchases',
    permission: 'stock.manage',
    group: 'admin.groupStock',
  },
  {
    path: 'recipes',
    label: 'admin.recipes',
    permission: 'stock.manage',
    group: 'admin.groupStock',
  },
  { path: 'costs', label: 'admin.costs', permission: 'expense.manage', group: 'admin.groupStock' },
  { path: 'users', label: 'admin.users', permission: 'user.manage', group: 'admin.groupPeople' },
  { path: 'roles', label: 'admin.roles', permission: 'user.manage', group: 'admin.groupPeople' },
  {
    path: 'printers',
    label: 'admin.printers',
    permission: 'settings.manage',
    group: 'admin.groupBusiness',
  },
  { path: 'tax', label: 'admin.tax', permission: 'tax.manage', group: 'admin.groupBusiness' },
  {
    path: 'fiscal',
    label: 'admin.fiscal',
    permission: 'report.financial',
    group: 'admin.groupBusiness',
  },
  {
    path: 'settings',
    label: 'admin.settings',
    permission: 'settings.manage',
    group: 'admin.groupBusiness',
  },
] as const;

const GROUP_ICON: Record<string, IconName> = {
  'admin.groupMenu': 'book',
  'admin.groupStock': 'box',
  'admin.groupPeople': 'user',
  'admin.groupBusiness': 'sliders',
};

/**
 * Admin shell. Two tiers of tabs across the top instead of a long side list: the first tier picks an
 * area (Menu & tables, Stock & costs, People, Business), the second its screens. The page below gets
 * the full width, so wide tables fit, and the bar stays put while the page scrolls.
 */
export function AdminLayout() {
  const { t } = useTranslation();
  const me = useMe();
  const { pathname } = useLocation();
  if (me.isPending) return <p className="p-4">{t('common.loading')}</p>;
  const allowed = ADMIN_SECTIONS.filter((s) => can(me.data, s.permission));
  if (allowed.length === 0) return <Navigate to="/" replace />;
  const groups = [...new Set(allowed.map((s) => s.group))];
  const current = allowed.find((s) => pathname.startsWith(`/admin/${s.path}`));
  const activeGroup = current?.group ?? groups[0]!;
  const screens = allowed.filter((s) => s.group === activeGroup);

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b border-slate-300 bg-white">
        <nav className="flex gap-1 overflow-x-auto px-3 pt-2" aria-label={t('admin.title')}>
          {groups.map((g) => {
            const first = allowed.find((s) => s.group === g)!;
            const on = g === activeGroup;
            return (
              <NavLink
                key={g}
                to={`/admin/${first.path}`}
                aria-current={on ? 'true' : undefined}
                className={`flex min-h-11 shrink-0 items-center gap-2 rounded-t-lg border border-b-0 px-4 text-base font-semibold ${
                  on
                    ? 'border-slate-300 bg-slate-50 text-slate-900'
                    : 'border-transparent text-slate-600 hover:bg-slate-100'
                }`}
              >
                <Icon name={GROUP_ICON[g] ?? 'sliders'} size={18} />
                {t(g)}
              </NavLink>
            );
          })}
        </nav>
        <nav
          className="-mb-px flex gap-1 overflow-x-auto border-t border-slate-300 bg-slate-50 px-3"
          aria-label={t(activeGroup)}
        >
          {screens.map((s) => (
            <NavLink
              key={s.path}
              to={`/admin/${s.path}`}
              className={({ isActive }) =>
                `flex min-h-11 shrink-0 items-center whitespace-nowrap border-b-[3px] px-4 text-base ${
                  isActive
                    ? 'border-emerald-700 font-semibold text-slate-900'
                    : 'border-transparent font-medium text-slate-600 hover:text-slate-900'
                }`
              }
            >
              {t(s.label)}
            </NavLink>
          ))}
        </nav>
      </header>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        <Outlet />
      </div>
    </div>
  );
}

/** /admin → the first section this user may open. */
export function AdminIndex() {
  const me = useMe();
  if (me.isPending) return null;
  const first = ADMIN_SECTIONS.find((s) => can(me.data, s.permission));
  return <Navigate to={first ? `/admin/${first.path}` : '/'} replace />;
}
