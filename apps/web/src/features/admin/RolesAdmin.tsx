import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { api } from '../../lib/api';
import { can, useMe } from '../../lib/queries';
import { ErrorText, Field, PageHead } from './ui';

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
  const [search, setSearch] = useState('');

  const role = roles.data?.find((r) => r.id === selectedId) ?? null;
  const locked = role?.code === 'OWNER';
  const mine = new Set(me.data?.permissions ?? []);
  const total = perms.data?.length ?? 0;

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

  const q = search.trim().toLowerCase();
  const groups = new Map<string, Permission[]>();
  for (const p of perms.data ?? []) {
    if (q && !`${p.code} ${p.description}`.toLowerCase().includes(q)) continue;
    const g = p.code.split('.')[0]!;
    groups.set(g, [...(groups.get(g) ?? []), p]);
  }
  const dirty =
    !!role &&
    !!draft &&
    (draft.size !== role.permissions.length || role.permissions.some((p) => !draft.has(p)));

  /** the codes in a group this person may switch on (they cannot grant what they do not hold) */
  const settable = (list: Permission[]): string[] =>
    list.filter((p) => mine.has(p.code) || draft?.has(p.code)).map((p) => p.code);

  return (
    <div className="max-w-6xl space-y-4 p-4 md:p-6">
      <PageHead title={t('admin.roles')} hint={t('rolesPage.hint')} />
      <div className="grid gap-4 md:grid-cols-[17rem_1fr]">
        <aside className="space-y-3 md:sticky md:top-4 md:self-start">
          <ul className="card divide-y divide-slate-200 overflow-hidden">
            {(roles.data ?? []).map((r) => (
              <li key={r.id}>
                <button
                  className={`flex min-h-touch w-full items-center gap-3 border-s-4 px-3 py-2 text-start transition-colors hover:bg-slate-50 ${r.id === selectedId ? 'border-emerald-600 bg-slate-100' : 'border-transparent'}`}
                  aria-pressed={r.id === selectedId}
                  onClick={() => pick(r)}
                >
                  <span className="me-auto min-w-0">
                    <span
                      className={`block truncate ${r.id === selectedId ? 'font-semibold' : 'font-medium'}`}
                    >
                      {r.name}
                    </span>
                    <span className="block h-1 w-20 overflow-hidden rounded-full bg-slate-200">
                      <span
                        className="block h-full rounded-full bg-emerald-600"
                        style={{
                          width: `${total ? Math.round((r.permissions.length / total) * 100) : 0}%`,
                        }}
                      />
                    </span>
                  </span>
                  <span className="money text-xs text-slate-600">
                    {r.permissions.length}/{total}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {can(me.data, 'user.manage') && (
            <div className="panel space-y-2 p-3">
              <div className="micro">{t('rolesPage.newRole')}</div>
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
                <Icon name="plus" size={18} />
                {t('rolesPage.create')}
              </button>
              <ErrorText error={create.error} />
            </div>
          )}
        </aside>

        <section className="min-w-0 space-y-3">
          {!role || !draft ? (
            <div className="card flex flex-col items-center gap-3 p-10 text-center text-slate-600">
              <span className="flex size-12 items-center justify-center rounded-full bg-slate-100 text-slate-500">
                <Icon name="user" size={24} />
              </span>
              <p>{t('rolesPage.pick')}</p>
            </div>
          ) : (
            <>
              <div className="card sticky top-0 z-10 flex flex-wrap items-center gap-3 p-3">
                <div className="me-auto min-w-0">
                  <h3 className="truncate text-lg font-semibold">{role.name}</h3>
                  <p className="hint">{t('rolesPage.allowed', { count: draft.size, total })}</p>
                </div>
                {locked && <span className="chip-mute">{t('rolesPage.locked')}</span>}
                {dirty && !locked && <span className="chip-warn">{t('rolesPage.unsaved')}</span>}
                <button
                  className="btn-primary"
                  disabled={locked || !dirty || save.isPending}
                  onClick={() => save.mutate()}
                >
                  {t('admin.save')}
                </button>
              </div>
              <div className="relative max-w-sm">
                <Icon
                  name="search"
                  size={18}
                  className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-slate-500"
                />
                <input
                  className="input ps-10"
                  placeholder={t('common.search')}
                  aria-label={t('common.search')}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              {message && (
                <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">
                  {message}
                </p>
              )}
              <ErrorText error={save.error} />
              {[...groups.entries()].map(([group, list]) => {
                const onCount = list.filter((p) => draft.has(p.code)).length;
                const allOn = onCount === list.length;
                return (
                  <div key={group} className="card overflow-hidden">
                    <div className="flex items-center gap-3 border-b border-slate-200 bg-slate-100 px-4 py-2">
                      <span className="micro me-auto">{group}</span>
                      <span className="money text-xs text-slate-600">
                        {onCount}/{list.length}
                      </span>
                      {!locked && (
                        <button
                          className="btn-quiet min-h-9 px-2 text-xs"
                          onClick={() => {
                            const next = new Set(draft);
                            for (const c of settable(list)) {
                              if (allOn) next.delete(c);
                              else next.add(c);
                            }
                            setDraft(next);
                          }}
                        >
                          {allOn ? t('rolesPage.none') : t('rolesPage.all')}
                        </button>
                      )}
                    </div>
                    <div className="divide-y divide-slate-200">
                      {list.map((p) => {
                        const on = draft.has(p.code);
                        // you can keep what is already granted, but only add what you hold yourself
                        const cannotAdd = !on && !mine.has(p.code);
                        return (
                          <label
                            key={p.code}
                            className={`flex min-h-touch cursor-pointer items-center gap-3 px-4 py-2 hover:bg-slate-50 ${cannotAdd ? 'opacity-50' : ''}`}
                          >
                            <input
                              type="checkbox"
                              className="size-5 accent-emerald-700"
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
                            <span className="me-auto min-w-0">
                              <span className="block">{p.description}</span>
                              {cannotAdd && (
                                <span className="block text-xs text-slate-600">
                                  {t('rolesPage.cannotGrant')}
                                </span>
                              )}
                            </span>
                            <code className="text-xs text-slate-500" dir="ltr">
                              {p.code}
                            </code>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
              {groups.size === 0 && <p className="hint px-1">{t('rolesPage.noMatch')}</p>}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
