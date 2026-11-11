import { useTranslation } from 'react-i18next';
import { Navigate, NavLink, Outlet } from 'react-router-dom';
import { can, useMe } from '../../lib/queries';

/** Which admin sections exist, and the permission each needs (the API enforces them too). */
export const ADMIN_SECTIONS = [
  { path: 'menu', label: 'admin.menu', permission: 'menu.manage' },
  { path: 'printers', label: 'admin.printers', permission: 'settings.manage' },
  { path: 'tables', label: 'admin.tables', permission: 'settings.manage' },
  { path: 'users', label: 'admin.users', permission: 'user.manage' },
  { path: 'stock', label: 'admin.stock', permission: 'report.view' },
  { path: 'purchases', label: 'admin.purchases', permission: 'stock.manage' },
  { path: 'recipes', label: 'admin.recipes', permission: 'stock.manage' },
  { path: 'costs', label: 'admin.costs', permission: 'expense.manage' },
  { path: 'tax', label: 'admin.tax', permission: 'tax.manage' },
  { path: 'fiscal', label: 'admin.fiscal', permission: 'report.financial' },
  { path: 'roles', label: 'admin.roles', permission: 'user.manage' },
  { path: 'settings', label: 'admin.settings', permission: 'settings.manage' },
] as const;

export function AdminLayout() {
  const { t } = useTranslation();
  const me = useMe();
  if (me.isPending) return <p className="p-4">{t('common.loading')}</p>;
  const allowed = ADMIN_SECTIONS.filter((s) => can(me.data, s.permission));
  if (allowed.length === 0) return <Navigate to="/" replace />;

  return (
    <div className="flex h-full flex-col">
      <nav
        className="flex gap-2 overflow-x-auto border-b border-slate-200 bg-white px-3 py-2"
        aria-label={t('admin.title')}
      >
        {allowed.map((s) => (
          <NavLink
            key={s.path}
            to={`/admin/${s.path}`}
            className={({ isActive }) =>
              `shrink-0 whitespace-nowrap ${isActive ? 'btn-primary' : 'btn-secondary'}`
            }
          >
            {t(s.label)}
          </NavLink>
        ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-auto">
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
