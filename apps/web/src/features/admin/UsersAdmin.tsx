import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { api } from '../../lib/api';
import type { RoleRow, UserRow } from '../../lib/types';
import { Avatar } from '../../components/Avatar';
import { Dialog, EmptyRow, ErrorText, Field, PageHead, Toggle } from './ui';

/** One calm colour per kind of staff member, so a list of people reads at a glance. */
export const ROLE_TONE: Record<string, { chip: string; dot: string }> = {
  OWNER: { chip: 'bg-violet-100 text-violet-700', dot: 'bg-violet-500' },
  MANAGER: { chip: 'bg-sky-100 text-sky-800', dot: 'bg-sky-500' },
  CASHIER: { chip: 'bg-emerald-100 text-emerald-800', dot: 'bg-emerald-500' },
  CAPTAIN: { chip: 'bg-amber-100 text-amber-800', dot: 'bg-amber-500' },
  KITCHEN: { chip: 'bg-orange-100 text-orange-700', dot: 'bg-orange-500' },
  ACCOUNTANT: { chip: 'bg-teal-100 text-teal-700', dot: 'bg-teal-500' },
  STORE: { chip: 'bg-pink-100 text-pink-700', dot: 'bg-pink-500' },
};
export const toneOf = (code: string): { chip: string; dot: string } =>
  ROLE_TONE[code] ?? { chip: 'bg-slate-100 text-slate-700', dot: 'bg-slate-400' };

