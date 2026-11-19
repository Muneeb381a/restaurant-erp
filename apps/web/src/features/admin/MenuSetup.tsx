import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { categoryTree, parentChoices } from '../../lib/categories';
import type { AdminMenu } from '../../lib/types';
import { ConfirmDelete, Dialog, ErrorText, Field, Toggle } from './ui';

type Tab = 'categories' | 'stations';

interface Row {
  id: string;
  title: string;
  sub: string;
  nameUr: string | null;
  code?: string;
  dishes: number;
  /** categories only: 0 = main, 1 = sub-category */
  depth?: number;
  parentId?: string | null;
  hasChildren?: boolean;
  isActive?: boolean;
  /** dishes in the sub-categories below (a main category shows both numbers) */
  subDishes?: number;
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
  // "Add sub-category" on a main category opens the new form already inside it
  const [newParent, setNewParent] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Row | null>(null);

  const rows: Row[] =
    tab === 'categories'
      ? categoryTree(data.categories).map(({ cat: c, depth }) => {
          const below = data.categories.filter((x) => x.parentId === c.id);
          return {
            id: c.id,
            title: c.name,
            sub: '',
            nameUr: c.nameUr,
            dishes: data.items.filter((i) => i.categoryId === c.id).length,
            depth,
            parentId: c.parentId,
            hasChildren: below.length > 0,
            isActive: c.isActive,
            subDishes: data.items.filter((i) => below.some((b) => b.id === i.categoryId)).length,
          };
        })
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
                  data={data}
                  parentFor={null}
                  path={path}
                  onCancel={() => setEditing(null)}
                  onDone={() => {
                    setEditing(null);
                    onDone();
                  }}
                />
              </li>
            ) : (
              <li
                key={r.id}
                className={`flex flex-wrap items-center gap-2 p-3 ${r.depth ? 'bg-slate-50 ps-10' : ''}`}
              >
                <div className="me-auto min-w-0">
                  <div className="truncate font-semibold">
                    {r.depth ? <span className="me-1.5 text-slate-400">↳</span> : null}
                    {r.title}
                    {r.isActive === false && (
                      <span className="chip-mute ms-2">{t('admin.menuPage.off')}</span>
                    )}
                    {r.nameUr && (
                      <span className="ms-2 font-normal text-slate-500">{r.nameUr}</span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500">
                    {r.sub && <span className="me-2 font-mono">{r.sub}</span>}
                    {t('admin.menuPage.dishesN', { count: r.dishes })}
                    {r.hasChildren && (r.subDishes ?? 0) > 0 && (
                      <span> · {t('admin.menuPage.inSubN', { count: r.subDishes })}</span>
                    )}
                  </div>
                </div>
                {tab === 'categories' && !r.depth && (
                  <button
                    className="btn-quiet text-sm"
                    aria-label={`${t('admin.menuPage.addSub')} ${r.title}`}
                    onClick={() => {
                      setNewParent(r.id);
                      setEditing('new');
                    }}
                  >
                    + {t('admin.menuPage.subCategory')}
                  </button>
                )}
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
                data={data}
                parentFor={newParent}
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
            onClick={() => {
              setNewParent(null);
              setEditing('new');
            }}
          >
            {t(tab === 'categories' ? 'admin.menuPage.newCategory' : 'admin.menuPage.newStation')}
          </button>
          <button className="btn-secondary" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
      {deleting && tab === 'categories' && (
        <DeleteCategoryDialog
          row={deleting}
          data={data}
          onDone={onDone}
          onClose={() => setDeleting(null)}
        />
      )}
      {deleting && tab !== 'categories' && (
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
  data,
  parentFor,
  path,
  onCancel,
  onDone,
}: {
  tab: Tab;
  row: Row | null;
  data: AdminMenu;
  /** a new category created from "Add sub-category" starts inside this one */
  parentFor: string | null;
  path: string;
  onCancel: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(row?.title ?? '');
  const [nameUr, setNameUr] = useState(row?.nameUr ?? '');
  const [code, setCode] = useState(row?.code ?? '');
  const [active, setActive] = useState(row?.isActive ?? true);
  const [parentId, setParentId] = useState<string>(row ? (row.parentId ?? '') : (parentFor ?? ''));
  const choices = parentChoices(data.categories, row?.id ?? null);
  const [error, setError] = useState<unknown>(null);
  const save = useMutation({
    mutationFn: () => {
      const body =
        tab === 'categories'
          ? {
              name: name.trim(),
              nameUr: nameUr.trim() || null,
              parentId: parentId || null,
              ...(row ? { isActive: active } : {}),
            }
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
      {tab === 'categories' && (
        <Field label={t('admin.menuPage.insideCategory')}>
          <select
            className="input"
            value={parentId}
            disabled={row?.hasChildren}
            onChange={(e) => setParentId(e.target.value)}
          >
            <option value="">{t('admin.menuPage.mainCategory')}</option>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {row?.hasChildren && <p className="hint mt-1">{t('admin.menuPage.hasSubHint')}</p>}
        </Field>
      )}
      {tab === 'categories' && row && (
        <label className="flex items-center gap-3">
          <Toggle on={active} label={t('admin.active')} onChange={setActive} />
          <span>
            {t('admin.active')}
            <span className="hint block">{t('admin.menuPage.activeCategoryHint')}</span>
          </span>
        </label>
      )}
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

/**
 * Delete a category. An empty one is simply deleted. If it still has dishes, they have to go somewhere
 * (another category, or none), and its sub-categories become main categories: the server does all of it
 * in one step, so nothing is left half done.
 */
function DeleteCategoryDialog({
  row,
  data,
  onDone,
  onClose,
}: {
  row: Row;
  data: AdminMenu;
  onDone: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const subs = data.categories.filter((c) => c.parentId === row.id).length;
  const needsMove = row.dishes > 0 || subs > 0;
  const [target, setTarget] = useState('none');
  const [error, setError] = useState<unknown>(null);
  const del = useMutation({
    mutationFn: () =>
      api(`/categories/${row.id}${needsMove ? `?moveItemsTo=${target}` : ''}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: setError,
  });
  const choices = categoryTree(data.categories).filter((n) => n.cat.id !== row.id);
  return (
    <Dialog title={t('admin.deleteTitle', { name: row.title })} onClose={onClose}>
      <div className="space-y-3">
        {!needsMove && <p className="text-slate-700">{t('admin.deleteBody')}</p>}
        {row.dishes > 0 && (
          <>
            <p className="text-slate-700">
              {t('admin.menuPage.moveDishes', { count: row.dishes })}
            </p>
            <Field label={t('admin.menuPage.moveTo')}>
              <select className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="none">{t('admin.menuPage.noCategory')}</option>
                {choices.map((n) => (
                  <option key={n.cat.id} value={n.cat.id}>
                    {n.path}
                  </option>
                ))}
              </select>
            </Field>
          </>
        )}
        {subs > 0 && (
          <p className="rounded-lg bg-amber-50 p-2 text-sm text-amber-900">
            {t('admin.menuPage.subsBecomeMain', { count: subs })}
          </p>
        )}
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn-danger" disabled={del.isPending} onClick={() => del.mutate()}>
            {needsMove ? t('admin.menuPage.moveAndDelete') : t('admin.delete')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
