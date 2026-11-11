import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { formatRs, ltr } from '../../lib/money';
import { can, useMe } from '../../lib/queries';
import type { Ingredient, StocktakeView } from '../../lib/types';
import { parseSignedRs } from './DealEditor';
import { Icon } from '../../components/Icon';
import { Dialog, EmptyRow, ErrorText, Field, PageHead } from './ui';

const newKey = (): string => `ui-${crypto.randomUUID()}`;
export const useIngredients = (search = '', low = false) =>
  useQuery({
    queryKey: ['ingredients', search, low],
    queryFn: async () =>
      (
        await api<{ items: Ingredient[] }>(
          `/inventory/ingredients?search=${encodeURIComponent(search)}${low ? '&low=true' : ''}`,
        )
      ).items,
  });

/** Ingredients and their stock, wastage / staff meals, and the stocktake. */
export function StockAdmin() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  const write = can(me.data, 'stock.manage');
  const [search, setSearch] = useState('');
  const [low, setLow] = useState(false);
  const list = useIngredients(search, low);
  const [dialog, setDialog] = useState<'new' | 'waste' | null>(null);
  const refresh = (): Promise<void> => qc.invalidateQueries({ queryKey: ['ingredients'] });

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4">
      <PageHead title={t('stockPage.title')} hint={t('stockPage.hint')}>
        {write && (
          <>
            <button className="btn-secondary" onClick={() => setDialog('waste')}>
              {t('stockPage.wastage')}
            </button>
            <button className="btn-primary" onClick={() => setDialog('new')}>
              <Icon name="plus" size={18} />
              {t('stockPage.newIngredient')}
            </button>
          </>
        )}
      </PageHead>
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-xs">
          <Icon
            name="search"
            size={18}
            className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-slate-500"
          />
          <input
            className="input ps-10"
            placeholder={t('stockPage.search')}
            aria-label={t('stockPage.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <button
          className="seg-item border border-slate-400 bg-white"
          aria-pressed={low}
          onClick={() => setLow(!low)}
        >
          <Icon name="alert" size={16} className="me-1.5" />
          {t('stockPage.lowOnly')}
        </button>
      </div>

      <div className="dt">
        <table className="min-w-[40rem]">
          <thead>
            <tr>
              <th>{t('stockPage.name')}</th>
              <th className="num">{t('stockPage.onHand')}</th>
              <th className="num">{t('stockPage.avgCost')}</th>
              <th className="num">{t('stockPage.value')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(list.data ?? []).map((i) => (
              <tr key={i.id} data-testid={`ingredient-${i.name}`}>
                <td className="name">
                  {i.name}
                  {i.isPrep && <span className="chip-info ms-2">prep</span>}
                </td>
                <td className={`num ${Number(i.onHand) < 0 ? 'font-semibold !text-rose-700' : ''}`}>
                  {ltr(`${i.onHand} ${i.baseUom}`)}
                </td>
                <td className="num">{ltr(Number(i.avgCostPerBase).toFixed(2))}</td>
                <td className="num">{ltr(formatRs(i.stockValuePaisa))}</td>
                <td className="text-end">
                  {i.needsReorder && <span className="chip-warn">{t('stockPage.low')}</span>}
                </td>
              </tr>
            ))}
            {list.data?.length === 0 && <EmptyRow cols={5} icon="box" text={t('stockPage.none')} />}
          </tbody>
        </table>
      </div>

      {write && <StocktakePanel />}

      {dialog === 'new' && (
        <NewIngredient onClose={() => setDialog(null)} onDone={() => void refresh()} />
      )}
      {dialog === 'waste' && (
        <WasteDialog
          ingredients={list.data ?? []}
          onClose={() => setDialog(null)}
          onDone={() => void refresh()}
        />
      )}
    </div>
  );
}

