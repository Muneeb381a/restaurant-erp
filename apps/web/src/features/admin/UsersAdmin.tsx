import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import type { RoleRow, UserRow } from '../../lib/types';
import { Dialog, ErrorText, Field, Toggle, td, th } from './ui';

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
  const [error, setError] = useState<unknown>(null);
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

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-2">
        <h2 className="me-auto text-xl font-bold">{t('admin.users')}</h2>
        <button className="btn-primary" onClick={() => setDialog('new')}>
          + {t('admin.usersPage.newUser')}
        </button>
      </div>
      <ErrorText error={error} />
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[40rem] text-sm">
          <thead className="border-b border-slate-200 bg-slate-50">
            <tr>
              <th className={th}>{t('admin.usersPage.fullName')}</th>
              <th className={th}>{t('admin.usersPage.username')}</th>
              <th className={th}>{t('admin.usersPage.role')}</th>
              <th className={th}>{t('admin.active')}</th>
              <th className={th} />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {(users.data ?? []).map((u) => (
              <tr key={u.id} className={u.is_active ? '' : 'text-slate-400'}>
                <td className={`${td} font-medium`}>{u.full_name}</td>
                <td className={td}>{u.username}</td>
                <td className={td}>{u.role_code}</td>
                <td className={td}>
                  <Toggle
                    on={u.is_active}
                    label={`${t('admin.active')} ${u.username}`}
                    onChange={(on) => toggle.mutate({ id: u.id, on })}
                  />
                </td>
                <td className={`${td} whitespace-nowrap`}>
                  {lockedNow(u) && (
                    <button
                      className="btn-secondary me-1 text-rose-700"
                      onClick={() => unlock.mutate(u.id)}
                    >
                      {t('admin.usersPage.locked')} · {t('admin.usersPage.unlock')}
                    </button>
                  )}
                  <button
                    className="btn-secondary"
                    onClick={() => setDialog(u)}
                    aria-label={`${t('admin.usersPage.resetPin')} ${u.username}`}
                  >
                    {t('admin.usersPage.resetPin')}
                  </button>
                </td>
              </tr>
            ))}
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
    </div>
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
