import { asPaisa, formatPaisa, parseRupees } from '@erp/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { localName } from '../../i18n';
import { api } from '../../lib/api';
import { categoryTree, topOf, withDescendants } from '../../lib/categories';
import type { AdminItem, AdminMenu, AdminVariant, ImportResult } from '../../lib/types';
import { DealEditor } from './DealEditor';
import { Icon } from '../../components/Icon';
import { ItemPhoto } from '../../components/ItemPhoto';
import { emptyGuestInfo, GuestInfoFields, guestPayload, type GuestInfo } from './GuestInfo';
import { ConfirmDelete, Dialog, EmptyRow, ErrorText, Field, PageHead, Toggle } from './ui';

const ADMIN_MENU_KEY = ['admin-menu'];
const CHANNEL_ORDER = ['DINE_IN', 'TAKEAWAY', 'DELIVERY'];
const sortLists = <T extends { code: string }>(lists: T[]): T[] =>
  [...lists].sort(
    (a, b) => channelRank(a.code) - channelRank(b.code) || a.code.localeCompare(b.code),
  );
const channelRank = (code: string): number => {
  const i = CHANNEL_ORDER.indexOf(code);
  return i === -1 ? CHANNEL_ORDER.length : i;
};

import { MenuSetupDialog } from './MenuSetup';