function NewIngredient({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [f, setF] = useState({
    name: '',
    baseUom: 'g',
    purchaseUom: 'kg',
    factor: '1000',
    yieldPct: '100',
    reorder: '',
    opening: '',
    cost: '',
    isPrep: false,
  });
  const create = useMutation({
    mutationFn: () =>
      api('/inventory/ingredients', {
        method: 'POST',
        body: {
          name: f.name.trim(),
          baseUom: f.baseUom,
          purchaseUom: f.purchaseUom.trim(),
          purchaseToBase: Number(f.factor),
          yieldBps: Math.round(Number(f.yieldPct) * 100),
          isPrep: f.isPrep,
          ...(f.reorder ? { reorderLevel: Number(f.reorder) } : {}),
          ...(f.opening
            ? {
                openingQty: Number(f.opening),
                openingCostPaisaPerPurchase: parseSignedRs(f.cost || '0') ?? 0,
              }
            : {}),
        },
      }),
    onSuccess: () => {
      onDone();
      onClose();
    },
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  const valid =
    f.name.trim() &&
    f.purchaseUom.trim() &&
    Number(f.factor) > 0 &&
    Number(f.yieldPct) > 0 &&
    Number(f.yieldPct) <= 100;
  return (
    <Dialog title={t('stockPage.newIngredient')} onClose={onClose}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('stockPage.name')}>
          <input className="input" value={f.name} onChange={set('name')} autoFocus />
        </Field>
        <Field label={t('stockPage.baseUom')}>
          <select className="input" value={f.baseUom} onChange={set('baseUom')}>
            {(['g', 'ml', 'pcs'] as const).map((u) => (
              <option key={u} value={u}>
                {t(`stockPage.base.${u}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('stockPage.purchaseUom')}>
          <input className="input" value={f.purchaseUom} onChange={set('purchaseUom')} />
        </Field>
        <Field label={t('stockPage.factor')}>
          <input className="input" inputMode="decimal" value={f.factor} onChange={set('factor')} />
        </Field>
        <Field label={t('stockPage.yield')}>
          <input
            className="input"
            inputMode="decimal"
            value={f.yieldPct}
            onChange={set('yieldPct')}
          />
        </Field>
        <Field label={t('stockPage.reorder')}>
          <input
            className="input"
            inputMode="decimal"
            value={f.reorder}
            onChange={set('reorder')}
          />
        </Field>
        <Field label={t('stockPage.openingQty')}>
          <input
            className="input"
            inputMode="decimal"
            value={f.opening}
            onChange={set('opening')}
          />
        </Field>
        <Field label={t('stockPage.openingCost')}>
          <input className="input" inputMode="decimal" value={f.cost} onChange={set('cost')} />
        </Field>
      </div>
      <label className="mt-3 flex items-center gap-2">
        <input
          type="checkbox"
          className="size-5"
          checked={f.isPrep}
          onChange={(e) => setF({ ...f, isPrep: e.target.checked })}
        />
        {t('stockPage.isPrep')}
      </label>
      <div className="mt-3">
        <ErrorText error={create.error} />
      </div>
      <button
        className="btn-primary mt-3 w-full"
        disabled={!valid || create.isPending}
        onClick={() => create.mutate()}
      >
        {t('stockPage.create')}
      </button>
    </Dialog>
  );
}

function WasteDialog({
  ingredients,
  onClose,
  onDone,
}: {
  ingredients: Ingredient[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [ingredientId, setIngredientId] = useState('');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('SPOILAGE');
  const [staffMeal, setStaffMeal] = useState(false);
  const [note, setNote] = useState('');
  const key = useState(newKey)[0];
  const record = useMutation({
    mutationFn: () =>
      api('/inventory/wastage', {
        method: 'POST',
        body: {
          ingredientId,
          qty: Number(qty),
          kind: staffMeal ? 'STAFF_MEAL' : 'WASTAGE',
          ...(staffMeal ? {} : { reasonCode: reason }),
          ...(note.trim() ? { note: note.trim() } : {}),
        },
        headers: { 'idempotency-key': key },
      }),
    onSuccess: () => {
      onDone();
      onClose();
    },
  });
  return (
    <Dialog title={t('stockPage.wastage')} onClose={onClose}>
      <div className="space-y-3">
        <Field label={t('stockPage.ingredient')}>
          <select
            className="input"
            value={ingredientId}
            onChange={(e) => setIngredientId(e.target.value)}
          >
            <option value="">—</option>
            {ingredients.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} ({i.baseUom})
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('stockPage.qty')}>
          <input
            className="input"
            inputMode="decimal"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
          />
        </Field>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            className="size-5"
            checked={staffMeal}
            onChange={(e) => setStaffMeal(e.target.checked)}
          />
          {t('stockPage.staffMeal')}
        </label>
        {!staffMeal && (
          <Field label={t('stockPage.reason')}>
            <select className="input" value={reason} onChange={(e) => setReason(e.target.value)}>
              {['SPOILAGE', 'OVERCOOK', 'DROPPED', 'EXPIRED', 'OTHER'].map((r) => (
                <option key={r} value={r}>
                  {t(`stockPage.${r === 'OVERCOOK' ? 'overcook' : r.toLowerCase()}`)}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label={t('stockPage.note')}>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <ErrorText error={record.error} />
        <button
          className="btn-primary w-full"
          disabled={!ingredientId || !(Number(qty) > 0) || record.isPending}
          onClick={() => record.mutate()}
        >
          {t('stockPage.record')}
        </button>
      </div>
    </Dialog>
  );
}

/** One count at a time: start it, type what is on the shelf, post the differences. */
function StocktakePanel() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const open = useQuery({
    queryKey: ['stocktake-open'],
    queryFn: async () => {
      const all = (
        await api<{ items: { id: string; status: string }[] }>('/stocktakes')
      ).items.find((s) => s.status === 'OPEN');
      return all ? api<StocktakeView>(`/stocktakes/${all.id}`) : null;
    },
  });
  const start = useMutation({
    mutationFn: () => api<StocktakeView>('/stocktakes', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['stocktake-open'] }),
  });
  const count = useMutation({
    mutationFn: (v: { id: string; ingredientId: string; countedQty: number | null }) =>
      api<StocktakeView>(`/stocktakes/${v.id}/lines`, {
        method: 'PUT',
        body: { ingredientId: v.ingredientId, countedQty: v.countedQty },
      }),
    onSuccess: (s) => qc.setQueryData(['stocktake-open'], s),
  });
  const post = useMutation({
    mutationFn: (id: string) => api(`/stocktakes/${id}/post`, { method: 'POST' }),
    onSuccess: async () => {
      setMessage(t('stockPage.posted'));
      await qc.invalidateQueries({ queryKey: ['stocktake-open'] });
      await qc.invalidateQueries({ queryKey: ['ingredients'] });
    },
  });
  const st = open.data;
  return (
    <section className="card space-y-3 p-4">
      <div className="flex items-center gap-2">
        <h2 className="me-auto text-lg font-bold">{t('stockPage.stocktake')}</h2>
        {!st && (
          <button
            className="btn-secondary"
            disabled={start.isPending}
            onClick={() => start.mutate()}
          >
            {t('stockPage.startCount')}
          </button>
        )}
        {st && (
          <button
            className="btn-primary"
            disabled={post.isPending}
            onClick={() => post.mutate(st.id)}
          >
            {t('stockPage.post')}
          </button>
        )}
      </div>
      {message && (
        <p role="status" className="rounded-lg bg-emerald-50 p-2 text-emerald-900">
          {message}
        </p>
      )}
      <ErrorText error={start.error ?? post.error ?? count.error} />
      {!st && !message && <p className="text-slate-500">{t('stockPage.noOpen')}</p>}
      {st && (
        <ul className="divide-y divide-slate-100">
          {st.lines.map((l) => (
            <li key={l.ingredientId} className="flex flex-wrap items-center gap-2 py-2">
              <span className="me-auto">{l.name}</span>
              <span className="text-sm text-slate-500">
                {t('stockPage.system')}: {ltr(`${l.systemQty} ${l.baseUom}`)}
              </span>
              <input
                className="input w-28"
                inputMode="decimal"
                aria-label={`${l.name} ${t('stockPage.counted')}`}
                placeholder={t('stockPage.counted')}
                defaultValue={l.countedQty ?? ''}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v === (l.countedQty ?? '')) return;
                  count.mutate({
                    id: st.id,
                    ingredientId: l.ingredientId,
                    countedQty: v === '' ? null : Number(v),
                  });
                }}
              />
              {l.varianceQty !== null && l.varianceQty !== '0' && (
                <span className={Number(l.varianceQty) < 0 ? 'text-rose-700' : 'text-emerald-700'}>
                  {ltr(l.varianceQty)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
