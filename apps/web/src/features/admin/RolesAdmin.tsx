import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { can, useMe } from '../../lib/queries';
import { ErrorText, Field } from './ui';

interface Role {
  id: string;
  code: string;
  name: string;
  permissions: string[];
}
interface Permission {
  code: string;
  description: string;
}

/** Roles and what each may do. OWNER is fixed; nobody can grant what they do not hold themselves. */
export function RolesAdmin() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  const roles = useQuery({
    queryKey: ['roles'],
    queryFn: async () => (await api<{ items: Role[] }>('/roles')).items,
  });
  const perms = useQuery({
    queryKey: ['permissions'],
    queryFn: async () => (await api<{ items: Permission[] }>('/permissions')).items,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Set<string> | null>(null);
  const [creating, setCreating] = useState({ code: '', name: '' });
  const [message, setMessage] = useState<string | null>(null);

  const role = roles.data?.find((r) => r.id === selectedId) ?? null;
  const locked = role?.code === 'OWNER';
  const mine = new Set(me.data?.permissions ?? []);

  const pick = (r: Role): void => {
    setSelectedId(r.id);
    setDraft(new Set(r.permissions));
    setMessage(null);
  };
  const save = useMutation({
    mutationFn: () =>
      api(`/roles/${role!.id}/permissions`, {
        method: 'PUT',
        body: { permissions: [...(draft ?? [])] },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['roles'] });
      setMessage(t('rolesPage.saved'));
    },
  });
  const create = useMutation({
    mutationFn: () =>
      api<Role>('/roles', {
        method: 'POST',
        body: { code: creating.code.trim().toUpperCase(), name: creating.name.trim() },
      }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['roles'] });
      setCreating({ code: '', name: '' });
      pick({ ...r, permissions: [] });
    },
  });

  const groups = new Map<string, Permission[]>();
  for (const p of perms.data ?? []) {
    const g = p.code.split('.')[0]!;
    groups.set(g, [...(groups.get(g) ?? []), p]);
  }
  const dirty =
    !!role &&
    !!draft &&
    (draft.size !== role.permissions.length || role.permissions.some((p) => !draft.has(p)));

  return (
    <div className="mx-auto grid max-w-5xl gap-4 p-4 md:grid-cols-[16rem_1fr]">
      <aside className="space-y-2">
        <ul className="card divide-y divide-slate-100">
          {(roles.data ?? []).map((r) => (
            <li key={r.id}>
              <button
                className={`flex min-h-touch w-full items-center gap-2 p-3 text-start ${r.id === selectedId ? 'bg-slate-100 font-semibold' : ''}`}
                onClick={() => pick(r)}
              >
                <span className="me-auto">{r.name}</span>
                <span className="text-xs text-slate-500">{r.permissions.length}</span>
              </button>
            </li>
          ))}
        </ul>
        {can(me.data, 'user.manage') && (
          <div className="card space-y-2 p-3">
            <div className="font-semibold">{t('rolesPage.newRole')}</div>
            <Field label={t('rolesPage.code')}>
              <input
                className="input"
                value={creating.code}
                onChange={(e) => setCreating({ ...creating, code: e.target.value })}
              />
            </Field>
            <Field label={t('rolesPage.name')}>
              <input
                className="input"
                value={creating.name}
                onChange={(e) => setCreating({ ...creating, name: e.target.value })}
              />
            </Field>
            <button
              className="btn-secondary w-full"
              disabled={
                !/^[A-Za-z][A-Za-z0-9_]{1,30}$/.test(creating.code.trim()) ||
                !creating.name.trim() ||
                create.isPending
              }
              onClick={() => create.mutate()}
            >
              {t('rolesPage.create')}
            </button>
            <ErrorText error={create.error} />
          </div>
        )}
      </aside>

      <section className="space-y-3">
        {!role || !draft ? (
          <p className="text-slate-500">{t('rolesPage.pick')}</p>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <h2 className="me-auto text-xl font-bold">{role.name}</h2>
              {locked && (
                <span className="rounded bg-slate-200 px-2 text-sm">{t('rolesPage.locked')}</span>
              )}
              <button
                className="btn-primary"
                disabled={locked || !dirty || save.isPending}
                onClick={() => save.mutate()}
              >
                {t('admin.save')}
              </button>
            </div>
            {message && (
              <p role="status" className="rounded-lg bg-emerald-50 p-2 text-emerald-900">
                {message}
              </p>
            )}
            <ErrorText error={save.error} />
            {[...groups.entries()].map(([group, list]) => (
              <div key={group} className="card space-y-1 p-3">
                <div className="text-sm font-semibold uppercase text-slate-500">{group}</div>
                {list.map((p) => {
                  const on = draft.has(p.code);
                  // you can keep what is already granted, but only add what you hold yourself
                  const cannotAdd = !on && !mine.has(p.code);
                  return (
                    <label
                      key={p.code}
                      className={`flex min-h-touch items-center gap-3 ${cannotAdd ? 'opacity-50' : ''}`}
                    >
                      <input
                        type="checkbox"
                        className="size-5"
                        checked={on}
                        disabled={locked || cannotAdd}
                        aria-label={p.code}
                        onChange={(e) => {
                          const next = new Set(draft);
                          if (e.target.checked) next.add(p.code);
                          else next.delete(p.code);
                          setDraft(next);
                        }}
                      />
                      <span className="me-auto">{p.description}</span>
                      <code className="text-xs text-slate-500">{p.code}</code>
                    </label>
                  );
                })}
              </div>
            ))}
          </>
        )}
      </section>
    </div>
  );
}