export function MenuAdmin() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const qc = useQueryClient();
  const menu = useQuery({ queryKey: ADMIN_MENU_KEY, queryFn: () => api<AdminMenu>('/menu/admin') });
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState<'ALL' | 'SOLD_OUT' | 'HIDDEN' | 'OFF'>('ALL');
  const [editing, setEditing] = useState<AdminItem | 'new' | null>(null);
  const [addingVariantTo, setAddingVariantTo] = useState<AdminItem | null>(null);
  const [editingDeal, setEditingDeal] = useState<AdminItem | null>(null);
  const [importing, setImporting] = useState(false);
  const [setup, setSetup] = useState<'categories' | 'stations' | null>(null);
  const [deletingItem, setDeletingItem] = useState<AdminItem | null>(null);
  const [editingVariant, setEditingVariant] = useState<{
    item: AdminItem;
    variant: AdminItem['variants'][number];
  } | null>(null);
  const [deletingVariant, setDeletingVariant] = useState<{
    item: AdminItem;
    variant: AdminItem['variants'][number];
  } | null>(null);
  const [error, setError] = useState<unknown>(null);

  const refresh = (): Promise<unknown> =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ADMIN_MENU_KEY }),
      qc.invalidateQueries({ queryKey: ['menu'] }),
    ]);

  const patchItem = useMutation({
    mutationFn: (v: { id: string; body: Record<string, unknown> }) =>
      api(`/items/${v.id}`, { method: 'PATCH', body: v.body }),
    onSuccess: refresh,
    onError: setError,
  });
  const setAvailability = useMutation({
    mutationFn: (v: { id: string; isAvailable: boolean }) =>
      api(`/items/${v.id}/availability`, { method: 'PATCH', body: { isAvailable: v.isAvailable } }),
    onSuccess: refresh,
    onError: setError,
  });

  const hasVariantCol = (menu.data?.items ?? []).some(
    (i) => !(i.kind === 'STANDARD' && i.variants.length === 1),
  );
  const items = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (menu.data?.items ?? []).filter(
      (i) =>
        (!category ||
          (menu.data !== undefined &&
            withDescendants(menu.data.categories, category).has(i.categoryId ?? ''))) &&
        (status === 'ALL' ||
          (status === 'SOLD_OUT' && i.isActive && !i.isAvailable) ||
          (status === 'HIDDEN' && i.hiddenFromGuests) ||
          (status === 'OFF' && !i.isActive)) &&
        (!q || [i.name, i.nameUr, i.code, i.searchTerms].some((s) => s?.toLowerCase().includes(q))),
    );
  }, [menu.data, search, category, status]);

  if (menu.isPending) return <p className="p-4">{t('common.loading')}</p>;
  if (menu.isError || !menu.data) return <ErrorText error={menu.error} />;
  const data = menu.data;
  // channels in the order a restaurant thinks of them: dine-in first
  const lists = sortLists(data.priceLists);
  const tree = categoryTree(data.categories, (c) => localName(lang, c.name, c.nameUr));
  const categoryName = (id: string | null): string => tree.find((n) => n.cat.id === id)?.path ?? '';
  const all = data.items;
  const soldOut = all.filter((i) => i.isActive && !i.isAvailable).length;
  const hidden = all.filter((i) => i.hiddenFromGuests).length;
  const off = all.filter((i) => !i.isActive).length;
  const stats = [
    {
      key: 'ALL' as const,
      n: all.length,
      label: t('admin.menuPage.statItems'),
      icon: 'book' as const,
      tone: 'bg-slate-100 text-slate-700',
    },
    {
      key: 'SOLD_OUT' as const,
      n: soldOut,
      label: t('admin.menuPage.statSoldOut'),
      icon: 'alert' as const,
      tone: 'bg-amber-100 text-amber-800',
    },
    {
      key: 'HIDDEN' as const,
      n: hidden,
      label: t('admin.menuPage.statHidden'),
      icon: 'bellOff' as const,
      tone: 'bg-sky-100 text-sky-700',
    },
    {
      key: 'OFF' as const,
      n: off,
      label: t('admin.menuPage.statOff'),
      icon: 'pause' as const,
      tone: 'bg-rose-100 text-rose-700',
    },
  ];
  // main categories as chips; the sub-categories of the one in use appear on a second row
  const mainCats = data.categories.filter(
    (c) => !c.parentId || !data.categories.some((x) => x.id === c.parentId),
  );
  const activeTop = category ? topOf(data.categories, category) : null;
  const subCats = data.categories.filter((c) => activeTop !== null && c.parentId === activeTop);
  const countIn = (id: string): number => {
    const ids = withDescendants(data.categories, id);
    return all.filter((i) => ids.has(i.categoryId ?? '')).length;
  };
  const stationCode = (id: string | null): string =>
    data.stations.find((s) => s.id === id)?.code ?? '';

  async function exportCsv(): Promise<void> {
    const csv = await api<string>('/menu/export.csv', { responseType: 'text' });
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'menu.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-3 p-4 md:p-6">
      <PageHead title={t('admin.menu')} hint={t('admin.menuPage.priceHint')}>
        <button className="btn-secondary" onClick={() => setSetup('categories')}>
          {t('admin.menuPage.categories')}
        </button>
        <button className="btn-secondary" onClick={() => setSetup('stations')}>
          {t('admin.menuPage.stations')}
        </button>
        <button className="btn-secondary" onClick={() => void exportCsv()}>
          {t('admin.menuPage.export')}
        </button>
        <button className="btn-secondary" onClick={() => setImporting(true)}>
          {t('admin.menuPage.import')}
        </button>
        <button className="btn-primary" onClick={() => setEditing('new')}>
          <Icon name="plus" size={18} />
          {t('admin.menuPage.newItem')}
        </button>
      </PageHead>
      <div
        className="grid grid-cols-2 gap-3 sm:grid-cols-4"
        role="group"
        aria-label={t('admin.menuPage.statsLabel')}
      >
        {stats.map((x) => (
          <button
            key={x.key}
            aria-pressed={status === x.key}
            onClick={() => setStatus(x.key)}
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
        <div className="relative w-full max-w-sm">
          <Icon
            name="search"
            size={18}
            className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-slate-500"
          />
          <input
            className="input ps-10"
            placeholder={t('admin.search')}
            aria-label={t('admin.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <span className="chip-mute ms-auto">
          {t('admin.menuPage.countN', { count: items.length })}
        </span>
      </div>
      <div
        className="flex gap-1.5 overflow-x-auto pb-1"
        role="group"
        aria-label={t('admin.category')}
      >
        <button
          className="seg-item shrink-0 whitespace-nowrap border border-slate-200 bg-white"
          aria-pressed={category === ''}
          onClick={() => setCategory('')}
        >
          {t('admin.all')} <span className="money ms-1.5 opacity-60">{all.length}</span>
        </button>
        {mainCats.map((c) => (
          <button
            key={c.id}
            className="seg-item shrink-0 whitespace-nowrap border border-slate-200 bg-white"
            aria-pressed={activeTop === c.id}
            onClick={() => setCategory(c.id)}
          >
            {localName(lang, c.name, c.nameUr)}
            <span className="money ms-1.5 opacity-60">{countIn(c.id)}</span>
          </button>
        ))}
      </div>
      {subCats.length > 0 && (
        <div
          className="flex gap-1.5 overflow-x-auto pb-1 ps-3"
          role="group"
          aria-label={t('admin.menuPage.subCategory')}
        >
          <button
            className="seg-item shrink-0 whitespace-nowrap border border-slate-200 bg-white text-sm"
            aria-pressed={category === activeTop}
            onClick={() => setCategory(activeTop ?? '')}
          >
            {t('admin.menuPage.allIn', {
              name: localName(
                lang,
                data.categories.find((c) => c.id === activeTop)?.name ?? '',
                data.categories.find((c) => c.id === activeTop)?.nameUr ?? null,
              ),
            })}
            <span className="money ms-1.5 opacity-60">{countIn(activeTop ?? '')}</span>
          </button>
          {subCats.map((c) => (
            <button
              key={c.id}
              className="seg-item shrink-0 whitespace-nowrap border border-slate-200 bg-white text-sm"
              aria-pressed={category === c.id}
              onClick={() => setCategory(c.id)}
            >
              {localName(lang, c.name, c.nameUr)}
              <span className="money ms-1.5 opacity-60">{countIn(c.id)}</span>
            </button>
          ))}
        </div>
      )}
      <ErrorText error={error} />

      <div className="dt dt-tight">
        <table className="min-w-[44rem]">
          <thead>
            <tr>
              <th className="min-w-[11rem]">{t('admin.name')}</th>
              <th>{`${t('admin.category')} · ${t('admin.station')}`}</th>
              {hasVariantCol && <th>{t('admin.menuPage.variant')}</th>}
              {lists.map((l) => (
                <th key={l.id} className="num">
                  {t(`admin.menuPage.list.${l.code}`, { defaultValue: l.code })}
                </th>
              ))}
              <th>{t('admin.menuPage.available')}</th>
              <th>{t('admin.active')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <EmptyRow
                cols={6 + (hasVariantCol ? 1 : 0) + data.priceLists.length}
                icon="search"
                text={t('admin.menuPage.noItems')}
              />
            )}
            {items.map((item) =>
              item.variants.map((v, idx) => (
                <tr key={v.id} className={item.isActive ? '' : 'opacity-55'}>
                  {idx === 0 ? (
                    <>
                      <td rowSpan={item.variants.length}>
                        <div className="flex items-center gap-3">
                          {item.hasImage ? (
                            <ItemPhoto
                              itemId={item.id}
                              version={1}
                              className="size-11 shrink-0 rounded-lg"
                            />
                          ) : (
                            <span
                              aria-hidden="true"
                              className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-base font-semibold text-slate-500"
                            >
                              {(item.name[0] ?? '?').toUpperCase()}
                            </span>
                          )}
                          <span className="name">
                            {localName(lang, item.name, item.nameUr)}
                            <span className="sub">
                              {item.code}
                              {item.kind !== 'STANDARD' ? ` · ${item.kind}` : ''}
                            </span>
                            {item.hiddenFromGuests && (
                              <span className="chip-mute mt-1">{t('guest.hiddenChip')}</span>
                            )}
                          </span>
                        </div>
                      </td>
                      <td rowSpan={item.variants.length}>
                        <div className="flex flex-col items-start gap-1">
                          {categoryName(item.categoryId) ? (
                            <span className="chip bg-slate-100 text-slate-700">
                              {categoryName(item.categoryId)}
                            </span>
                          ) : (
                            <span className="text-slate-400">–</span>
                          )}
                          {stationCode(item.stationId) && (
                            <span className="inline-flex items-center gap-1 text-xs text-slate-500">
                              <Icon name="flame" size={12} />
                              {stationCode(item.stationId)}
                            </span>
                          )}
                        </div>
                      </td>
                    </>
                  ) : null}
                  {hasVariantCol && (
                    <td>
                      {item.kind === 'STANDARD' && item.variants.length === 1 ? (
                        ''
                      ) : (
                        <span className="inline-flex items-center gap-1">
                          {localName(lang, v.name, v.nameUr)}
                          {item.kind === 'STANDARD' && (
                            <>
                              <button
                                className="btn-quiet px-1.5 text-xs"
                                aria-label={`${t('admin.edit')} ${v.name}`}
                                onClick={() => setEditingVariant({ item, variant: v })}
                              >
                                {t('admin.edit')}
                              </button>
                            </>
                          )}
                        </span>
                      )}
                    </td>
                  )}
                  {lists.map((l) => (
                    <td key={l.id} className="num">
                      <PriceCell
                        variant={v}
                        listId={l.id}
                        listCode={l.code}
                        onSaved={refresh}
                        onError={setError}
                      />
                    </td>
                  ))}
                  {idx === 0 ? (
                    <>
                      <td rowSpan={item.variants.length}>
                        <Toggle
                          on={item.isAvailable}
                          label={`${t('admin.menuPage.available')} ${item.name}`}
                          onChange={(v2) =>
                            setAvailability.mutate({ id: item.id, isAvailable: v2 })
                          }
                        />
                      </td>
                      <td rowSpan={item.variants.length}>
                        <Toggle
                          on={item.isActive}
                          label={`${t('admin.active')} ${item.name}`}
                          onChange={(v2) =>
                            patchItem.mutate({ id: item.id, body: { isActive: v2 } })
                          }
                        />
                      </td>
                      <td
                        className="sticky end-0 whitespace-nowrap bg-white text-end shadow-[-8px_0_8px_-8px_rgba(30,27,22,.15)]"
                        rowSpan={item.variants.length}
                      >
                        <button
                          className="btn-secondary me-1 min-h-9 px-3 text-sm"
                          onClick={() => setEditing(item)}
                        >
                          {t('admin.edit')}
                        </button>
                        {item.kind === 'STANDARD' && (
                          <button
                            className="btn-secondary min-h-9 px-3 text-sm"
                            onClick={() => setAddingVariantTo(item)}
                            aria-label={`${t('admin.menuPage.addVariant')} ${item.name}`}
                          >
                            +
                          </button>
                        )}
                        {item.kind === 'DEAL' && (
                          <>
                            <button
                              className="btn-secondary min-h-9 px-3 text-sm"
                              onClick={() => setEditingDeal(item)}
                            >
                              {t('admin.dealEditor.edit')}
                            </button>
                            <div className="mt-1 max-w-44 whitespace-normal text-xs text-slate-500">
                              {t('admin.menuPage.dealNote')}
                            </div>
                          </>
                        )}
                      </td>
                    </>
                  ) : null}
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <ItemDialog
          data={data}
          item={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onDone={() => void refresh()}
          onSetup={setSetup}
          onDelete={
            editing === 'new'
              ? undefined
              : () => {
                  setDeletingItem(editing);
                  setEditing(null);
                }
          }
        />
      )}
      {editingDeal && (
        <DealEditor
          item={editingDeal}
          menu={data}
          onClose={() => setEditingDeal(null)}
          onDone={() => void refresh()}
        />
      )}
      {addingVariantTo && (
        <VariantDialog
          data={data}
          item={addingVariantTo}
          onClose={() => setAddingVariantTo(null)}
          onDone={() => void refresh()}
        />
      )}
      {importing && (
        <ImportDialog onClose={() => setImporting(false)} onDone={() => void refresh()} />
      )}
      {setup && (
        <MenuSetupDialog
          data={data}
          tab={setup}
          onClose={() => setSetup(null)}
          onDone={() => void refresh()}
        />
      )}
      {deletingItem && (
        <ConfirmDelete
          name={deletingItem.name}
          run={() => api(`/items/${deletingItem.id}`, { method: 'DELETE' })}
          onDone={() => void refresh()}
          onClose={() => setDeletingItem(null)}
        />
      )}
      {editingVariant && (
        <VariantEditDialog
          item={editingVariant.item}
          variant={editingVariant.variant}
          onClose={() => setEditingVariant(null)}
          onDone={() => void refresh()}
          onDelete={() => {
            setDeletingVariant(editingVariant);
            setEditingVariant(null);
          }}
        />
      )}
      {deletingVariant && (
        <ConfirmDelete
          name={`${deletingVariant.item.name} · ${deletingVariant.variant.name}`}
          run={() => api(`/variants/${deletingVariant.variant.id}`, { method: 'DELETE' })}
          onDone={() => void refresh()}
          onClose={() => setDeletingVariant(null)}
        />
      )}
    </div>
  );
}

/** An editable price in rupees. Blur saves; invalid input is flagged and not sent. */
function PriceCell({
  variant,
  listId,
  listCode,
  onSaved,
  onError,
}: {
  variant: AdminVariant;
  listId: string;
  listCode: string;
  onSaved: () => Promise<unknown>;
  onError: (e: unknown) => void;
}) {
  const { t } = useTranslation();
  const current = variant.prices[listCode] ?? null;
  const [text, setText] = useState(current === null ? '' : formatPaisa(asPaisa(current)));
  const [invalid, setInvalid] = useState(false);
  // a price changed somewhere else (the Edit dialog, another till) must show here too
  useEffect(() => {
    setText(current === null ? '' : formatPaisa(asPaisa(current)));
    setInvalid(false);
  }, [current]);
  const save = useMutation({
    mutationFn: (pricePaisa: number) =>
      api(`/variants/${variant.id}/prices/${listId}`, { method: 'PUT', body: { pricePaisa } }),
    onSuccess: () => {
      setInvalid(false);
      onError(null);
      return onSaved();
    },
    onError,
  });

  function commit(): void {
    const trimmed = text.trim();
    if (trimmed === '' || (current !== null && trimmed === formatPaisa(asPaisa(current)))) return; // clearing a price is not supported
    try {
      const paisa = parseRupees(trimmed);
      if (paisa !== current) save.mutate(paisa);
    } catch {
      setInvalid(true);
    }
  }

  return (
    <input
      className={`cell-input ${invalid ? '!border-rose-500 bg-rose-50' : ''}`}
      inputMode="decimal"
      aria-label={`${listCode} ${t('admin.menuPage.variant')} ${variant.name}`}
      placeholder="—"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        setInvalid(false);
      }}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
  );
}

type PriceInputs = Record<string, string>; // price list code → rupees text

function PriceInputs({
  lists,
  value,
  onChange,
}: {
  lists: AdminMenu['priceLists'];
  value: PriceInputs;
  onChange: (v: PriceInputs) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {lists.map((l) => (
        <Field key={l.id} label={l.code}>
          <input
            className="input"
            inputMode="decimal"
            aria-label={`price ${l.code}`}
            value={value[l.code] ?? ''}
            onChange={(e) => onChange({ ...value, [l.code]: e.target.value })}
          />
        </Field>
      ))}
    </div>
  );
}

/** Saves prices typed in a form; returns an error message for the first invalid amount. */
async function savePrices(data: AdminMenu, variantId: string, inputs: PriceInputs): Promise<void> {
  for (const list of data.priceLists) {
    const text = inputs[list.code]?.trim();
    if (!text) continue;
    await api(`/variants/${variantId}/prices/${list.id}`, {
      method: 'PUT',
      body: { pricePaisa: parseRupees(text) },
    });
  }
}

function ItemDialog({
  data,
  item,
  onClose,
  onDone,
  onSetup,
  onDelete,
}: {
  data: AdminMenu;
  item: AdminItem | null;
  onClose: () => void;
  onDone: () => void;
  onSetup: (tab: 'categories' | 'stations') => void;
  onDelete?: (() => void) | undefined;
}) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState(item?.name ?? '');
  const [nameUr, setNameUr] = useState(item?.nameUr ?? '');
  const [code, setCode] = useState('');
  const [kind, setKind] = useState<'STANDARD' | 'WEIGHT' | 'DEAL'>('STANDARD');
  const [categoryId, setCategoryId] = useState(item?.categoryId ?? '');
  const [stationId, setStationId] = useState(item?.stationId ?? '');
  const [searchTerms, setSearchTerms] = useState(item?.searchTerms ?? '');
  const [guest, setGuest] = useState<GuestInfo>(() =>
    item
      ? {
          ...emptyGuestInfo(),
          description: item.description ?? '',
          descriptionUr: item.descriptionUr ?? '',
          hidden: item.hiddenFromGuests,
          tags: item.guestTags,
          allergens: item.allergens,
        }
      : emptyGuestInfo(),
  );
  const [variants, setVariants] = useState<{ name: string; prices: PriceInputs }[]>([
    { name: 'Regular', prices: {} },
  ]);
  // editing an existing item: its prices are shown here too (they can also be edited in the table)
  const priceText = (v: AdminItem['variants'][number]): PriceInputs =>
    Object.fromEntries(
      data.priceLists.map((l) => {
        const paisa = v.prices[l.code];
        return [l.code, paisa === null || paisa === undefined ? '' : formatPaisa(asPaisa(paisa))];
      }),
    );
  const liveVariants = (item?.variants ?? []).filter((v) => v.isActive);
  const [priceEdits, setPriceEdits] = useState<Record<string, PriceInputs>>(() =>
    Object.fromEntries(liveVariants.map((v) => [v.id, priceText(v)])),
  );
  const [error, setError] = useState<unknown>(null);

  const save = useMutation({
    mutationFn: async () => {
      const common = {
        name: name.trim(),
        nameUr: nameUr.trim() || null,
        categoryId: categoryId || null,
        stationId: stationId || null,
        searchTerms: searchTerms.trim() || null,
        ...guestPayload(guest),
      };
      const savePhoto = async (id: string): Promise<void> => {
        if (guest.photo || guest.removePhoto) qc.removeQueries({ queryKey: ['item-photo', id] });
        if (guest.photo)
          await api(`/items/${id}/image`, {
            method: 'PUT',
            rawBlob: { content: guest.photo, contentType: 'image/jpeg' },
          });
        else if (guest.removePhoto) await api(`/items/${id}/image`, { method: 'DELETE' });
      };
      if (item) {
        await api(`/items/${item.id}`, { method: 'PATCH', body: common });
        // only the prices that were changed are sent
        for (const v of liveVariants) {
          const before = priceText(v);
          const now = priceEdits[v.id] ?? before;
          const changed: PriceInputs = {};
          for (const l of data.priceLists)
            if ((now[l.code] ?? '').trim() !== (before[l.code] ?? ''))
              changed[l.code] = now[l.code]!;
          await savePrices(data, v.id, changed);
        }
        await savePhoto(item.id);
        return;
      }
      const created = await api<{ id: string; variants: { id: string }[] }>('/items', {
        method: 'POST',
        body: {
          ...common,
          kind,
          ...(code.trim() ? { code: code.trim() } : {}),
          ...(kind === 'STANDARD'
            ? { variants: variants.map((v) => ({ name: v.name.trim() || 'Regular' })) }
            : {}),
        },
      });
      for (const [i, v] of created.variants.entries())
        await savePrices(data, v.id, variants[i]?.prices ?? {});
      await savePhoto(created.id);
    },
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: setError,
  });

  return (
    <Dialog
      title={item ? t('admin.menuPage.editItem') : t('admin.menuPage.newItem')}
      onClose={onClose}
      wide
    >
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t('admin.name')}>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </Field>
          <Field label={t('admin.nameUr')}>
            <input
              className="input"
              dir="rtl"
              lang="ur"
              value={nameUr}
              onChange={(e) => setNameUr(e.target.value)}
            />
          </Field>
          {!item && (
            <>
              <Field label={t('admin.code')}>
                <input className="input" value={code} onChange={(e) => setCode(e.target.value)} />
              </Field>
              <Field label={t('admin.menuPage.type')}>
                <select
                  className="input"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as typeof kind)}
                >
                  <option value="STANDARD">STANDARD</option>
                  <option value="WEIGHT">WEIGHT (per kg)</option>
                  <option value="DEAL">DEAL</option>
                </select>
              </Field>
            </>
          )}
          <Field label={t('admin.category')}>
            <select
              className="input"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
            >
              <option value="">{t('admin.none')}</option>
              {categoryTree(data.categories, (c) => localName(i18n.language, c.name, c.nameUr)).map(
                ({ cat, depth, path }) => (
                  <option key={cat.id} value={cat.id}>
                    {depth ? `\u00a0\u00a0↳ ${path}` : path}
                  </option>
                ),
              )}
            </select>
            <button
              type="button"
              className="mt-1 text-sm font-medium text-emerald-700 underline-offset-2 hover:underline"
              onClick={() => onSetup('categories')}
            >
              {data.categories.length === 0
                ? t('admin.menuPage.noCategoriesYet')
                : t('admin.menuPage.newCategory')}
            </button>
          </Field>
          <Field label={t('admin.station')}>
            <select
              className="input"
              value={stationId}
              onChange={(e) => setStationId(e.target.value)}
            >
              <option value="">{t('admin.none')}</option>
              {data.stations.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="mt-1 text-sm font-medium text-emerald-700 underline-offset-2 hover:underline"
              onClick={() => onSetup('stations')}
            >
              {data.stations.length === 0
                ? t('admin.menuPage.noStationsYet')
                : t('admin.menuPage.newStation')}
            </button>
          </Field>
          <Field label={t('admin.menuPage.searchWords')}>
            <input
              className="input"
              value={searchTerms}
              onChange={(e) => setSearchTerms(e.target.value)}
            />
          </Field>
        </div>

        {item && liveVariants.length > 0 && (
          <fieldset className="space-y-2">
            <legend className="font-semibold">{t('admin.menuPage.prices')}</legend>
            <p className="text-sm text-slate-500">{t('admin.menuPage.priceHint')}</p>
            {liveVariants.map((v) => (
              <div key={v.id} className="space-y-2 rounded-lg border border-slate-200 p-3">
                {liveVariants.length > 1 && <div className="font-medium">{v.name}</div>}
                <PriceInputs
                  lists={sortLists(data.priceLists)}
                  value={priceEdits[v.id] ?? {}}
                  onChange={(prices) => setPriceEdits({ ...priceEdits, [v.id]: prices })}
                />
              </div>
            ))}
          </fieldset>
        )}

        {!item && (
          <fieldset className="space-y-2">
            <legend className="font-semibold">
              {kind === 'WEIGHT'
                ? `${t('admin.menuPage.variants')} (/kg)`
                : t('admin.menuPage.variants')}
            </legend>
            <p className="text-sm text-slate-500">{t('admin.menuPage.priceHint')}</p>
            {(kind === 'STANDARD' ? variants : variants.slice(0, 1)).map((v, i) => (
              <div key={i} className="space-y-2 rounded-lg border border-slate-200 p-3">
                {kind === 'STANDARD' && (
                  <div className="flex gap-2">
                    <input
                      className="input"
                      aria-label={t('admin.menuPage.variant')}
                      placeholder={t('admin.menuPage.variant')}
                      value={v.name}
                      onChange={(e) =>
                        setVariants(
                          variants.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                        )
                      }
                    />
                    {variants.length > 1 && (
                      <button
                        className="btn-secondary"
                        onClick={() => setVariants(variants.filter((_, j) => j !== i))}
                        aria-label="remove variant"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                )}
                <PriceInputs
                  lists={sortLists(data.priceLists)}
                  value={v.prices}
                  onChange={(prices) =>
                    setVariants(variants.map((x, j) => (j === i ? { ...x, prices } : x)))
                  }
                />
              </div>
            ))}
            {kind === 'STANDARD' && (
              <button
                className="btn-secondary"
                onClick={() => setVariants([...variants, { name: '', prices: {} }])}
              >
                + {t('admin.menuPage.addVariant')}
              </button>
            )}
          </fieldset>
        )}

        <GuestInfoFields
          itemId={item?.id ?? null}
          hasImage={item?.hasImage ?? false}
          value={guest}
          onChange={setGuest}
        />

        <ErrorText error={error} />
        <div className="flex items-center justify-end gap-2">
          {onDelete && (
            <button className="btn-danger-quiet me-auto" onClick={onDelete}>
              {t('admin.delete')}
            </button>
          )}
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn-primary"
            disabled={save.isPending || !name.trim()}
            onClick={() => save.mutate()}
          >
            {item ? t('admin.save') : t('admin.create')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function VariantDialog({
  data,
  item,
  onClose,
  onDone,
}: {
  data: AdminMenu;
  item: AdminItem;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [prices, setPrices] = useState<PriceInputs>({});
  const [error, setError] = useState<unknown>(null);
  const save = useMutation({
    mutationFn: async () => {
      const v = await api<{ id: string }>(`/items/${item.id}/variants`, {
        method: 'POST',
        body: { name: name.trim() },
      });
      await savePrices(data, v.id, prices);
    },
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: setError,
  });
  return (
    <Dialog title={`${t('admin.menuPage.addVariant')}: ${item.name}`} onClose={onClose}>
      <div className="space-y-3">
        <Field label={t('admin.menuPage.variant')}>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </Field>
        <PriceInputs lists={sortLists(data.priceLists)} value={prices} onChange={setPrices} />
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn-primary"
            disabled={save.isPending || !name.trim()}
            onClick={() => save.mutate()}
          >
            {t('admin.create')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** Renames a size/variant (the prices are edited in the table). */
function VariantEditDialog({
  item,
  variant,
  onClose,
  onDone,
  onDelete,
}: {
  item: AdminItem;
  variant: AdminItem['variants'][number];
  onClose: () => void;
  onDone: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(variant.name);
  const [nameUr, setNameUr] = useState(variant.nameUr ?? '');
  const [error, setError] = useState<unknown>(null);
  const save = useMutation({
    mutationFn: () =>
      api(`/variants/${variant.id}`, {
        method: 'PATCH',
        body: { name: name.trim(), nameUr: nameUr.trim() || null },
      }),
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: setError,
  });
  return (
    <Dialog title={`${t('admin.edit')}: ${item.name}`} onClose={onClose}>
      <div className="space-y-3">
        <Field label={t('admin.menuPage.variant')}>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </Field>
        <Field label={t('admin.menuPage.nameUr')}>
          <input
            className="input"
            dir="rtl"
            value={nameUr}
            onChange={(e) => setNameUr(e.target.value)}
          />
        </Field>
        <ErrorText error={error} />
        <div className="flex items-center justify-end gap-2">
          <button className="btn-danger-quiet me-auto" onClick={onDelete}>
            {t('admin.delete')}
          </button>
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn-primary"
            disabled={save.isPending || !name.trim()}
            onClick={() => save.mutate()}
          >
            {t('admin.save')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** Two steps: "Check file" (dry run, changes nothing) then "Apply import" (all or nothing). */
function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [applied, setApplied] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const run = useMutation({
    mutationFn: (dryRun: boolean) =>
      api<ImportResult>(`/menu/import?dryRun=${dryRun}`, {
        method: 'POST',
        rawText: { content: csv!, contentType: 'text/csv; charset=utf-8' },
      }),
    onSuccess: (r) => {
      setError(null);
      setResult(r);
      if (!r.dryRun) {
        setApplied(true);
        onDone();
      }
    },
    onError: setError,
  });

  const s = result?.summary;
  return (
    <Dialog title={t('admin.importer.title')} onClose={onClose} wide>
      <div className="space-y-3">
        <input
          type="file"
          accept=".csv,text/csv"
          aria-label={t('admin.importer.choose')}
          className="block w-full text-sm"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            setResult(null);
            setApplied(false);
            setFileName(f?.name ?? '');
            setCsv(f ? (await f.text()).replace(/^\uFEFF/, '') : null);
          }}
        />
        <ErrorText error={error} />

        {result && !applied && (
          <div className="space-y-2">
            {result.errors.length > 0 ? (
              <>
                <h3 className="font-semibold text-rose-700">{t('admin.importer.problems')}</h3>
                <ul className="max-h-60 space-y-1 overflow-auto rounded-lg bg-rose-50 p-3 text-sm text-rose-800">
                  {result.errors.map((e, i) => (
                    <li key={i}>
                      {t('admin.importer.line')} {e.line}: {e.message}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              s && (
                <>
                  <h3 className="font-semibold">{t('admin.importer.summary')}</h3>
                  <ul className="grid grid-cols-2 gap-x-4 rounded-lg bg-emerald-50 p-3 text-sm sm:grid-cols-3">
                    <li>categories +{s.categoriesCreated}</li>
                    <li>items +{s.itemsCreated}</li>
                    <li>items updated {s.itemsUpdated}</li>
                    <li>variants +{s.variantsCreated}</li>
                    <li>prices set {s.pricesSet}</li>
                    <li>prices unchanged {s.pricesUnchanged}</li>
                  </ul>
                </>
              )
            )}
            {result.warnings.length > 0 && (
              <>
                <h3 className="font-semibold text-amber-700">{t('admin.importer.warnings')}</h3>
                <ul className="max-h-32 space-y-1 overflow-auto rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                  {result.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
        {applied && (
          <p role="status" className="rounded-lg bg-emerald-50 p-3 font-semibold text-emerald-800">
            {t('admin.importer.applied')}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>
            {applied ? t('common.close') : t('common.cancel')}
          </button>
          {!applied && (
            <>
              <button
                className="btn-secondary"
                disabled={!csv || run.isPending}
                onClick={() => run.mutate(true)}
              >
                {t('admin.importer.check')}
              </button>
              <button
                className="btn-primary"
                disabled={!result?.ok || run.isPending}
                onClick={() => run.mutate(false)}
                title={fileName}
              >
                {t('admin.importer.apply')}
              </button>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
