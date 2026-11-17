import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import type { AdminMenu } from '../../lib/types';
import { ConfirmDelete, Dialog, ErrorText, Field } from './ui';

type Tab = 'categories' | 'stations';

interface Row {
  id: string;
  title: string;
  sub: string;
  nameUr: string | null;
  code?: string;
  dishes: number;
}

/**
 * Where the menu is organised: the categories that group dishes and the stations (kitchen sections)
 * that cook them. Until now these could only come from a CSV import, so a new restaurant had nothing
 * to choose from when it added its first dish.
 */
export function MenuSetupDialog({
  data,
  tab: first,
  onClose,
  onDone,
}: {
  data: AdminMenu;
  tab: Tab;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>(first);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Row | null>(null);

  const rows: Row[] =
    tab === 'categories'
      ? data.categories.map((c) => ({
          id: c.id,
          title: c.name,
          sub: '',
          nameUr: c.nameUr,
          dishes: data.items.filter((i) => i.categoryId === c.id).length,
        }))
      : data.stations.map((s) => ({
          id: s.id,
          title: s.name,
          sub: s.code,
          nameUr: null,
          code: s.code,
          dishes: data.items.filter((i) => i.stationId === s.id).length,
        }));
  const path = tab === 'categories' ? '/categories' : '/stations';

  return (
    <Dialog title={t('admin.menuPage.setupTitle')} onClose={onClose} wide>
      <div className="space-y-3">
        <div role="tablist" className="flex gap-1 rounded-lg bg-slate-100 p-1">
          {(['categories', 'stations'] as const).map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              className={`flex-1 rounded-md px-3 py-2 text-sm font-semibold ${tab === k ? 'bg-white shadow-sm' : 'text-slate-600'}`}
              onClick={() => {
                setTab(k);
                setEditing(null);
              }}
            >
              {t(`admin.menuPage.${k}`)}
            </button>
          ))}
        </div>
        <p className="hint">{t(`admin.menuPage.${tab}Hint`)}</p>

        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-300">
          {rows.length === 0 && editing !== 'new' && (
            <li className="p-4 text-center text-slate-600">{t(`admin.menuPage.${tab}Empty`)}</li>
          )}
          {rows.map((r) =>
            editing === r.id ? (
              <li key={r.id} className="p-3">
                <RowForm
                  tab={tab}
                  row={r}
                  path={path}
                  onCancel={() => setEditing(null)}
                  onDone={() => {
                    setEditing(null);
                    onDone();
                  }}
                />
              </li>
            ) : (
              <li key={r.id} className="flex flex-wrap items-center gap-2 p-3">
                <div className="me-auto min-w-0">
                  <div className="truncate font-semibold">
                    {r.title}
                    {r.nameUr && (
                      <span className="ms-2 font-normal text-slate-500">{r.nameUr}</span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500">
                    {r.sub && <span className="me-2 font-mono">{r.sub}</span>}
                    {t('admin.menuPage.dishesN', { count: r.dishes })}
                  </div>
                </div>
                <button
                  className="btn-secondary"
                  aria-label={`${t('admin.edit')} ${r.title}`}
                  onClick={() => setEditing(r.id)}
                >
                  {t('admin.edit')}
                </button>
                <button
                  className="btn-danger-quiet"
                  aria-label={`${t('admin.delete')} ${r.title}`}
                  onClick={() => setDeleting(r)}
                >
                  {t('admin.delete')}
                </button>
              </li>
            ),
          )}
          {editing === 'new' && (
            <li className="bg-slate-50 p-3">
              <RowForm
                tab={tab}
                row={null}
                path={path}
                onCancel={() => setEditing(null)}
                onDone={() => {
                  setEditing(null);
                  onDone();
                }}
              />
            </li>
          )}
        </ul>

        <div className="flex justify-between gap-2">
          <button
            className="btn-primary"
            disabled={editing === 'new'}
            onClick={() => setEditing('new')}
          >
            {t(tab === 'categories' ? 'admin.menuPage.newCategory' : 'admin.menuPage.newStation')}
          </button>
          <button className="btn-secondary" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
      {deleting && (
        <ConfirmDelete
          name={deleting.title}
          run={() => api(`${path}/${deleting.id}`, { method: 'DELETE' })}
          onDone={onDone}
          onClose={() => setDeleting(null)}
        />
      )}
    </Dialog>
  );
}

/** Name (and Urdu name) for a category; code and name for a station. */
function RowForm({
  tab,
  row,
  path,
  onCancel,
  onDone,
}: {
  tab: Tab;
  row: Row | null;
  path: string;
  onCancel: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(row?.title ?? '');
  const [nameUr, setNameUr] = useState(row?.nameUr ?? '');
  const [code, setCode] = useState(row?.code ?? '');
  const [error, setError] = useState<unknown>(null);
  const save = useMutation({
    mutationFn: () => {
      const body =
        tab === 'categories'
          ? { name: name.trim(), nameUr: nameUr.trim() || null }
          : { name: name.trim(), code: (code.trim() || name.trim()).toUpperCase().slice(0, 40) };
      return row
        ? api(`${path}/${row.id}`, { method: 'PATCH', body })
        : api(path, { method: 'POST', body });
    },
    onSuccess: onDone,
    onError: setError,
  });
  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label={t('admin.name')}>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </Field>
        {tab === 'categories' ? (
          <Field label={t('admin.menuPage.nameUr')}>
            <input
              className="input"
              dir="rtl"
              value={nameUr}
              onChange={(e) => setNameUr(e.target.value)}
            />
          </Field>
        ) : (
          <Field label={t('admin.code')}>
            <input
              className="input"
              value={code}
              placeholder={name.trim().toUpperCase()}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
        )}
      </div>
      <ErrorText error={error} />
      <div className="flex justify-end gap-2">
        <button className="btn-secondary" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button
          className="btn-primary"
          disabled={save.isPending || !name.trim()}
          onClick={() => save.mutate()}
        >
          {row ? t('admin.save') : t('admin.create')}
        </button>
      </div>
    </div>
  );
}
