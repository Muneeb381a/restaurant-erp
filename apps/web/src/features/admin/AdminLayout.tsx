import { useTranslation } from 'react-i18next';
import { Navigate, NavLink, Outlet } from 'react-router-dom';
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

export function AdminLayout() {
  const { t } = useTranslation();
  const me = useMe();
  if (me.isPending) return <p className="p-4">{t('common.loading')}</p>;
  const allowed = ADMIN_SECTIONS.filter((s) => can(me.data, s.permission));
  if (allowed.length === 0) return <Navigate to="/" replace />;
  const groups = [...new Set(allowed.map((s) => s.group))];

  return (
    <div className="flex h-full flex-col md:flex-row">
      <nav
        className="shrink-0 overflow-auto border-slate-300 bg-white md:w-56 md:border-e"
        aria-label={t('admin.title')}
      >
        <div className="flex gap-4 overflow-x-auto p-2 md:block md:space-y-4 md:p-3">
          {groups.map((g) => (
            <div key={g} className="shrink-0">
              <div className="micro px-3 pb-1 md:pt-1">{t(g)}</div>
              <div className="flex gap-1 md:flex-col">
                {allowed
                  .filter((s) => s.group === g)
                  .map((s) => (
                    <NavLink
                      key={s.path}
                      to={`/admin/${s.path}`}
                      className={({ isActive }) =>
                        `flex min-h-touch items-center whitespace-nowrap rounded-lg px-3 text-base font-medium ${
                          isActive ? 'bg-slate-900 text-white' : 'text-slate-800 hover:bg-slate-100'
                        }`
                      }
                    >
                      {t(s.label)}
                    </NavLink>
                  ))}
              </div>
            </div>
          ))}
        </div>
      </nav>
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
