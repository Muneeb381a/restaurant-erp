import { asPaisa, formatPaisa, parseRupees } from '@erp/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { localName } from '../../i18n';
import { api } from '../../lib/api';
import type { AdminItem, AdminMenu, AdminVariant, ImportResult } from '../../lib/types';
import { DealEditor } from './DealEditor';
import { Dialog, ErrorText, Field, Toggle, td, th } from './ui';

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

export function MenuAdmin() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const qc = useQueryClient();
  const menu = useQuery({ queryKey: ADMIN_MENU_KEY, queryFn: () => api<AdminMenu>('/menu/admin') });
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [editing, setEditing] = useState<AdminItem | 'new' | null>(null);
  const [addingVariantTo, setAddingVariantTo] = useState<AdminItem | null>(null);
  const [editingDeal, setEditingDeal] = useState<AdminItem | null>(null);
  const [importing, setImporting] = useState(false);
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

  const items = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (menu.data?.items ?? []).filter(
      (i) =>
        (!category || i.categoryId === category) &&
        (!q || [i.name, i.nameUr, i.code, i.searchTerms].some((s) => s?.toLowerCase().includes(q))),
    );
  }, [menu.data, search, category]);

  if (menu.isPending) return <p className="p-4">{t('common.loading')}</p>;
  if (menu.isError || !menu.data) return <ErrorText error={menu.error} />;
  const data = menu.data;
  // channels in the order a restaurant thinks of them: dine-in first
  const lists = sortLists(data.priceLists);
  const categoryName = (id: string | null): string => {
    const c = data.categories.find((x) => x.id === id);
    return c ? localName(lang, c.name, c.nameUr) : '';
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
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="input max-w-xs"
          placeholder={t('admin.search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="input max-w-52"
          aria-label={t('admin.category')}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">{t('admin.all')}</option>
          {data.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {localName(lang, c.name, c.nameUr)}
            </option>
          ))}
        </select>
        <span className="me-auto text-sm text-slate-500">{t('admin.menuPage.priceHint')}</span>
        <button className="btn-secondary" onClick={() => void exportCsv()}>
          {t('admin.menuPage.export')}
        </button>
        <button className="btn-secondary" onClick={() => setImporting(true)}>
          {t('admin.menuPage.import')}
        </button>
        <button className="btn-primary" onClick={() => setEditing('new')}>
          + {t('admin.menuPage.newItem')}
        </button>
      </div>
      <ErrorText error={error} />

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[56rem] text-sm">
          <thead className="border-b border-slate-200 bg-slate-50">
            <tr>
              <th className={th}>{t('admin.name')}</th>
              <th className={th}>{t('admin.category')}</th>
              <th className={th}>{t('admin.station')}</th>
              <th className={th}>{t('admin.menuPage.variant')}</th>
              {lists.map((l) => (
                <th key={l.id} className={th}>
                  {l.code}
                </th>
              ))}
              <th className={th}>{t('admin.menuPage.available')}</th>
              <th className={th}>{t('admin.active')}</th>
              <th className={th} />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.length === 0 && (
              <tr>
                <td className={td} colSpan={8 + data.priceLists.length}>
                  {t('admin.menuPage.noItems')}
                </td>
              </tr>
            )}
            {items.map((item) =>
              item.variants.map((v, idx) => (
                <tr key={v.id} className={item.isActive ? '' : 'bg-slate-50 text-slate-400'}>
                  {idx === 0 ? (
                    <>
                      <td className={td} rowSpan={item.variants.length}>
                        <div className="font-medium text-slate-900">
                          {localName(lang, item.name, item.nameUr)}
                        </div>
                        <div className="text-xs text-slate-500">
                          {item.code} · {item.kind}
                        </div>
                      </td>
                      <td className={td} rowSpan={item.variants.length}>
                        {categoryName(item.categoryId)}
                      </td>
                      <td className={td} rowSpan={item.variants.length}>
                        {stationCode(item.stationId)}
                      </td>
                    </>
                  ) : null}
                  <td className={td}>
                    {item.kind === 'STANDARD' && item.variants.length === 1
                      ? ''
                      : localName(lang, v.name, v.nameUr)}
                  </td>
                  {lists.map((l) => (
                    <td key={l.id} className={td}>
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
                      <td className={td} rowSpan={item.variants.length}>
                        <Toggle
                          on={item.isAvailable}
                          label={`${t('admin.menuPage.available')} ${item.name}`}
                          onChange={(v2) =>
                            setAvailability.mutate({ id: item.id, isAvailable: v2 })
                          }
                        />
                      </td>
                      <td className={td} rowSpan={item.variants.length}>
                        <Toggle
                          on={item.isActive}
                          label={`${t('admin.active')} ${item.name}`}
                          onChange={(v2) =>
                            patchItem.mutate({ id: item.id, body: { isActive: v2 } })
                          }
                        />
                      </td>
                      <td className={`${td} whitespace-nowrap`} rowSpan={item.variants.length}>
                        <button className="btn-secondary me-1" onClick={() => setEditing(item)}>
                          {t('admin.edit')}
                        </button>
                        {item.kind === 'STANDARD' && (
                          <button
                            className="btn-secondary"
                            onClick={() => setAddingVariantTo(item)}
                            aria-label={`${t('admin.menuPage.addVariant')} ${item.name}`}
                          >
                            +
                          </button>
                        )}
                        {item.kind === 'DEAL' && (
                          <>
                            <button className="btn-secondary" onClick={() => setEditingDeal(item)}>
                              {t('admin.dealEditor.edit')}
                            </button>
                            <div className="mt-1 text-xs text-slate-500">
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
      className={`input !min-h-9 w-24 text-end ${invalid ? 'border-rose-500' : ''}`}
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
}: {
  data: AdminMenu;
  item: AdminItem | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [name, setName] = useState(item?.name ?? '');
  const [nameUr, setNameUr] = useState(item?.nameUr ?? '');
  const [code, setCode] = useState('');
  const [kind, setKind] = useState<'STANDARD' | 'WEIGHT' | 'DEAL'>('STANDARD');
  const [categoryId, setCategoryId] = useState(item?.categoryId ?? '');
  const [stationId, setStationId] = useState(item?.stationId ?? '');
  const [searchTerms, setSearchTerms] = useState(item?.searchTerms ?? '');
  const [variants, setVariants] = useState<{ name: string; prices: PriceInputs }[]>([
    { name: 'Regular', prices: {} },
  ]);
  const [error, setError] = useState<unknown>(null);

  const save = useMutation({
    mutationFn: async () => {
      const common = {
        name: name.trim(),
        nameUr: nameUr.trim() || null,
        categoryId: categoryId || null,
        stationId: stationId || null,
        searchTerms: searchTerms.trim() || null,
      };
      if (item) {
        await api(`/items/${item.id}`, { method: 'PATCH', body: common });
        return;
      }
      const created = await api<{ variants: { id: string }[] }>('/items', {
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
              {data.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {localName(i18n.language, c.name, c.nameUr)}
                </option>
              ))}
            </select>
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
          </Field>
          <Field label={t('admin.menuPage.searchWords')}>
            <input
              className="input"
              value={searchTerms}
              onChange={(e) => setSearchTerms(e.target.value)}
            />
          </Field>
        </div>

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
