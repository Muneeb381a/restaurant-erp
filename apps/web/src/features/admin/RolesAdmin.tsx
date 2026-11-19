import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon, type IconName } from '../../components/Icon';
import { api } from '../../lib/api';
import { can, useMe } from '../../lib/queries';
import type { UserRow } from '../../lib/types';
import { Dialog, ErrorText, Field, PageHead } from './ui';
import { toneOf } from './UsersAdmin';

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

/** A small picture for each group of permissions, so a long list is easy to scan. */
const GROUP_ICON: Record<string, IconName> = {
  order: 'bag',
  bill: 'receipt',
  kitchen: 'flame',
  menu: 'book',
  stock: 'box',
  user: 'user',
  settings: 'sliders',
  report: 'chart',
  shift: 'clock',
  day: 'clock',
  khata: 'book',
  expense: 'cash',
  tax: 'receipt',
  fiscal: 'receipt',
  drawer: 'cash',
  printer: 'printer',
};

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

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
  // how many people hold each role (the same list the Users screen shows)
  const people = useQuery({
    queryKey: ['admin-users'],
    queryFn: async () => (await api<{ items: UserRow[] }>('/users')).items,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Set<string> | null>(null);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const role = roles.data?.find((r) => r.id === selectedId) ?? null;
  const locked = role?.code === 'OWNER';
  const mine = new Set(me.data?.permissions ?? []);
  const total = perms.data?.length ?? 0;
  const holders = (code: string): UserRow[] =>
    (people.data ?? []).filter((u) => u.role_code === code && u.is_active);

  const pick = (r: Role): void => {
    setSelectedId(r.id);
    setDraft(new Set(r.permissions));
    setMessage(null);
  };
  // open on the first role instead of an empty panel
  useEffect(() => {
    if (!selectedId && roles.data?.length) {
      const r = roles.data[0]!;
      setSelectedId(r.id);
      setDraft(new Set(r.permissions));
    }
  }, [roles.data, selectedId]);

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

  const pct = role && draft && total ? Math.round((draft.size / total) * 100) : 0;
  const who = role ? holders(role.code) : [];

  return (
    <div className="max-w-6xl space-y-4 p-4 md:p-6">
      <PageHead title={t('admin.roles')} hint={t('rolesPage.hint')}>
        {can(me.data, 'user.manage') && (
          <button className="btn-primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={18} />
            {t('rolesPage.newRole')}
          </button>
        )}
      </PageHead>

      <div className="grid gap-4 md:grid-cols-[18rem_1fr]">
        <aside className="md:sticky md:top-4 md:self-start">
          <ul className="space-y-2">
            {(roles.data ?? []).map((r) => {
              const on = r.id === selectedId;
              const share = total ? Math.round((r.permissions.length / total) * 100) : 0;
              return (
                <li key={r.id}>
                  <button
                    className={`card flex min-h-touch w-full items-center gap-3 p-3 text-start transition-shadow hover:shadow-md ${on ? 'border-slate-900 ring-2 ring-slate-900/10' : ''}`}
                    aria-pressed={on}
                    onClick={() => pick(r)}
                  >
                    <span
                      aria-hidden="true"
                      className={`flex size-10 shrink-0 items-center justify-center rounded-xl text-base font-bold ${toneOf(r.code).chip}`}
                    >
                      {r.name.charAt(0).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">{r.name}</span>
                      <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-slate-100">
                        <span
                          className={`block h-full rounded-full ${toneOf(r.code).dot}`}
                          style={{ width: `${share}%` }}
                        />
                      </span>
                    </span>
                    <span className="text-end">
                      <span className="money block text-sm font-semibold">
                        {r.permissions.length}/{total}
                      </span>
                      <span className="block text-xs text-slate-500">
                        {t('rolesPage.peopleN', { count: holders(r.code).length })}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
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
              <div className="card sticky top-0 z-10 flex flex-wrap items-center gap-4 p-4">
                <span
                  aria-hidden="true"
                  className={`flex size-14 shrink-0 items-center justify-center rounded-2xl text-2xl font-bold ${toneOf(role.code).chip}`}
                >
                  {role.name.charAt(0).toUpperCase()}
                </span>
                <div className="me-auto min-w-0">
                  <h3 className="truncate text-xl font-semibold">{role.name}</h3>
                  <p className="hint">{t('rolesPage.allowed', { count: draft.size, total })}</p>
                  <div className="mt-2 h-1.5 w-48 max-w-full overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={`h-full rounded-full ${toneOf(role.code).dot}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
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
                {who.length > 0 && (
                  <p className="w-full border-t border-slate-100 pt-3 text-sm text-slate-600">
                    <span className="font-medium text-slate-800">{t('rolesPage.heldBy')}: </span>
                    {who.map((u) => u.full_name).join(', ')}
                  </p>
                )}
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
                    <div className="flex items-center gap-3 border-b border-slate-100 bg-slate-50 px-4 py-2.5">
                      <span className="flex size-8 items-center justify-center rounded-lg bg-white text-slate-600 shadow-sm ring-1 ring-slate-200">
                        <Icon name={GROUP_ICON[group] ?? 'sliders'} size={16} />
                      </span>
                      <span className="me-auto font-semibold">
                        {t(`rolesPage.group.${group}`, { defaultValue: cap(group) })}
                      </span>
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
                    <div className="divide-y divide-slate-100">
                      {list.map((p) => {
                        const on = draft.has(p.code);
                        // you can keep what is already granted, but only add what you hold yourself
                        const cannotAdd = !on && !mine.has(p.code);
                        return (
                          <label
                            key={p.code}
                            className={`flex min-h-touch cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-slate-50 ${cannotAdd ? 'opacity-50' : ''}`}
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
                              <span className={`block ${on ? 'font-medium' : 'text-slate-600'}`}>
                                {p.description}
                              </span>
                              {cannotAdd && (
                                <span className="block text-xs text-slate-600">
                                  {t('rolesPage.cannotGrant')}
                                </span>
                              )}
                            </span>
                            <code className="hidden text-xs text-slate-400 sm:inline" dir="ltr">
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

      {creating && (
        <NewRoleDialog
          onClose={() => setCreating(false)}
          onCreated={async (r) => {
            await qc.invalidateQueries({ queryKey: ['roles'] });
            pick({ ...r, permissions: [] });
          }}
        />
      )}
    </div>
  );
}

function NewRoleDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (r: Role) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api<Role>('/roles', {
        method: 'POST',
        body: { code: code.trim().toUpperCase(), name: name.trim() },
      }),
    onSuccess: async (r) => {
      await onCreated(r);
      onClose();
    },
  });
  return (
    <Dialog title={t('rolesPage.newRole')} onClose={onClose}>
      <div className="space-y-3">
        <Field label={t('rolesPage.name')}>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </Field>
        <Field label={t('rolesPage.code')}>
          <input className="input" value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>
        <p className="hint">{t('rolesPage.codeHint')}</p>
        <ErrorText error={create.error} />
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn-primary"
            disabled={
              !/^[A-Za-z][A-Za-z0-9_]{1,30}$/.test(code.trim()) || !name.trim() || create.isPending
            }
            onClick={() => create.mutate()}
          >
            <Icon name="plus" size={18} />
            {t('rolesPage.create')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