export function UsersAdmin() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const users = useQuery({
    queryKey: ['admin-users'],
    queryFn: async () => (await api<{ items: UserRow[] }>('/users')).items,
  });
  const roles = useQuery({
    queryKey: ['admin-roles'],
    queryFn: async () => (await api<{ items: RoleRow[] }>('/roles')).items,
  });
  const [dialog, setDialog] = useState<'new' | UserRow | null>(null);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [state, setState] = useState<'ALL' | 'ACTIVE' | 'OFF' | 'LOCKED'>('ALL');
  const refresh = (): Promise<void> => qc.invalidateQueries({ queryKey: ['admin-users'] });

  const toggle = useMutation({
    mutationFn: (v: { id: string; on: boolean }) =>
      api(`/users/${v.id}`, { method: 'PATCH', body: { isActive: v.on } }),
    onSuccess: refresh,
    onError: setError,
  });
  const unlock = useMutation({
    mutationFn: (id: string) => api(`/users/${id}/unlock`, { method: 'POST' }),
    onSuccess: refresh,
    onError: setError,
  });
  const lockedNow = (u: UserRow): boolean =>
    !!u.locked_until && new Date(u.locked_until).getTime() > Date.now();

  const all = users.data ?? [];
  const activeN = all.filter((u) => u.is_active).length;
  const lockedN = all.filter(lockedNow).length;
  const roleCodes = useMemo(() => {
    const m = new Map<string, number>();
    for (const u of all) m.set(u.role_code, (m.get(u.role_code) ?? 0) + 1);
    return [...m.entries()];
  }, [all]);
  const q = search.trim().toLowerCase();
  const shown = all.filter(
    (u) =>
      (!roleFilter || u.role_code === roleFilter) &&
      (state === 'ALL' ||
        (state === 'ACTIVE' && u.is_active) ||
        (state === 'OFF' && !u.is_active) ||
        (state === 'LOCKED' && lockedNow(u))) &&
      (!q || `${u.full_name} ${u.username}`.toLowerCase().includes(q)),
  );
  const stats = [
    {
      key: 'ALL' as const,
      n: all.length,
      label: t('admin.usersPage.statPeople'),
      icon: 'user' as const,
      tone: 'bg-slate-100 text-slate-700',
    },
    {
      key: 'ACTIVE' as const,
      n: activeN,
      label: t('admin.usersPage.statActive'),
      icon: 'check' as const,
      tone: 'bg-emerald-100 text-emerald-700',
    },
    {
      key: 'OFF' as const,
      n: all.length - activeN,
      label: t('admin.usersPage.statOff'),
      icon: 'pause' as const,
      tone: 'bg-amber-100 text-amber-800',
    },
    {
      key: 'LOCKED' as const,
      n: lockedN,
      label: t('admin.usersPage.statLocked'),
      icon: 'alert' as const,
      tone: 'bg-rose-100 text-rose-700',
    },
  ];

  return (
    <div className="max-w-6xl space-y-4 p-4 md:p-6">
      <PageHead title={t('admin.users')} hint={t('admin.usersPage.hint')}>
        <button className="btn-primary" onClick={() => setDialog('new')}>
          <Icon name="plus" size={18} />
          {t('admin.usersPage.newUser')}
        </button>
      </PageHead>
      <ErrorText error={error} />
      <div
        className="grid grid-cols-2 gap-3 sm:grid-cols-4"
        role="group"
        aria-label={t('admin.usersPage.show')}
      >
        {stats.map((x) => (
          <button
            key={x.key}
            aria-pressed={state === x.key}
            onClick={() => setState(x.key)}
            className="card flex items-center gap-3 p-3 text-start transition-shadow hover:shadow-md aria-pressed:border-slate-900 aria-pressed:ring-2 aria-pressed:ring-slate-900/10"
          >
            <span
              className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${x.tone}`}
            >
              <Icon name={x.icon} size={20} />
            </span>
            <span className="min-w-0">
              <span className="money block text-2xl font-semibold leading-none">{x.n}</span>
              <span className="mt-1 block truncate text-sm text-slate-600">{x.label}</span>
            </span>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Icon
            name="search"
            size={18}
            className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-slate-500"
          />
          <input
            className="input ps-10"
            placeholder={t('admin.usersPage.search')}
            aria-label={t('admin.usersPage.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div
          className="flex max-w-full gap-1.5 overflow-x-auto"
          role="group"
          aria-label={t('admin.usersPage.role')}
        >
          <button
            className="seg-item shrink-0 whitespace-nowrap border border-slate-200 bg-white"
            aria-pressed={roleFilter === ''}
            onClick={() => setRoleFilter('')}
          >
            {t('admin.all')}
          </button>
          {roleCodes.map(([code, n]) => (
            <button
              key={code}
              className="seg-item shrink-0 whitespace-nowrap border border-slate-200 bg-white"
              aria-pressed={roleFilter === code}
              onClick={() => setRoleFilter(code)}
            >
              <span className={`me-2 size-2 rounded-full ${toneOf(code).dot}`} aria-hidden="true" />
              {t(`role.${code}`, { defaultValue: code })}
              <span className="money ms-1.5 opacity-60">{n}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="dt">
        <table className="min-w-[44rem]">
          <thead>
            <tr>
              <th>{t('admin.usersPage.fullName')}</th>
              <th>{t('admin.usersPage.role')}</th>
              <th>{t('admin.active')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((u) => (
              <tr key={u.id} className={u.is_active ? '' : 'opacity-60'}>
                <td>
                  <span className="flex items-center gap-3">
                    <Avatar name={u.full_name} size={44} userId={u.id} version={u.avatar_version} />
                    <span className="name">
                      {u.full_name}
                      <span className="sub">{u.username}</span>
                    </span>
                  </span>
                </td>
                <td>
                  <span className={`chip ${toneOf(u.role_code).chip}`}>
                    {t(`role.${u.role_code}`, { defaultValue: u.role_code })}
                  </span>
                  {lockedNow(u) && (
                    <span className="chip-bad ms-2">{t('admin.usersPage.locked')}</span>
                  )}
                </td>
                <td>
                  <span className="flex items-center gap-3">
                    <Toggle
                      on={u.is_active}
                      label={`${t('admin.active')} ${u.username}`}
                      onChange={(on) => toggle.mutate({ id: u.id, on })}
                    />
                    <span className="hidden text-sm text-slate-600 lg:inline">
                      {u.is_active ? t('admin.usersPage.statActive') : t('admin.usersPage.statOff')}
                    </span>
                  </span>
                </td>
                <td className="whitespace-nowrap text-end">
                  {lockedNow(u) && (
                    <button
                      className="btn-danger-quiet me-1 min-h-9 px-3 text-sm"
                      onClick={() => unlock.mutate(u.id)}
                    >
                      {t('admin.usersPage.unlock')}
                    </button>
                  )}
                  <button
                    className="btn-secondary me-1 min-h-9 px-3 text-sm"
                    aria-label={`${t('admin.edit')} ${u.username}`}
                    onClick={() => setEditing(u)}
                  >
                    {t('admin.edit')}
                  </button>
                  <button
                    className="btn-secondary min-h-9 px-3 text-sm"
                    onClick={() => setDialog(u)}
                    aria-label={`${t('admin.usersPage.resetPin')} ${u.username}`}
                  >
                    {t('admin.usersPage.resetPin')}
                  </button>
                </td>
              </tr>
            ))}
            {users.isSuccess && shown.length === 0 && (
              <EmptyRow
                cols={4}
                icon="user"
                text={all.length === 0 ? t('admin.usersPage.empty') : t('admin.usersPage.noMatch')}
              />
            )}
          </tbody>
        </table>
      </div>
      {dialog === 'new' && (
        <NewUserDialog
          roles={roles.data ?? []}
          onClose={() => setDialog(null)}
          onDone={() => void refresh()}
        />
      )}
      {dialog && dialog !== 'new' && (
        <ResetPinDialog user={dialog} onClose={() => setDialog(null)} />
      )}
      {editing && (
        <EditUserDialog
          user={editing}
          roles={roles.data ?? []}
          onClose={() => setEditing(null)}
          onDone={() => void refresh()}
        />
      )}
    </div>
  );
}

/** Name and role of an existing person. (A user is switched off with the toggle, never deleted: their sales stay on record.) */
function EditUserDialog({
  user,
  roles,
  onClose,
  onDone,
}: {
  user: UserRow;
  roles: RoleRow[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [fullName, setFullName] = useState(user.full_name);
  const [roleId, setRoleId] = useState(user.role_id);
  const [error, setError] = useState<unknown>(null);
  const save = useMutation({
    mutationFn: () =>
      api(`/users/${user.id}`, {
        method: 'PATCH',
        body: {
          ...(fullName.trim() !== user.full_name && { fullName: fullName.trim() }),
          ...(roleId !== user.role_id && { roleId }),
        },
      }),
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: setError,
  });
  const changed = fullName.trim() !== user.full_name || roleId !== user.role_id;
  return (
    <Dialog title={`${t('admin.edit')}: ${user.username}`} onClose={onClose}>
      <div className="space-y-3">
        <Field label={t('admin.usersPage.fullName')}>
          <input
            className="input"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            autoFocus
          />
        </Field>
        <Field label={t('admin.usersPage.role')}>
          <select className="input" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>
        <p className="hint">{t('admin.usersPage.editHint')}</p>
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn-primary"
            disabled={save.isPending || !fullName.trim() || !changed}
            onClick={() => save.mutate()}
          >
            {t('admin.save')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function NewUserDialog({
  roles,
  onClose,
  onDone,
}: {
  roles: RoleRow[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
  const [fullName, setFullName] = useState('');
  const [roleId, setRoleId] = useState('');
  const [pin, setPin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const save = useMutation({
    mutationFn: () =>
      api('/users', {
        method: 'POST',
        body: {
          username: username.trim(),
          fullName: fullName.trim(),
          roleId,
          ...(pin ? { pin } : {}),
          ...(password ? { password } : {}),
        },
      }),
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: setError,
  });
  return (
    <Dialog title={t('admin.usersPage.newUser')} onClose={onClose}>
      <div className="space-y-3">
        <Field label={t('admin.usersPage.fullName')}>
          <input
            className="input"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            autoFocus
          />
        </Field>
        <Field label={t('admin.usersPage.username')}>
          <input
            className="input"
            autoCapitalize="none"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        <Field label={t('admin.usersPage.role')}>
          <select className="input" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
            <option value="">—</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('admin.usersPage.pin')}>
          <input
            className="input"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
          />
        </Field>
        <Field label={t('admin.usersPage.password')}>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn-primary"
            disabled={
              save.isPending ||
              !username.trim() ||
              !fullName.trim() ||
              !roleId ||
              (!pin && !password)
            }
            onClick={() => save.mutate()}
          >
            {t('admin.create')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function ResetPinDialog({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const { t } = useTranslation();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<unknown>(null);
  const save = useMutation({
    mutationFn: () => api(`/users/${user.id}/credentials`, { method: 'POST', body: { pin } }),
    onSuccess: onClose,
    onError: setError,
  });
  return (
    <Dialog title={`${t('admin.usersPage.resetPin')}: ${user.full_name}`} onClose={onClose}>
      <div className="space-y-3">
        <Field label={t('admin.usersPage.newPin')}>
          <input
            className="input"
            inputMode="numeric"
            autoFocus
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
          />
        </Field>
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn-primary"
            disabled={save.isPending || pin.length < 4}
            onClick={() => save.mutate()}
          >
            {t('admin.save')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
