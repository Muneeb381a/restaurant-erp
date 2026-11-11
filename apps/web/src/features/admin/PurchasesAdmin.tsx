import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { formatRs, ltr, parseRs } from '../../lib/money';
import { can, useMe } from '../../lib/queries';
import type { PurchaseRow, Supplier } from '../../lib/types';
import { Dialog, EmptyRow, ErrorText, Field } from './ui';
import { useIngredients } from './StockAdmin';

const SOURCES = ['DRAWER_CASH', 'OWNER_CASH', 'BANK'] as const;
const newKey = (): string => `ui-${crypto.randomUUID()}`;

interface Line {
  ingredientId: string;
  qty: string;
  unitCost: string;
}

/** Buying stock: a purchase raises stock and the weighted-average cost; what is unpaid stays owed to the supplier. */
export function PurchasesAdmin() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  const ingredients = useIngredients();
  const suppliers = useQuery({
    queryKey: ['suppliers'],
    queryFn: async () => (await api<{ items: Supplier[] }>('/suppliers')).items,
  });
  const purchases = useQuery({
    queryKey: ['purchases'],
    queryFn: async () => (await api<{ items: PurchaseRow[] }>('/purchases?limit=20')).items,
  });
  const canPay = can(me.data, 'expense.manage');

  const [supplierId, setSupplierId] = useState('');
  const [invoice, setInvoice] = useState('');
  const [lines, setLines] = useState<Line[]>([{ ingredientId: '', qty: '', unitCost: '' }]);
  const [paid, setPaid] = useState('');
  const [source, setSource] = useState<(typeof SOURCES)[number]>('BANK');
  const [message, setMessage] = useState<string | null>(null);
  const [paying, setPaying] = useState<Supplier | null>(null);
  const [newSupplier, setNewSupplier] = useState(false);
  const key = useRef(newKey());

  const total = lines.reduce((n, l) => {
    const unit = parseRs(l.unitCost);
    const q = Number(l.qty);
    return unit !== null && q > 0 ? n + Math.round(q * unit) : n;
  }, 0);
  const valid =
    lines.every((l) => l.ingredientId && Number(l.qty) > 0 && parseRs(l.unitCost) !== null) &&
    (parseRs(paid || '0') ?? 0) <= total;

  const post = useMutation({
    mutationFn: () =>
      api('/purchases', {
        method: 'POST',
        body: {
          ...(supplierId ? { supplierId } : {}),
          ...(invoice.trim() ? { invoiceRef: invoice.trim() } : {}),
          lines: lines.map((l) => ({
            ingredientId: l.ingredientId,
            qty: Number(l.qty),
            unitCostPaisa: parseRs(l.unitCost) ?? 0,
          })),
          ...((parseRs(paid || '0') ?? 0) > 0
            ? { payment: { amountPaisa: parseRs(paid) ?? 0, source } }
            : {}),
        },
        headers: { 'idempotency-key': key.current },
      }),
    onSuccess: async () => {
      setMessage(t('purchasePage.posted'));
      setLines([{ ingredientId: '', qty: '', unitCost: '' }]);
      setInvoice('');
      setPaid('');
      key.current = newKey();
      await Promise.all(
        ['purchases', 'suppliers', 'ingredients'].map((k) =>
          qc.invalidateQueries({ queryKey: [k] }),
        ),
      );
    },
  });
  const patch = (i: number, p: Partial<Line>): void =>
    setLines((ls) => ls.map((l, k) => (k === i ? { ...l, ...p } : l)));

  return (
    <div className="max-w-6xl space-y-6 p-4 md:p-6">
      <h1 className="text-2xl font-bold">{t('purchasePage.title')}</h1>
      <section className="card space-y-3 p-4">
        <h2 className="text-lg font-bold">{t('purchasePage.new')}</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('purchasePage.supplier')}>
            <div className="flex gap-2">
              <select
                className="input"
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
                aria-label={t('purchasePage.supplier')}
              >
                <option value="">{t('purchasePage.noSupplier')}</option>
                {(suppliers.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <button className="btn-secondary" onClick={() => setNewSupplier(true)}>
                +
              </button>
            </div>
          </Field>
          <Field label={t('purchasePage.invoice')}>
            <input className="input" value={invoice} onChange={(e) => setInvoice(e.target.value)} />
          </Field>
        </div>
        {lines.map((l, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2">
            <label className="min-w-40 flex-1 space-y-1">
              <span className="text-sm text-slate-600">{t('purchasePage.line')}</span>
              <select
                className="input"
                value={l.ingredientId}
                onChange={(e) => patch(i, { ingredientId: e.target.value })}
                aria-label={`${t('purchasePage.line')} ${i + 1}`}
              >
                <option value="">—</option>
                {(ingredients.data ?? []).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name} ({x.purchaseUom})
                  </option>
                ))}
              </select>
            </label>
            <label className="w-28 space-y-1">
              <span className="text-sm text-slate-600">{t('purchasePage.qty')}</span>
              <input
                className="input"
                inputMode="decimal"
                value={l.qty}
                onChange={(e) => patch(i, { qty: e.target.value })}
                aria-label={`${t('purchasePage.qty')} ${i + 1}`}
              />
            </label>
            <label className="w-36 space-y-1">
              <span className="text-sm text-slate-600">{t('purchasePage.unitCost')}</span>
              <input
                className="input"
                inputMode="decimal"
                value={l.unitCost}
                onChange={(e) => patch(i, { unitCost: e.target.value })}
                aria-label={`${t('purchasePage.unitCost')} ${i + 1}`}
              />
            </label>
            {lines.length > 1 && (
              <button
                className="btn-secondary"
                onClick={() => setLines(lines.filter((_, k) => k !== i))}
              >
                ✕
              </button>
            )}
          </div>
        ))}
        <button
          className="btn-secondary"
          onClick={() => setLines([...lines, { ingredientId: '', qty: '', unitCost: '' }])}
        >
          + {t('purchasePage.addLine')}
        </button>
        <div className="flex flex-wrap items-end gap-3 border-t border-slate-200 pt-3">
          <div className="me-auto text-xl font-bold" data-testid="purchase-total">
            {t('purchasePage.total')}: {ltr(formatRs(total))}
          </div>
          {canPay && (
            <>
              <label className="w-36 space-y-1">
                <span className="text-sm text-slate-600">{t('purchasePage.paidNow')}</span>
                <input
                  className="input"
                  inputMode="decimal"
                  value={paid}
                  onChange={(e) => setPaid(e.target.value)}
                  aria-label={t('purchasePage.paidNow')}
                />
              </label>
              <label className="w-40 space-y-1">
                <span className="text-sm text-slate-600">{t('purchasePage.source')}</span>
                <select
                  className="input"
                  value={source}
                  onChange={(e) => setSource(e.target.value as (typeof SOURCES)[number])}
                >
                  {SOURCES.map((s) => (
                    <option key={s} value={s}>
                      {t(`purchasePage.${s}`)}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <button
            className="btn-primary"
            disabled={!valid || post.isPending}
            onClick={() => post.mutate()}
          >
            {t('purchasePage.post')}
          </button>
        </div>
        {message && (
          <p role="status" className="rounded-lg bg-emerald-50 p-2 text-emerald-900">
            {message}
          </p>
        )}
        <ErrorText error={post.error} />
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">{t('purchasePage.recent')}</h2>
          <div className="dt">
            <table className="min-w-[20rem]">
              <thead>
                <tr>
                  <th>{t('purchasePage.supplier')}</th>
                  <th className="num">{t('purchasePage.total')}</th>
                </tr>
              </thead>
              <tbody>
                {(purchases.data ?? []).map((p) => (
                  <tr key={p.id}>
                    <td className="name">
                      {p.supplier ?? '—'}
                      {p.invoiceRef && <span className="sub">{ltr(p.invoiceRef)}</span>}
                    </td>
                    <td className="num">{ltr(formatRs(p.totalPaisa))}</td>
                  </tr>
                ))}
                {(purchases.data ?? []).length === 0 && (
                  <EmptyRow cols={2} icon="box" text={t('purchasePage.noPurchases')} />
                )}
              </tbody>
            </table>
          </div>
        </div>
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">{t('purchasePage.suppliers')}</h2>
          <div className="dt">
            <table className="min-w-[24rem]">
              <thead>
                <tr>
                  <th>{t('purchasePage.supplier')}</th>
                  <th className="num">{t('purchasePage.owed')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(suppliers.data ?? []).map((s) => (
                  <tr key={s.id} data-testid={`supplier-${s.name}`}>
                    <td className="name">{s.name}</td>
                    <td
                      className={`num font-semibold ${s.owedPaisa > 0 ? '!text-rose-700' : '!text-slate-500'}`}
                    >
                      <span className="sr-only">{t('purchasePage.owed')} </span>
                      {ltr(formatRs(s.owedPaisa))}
                    </td>
                    <td className="text-end">
                      {canPay && s.owedPaisa > 0 && (
                        <button className="btn-secondary" onClick={() => setPaying(s)}>
                          {t('purchasePage.pay')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {(suppliers.data ?? []).length === 0 && (
                  <EmptyRow cols={3} icon="user" text={t('purchasePage.noSuppliers')} />
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {newSupplier && (
        <SupplierDialog
          onClose={() => setNewSupplier(false)}
          onDone={() => void qc.invalidateQueries({ queryKey: ['suppliers'] })}
        />
      )}
      {paying && (
        <PayDialog
          supplier={paying}
          onClose={() => setPaying(null)}
          onDone={() =>
            void Promise.all(
              ['suppliers', 'purchases'].map((k) => qc.invalidateQueries({ queryKey: [k] })),
            )
          }
        />
      )}
    </div>
  );
}

function SupplierDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api('/suppliers', {
        method: 'POST',
        body: { name: name.trim(), ...(phone.trim() ? { phone: phone.trim() } : {}) },
      }),
    onSuccess: () => {
      onDone();
      onClose();
    },
  });
  return (
    <Dialog title={t('purchasePage.newSupplier')} onClose={onClose}>
      <div className="space-y-3">
        <Field label={t('purchasePage.name')}>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </Field>
        <Field label={t('purchasePage.phone')}>
          <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <ErrorText error={create.error} />
        <button
          className="btn-primary w-full"
          disabled={!name.trim() || create.isPending}
          onClick={() => create.mutate()}
        >
          {t('purchasePage.add')}
        </button>
      </div>
    </Dialog>
  );
}

function PayDialog({
  supplier,
  onClose,
  onDone,
}: {
  supplier: Supplier;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [amount, setAmount] = useState(String(supplier.owedPaisa / 100));
  const [source, setSource] = useState<(typeof SOURCES)[number]>('BANK');
  const key = useState(newKey)[0];
  const pay = useMutation({
    mutationFn: () =>
      api(`/suppliers/${supplier.id}/payments`, {
        method: 'POST',
        body: { amountPaisa: parseRs(amount) ?? 0, source },
        headers: { 'idempotency-key': key },
      }),
    onSuccess: () => {
      onDone();
      onClose();
    },
  });
  return (
    <Dialog title={`${t('purchasePage.pay')}: ${supplier.name}`} onClose={onClose}>
      <div className="space-y-3">
        <Field label={t('purchasePage.payAmount')}>
          <input
            className="input"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>
        <Field label={t('purchasePage.source')}>
          <select
            className="input"
            value={source}
            onChange={(e) => setSource(e.target.value as (typeof SOURCES)[number])}
          >
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {t(`purchasePage.${s}`)}
              </option>
            ))}
          </select>
        </Field>
        <ErrorText error={pay.error} />
        <button
          className="btn-primary w-full"
          disabled={(parseRs(amount) ?? 0) <= 0 || pay.isPending}
          onClick={() => pay.mutate()}
        >
          {t('purchasePage.pay')}
        </button>
      </div>
    </Dialog>
  );
}
