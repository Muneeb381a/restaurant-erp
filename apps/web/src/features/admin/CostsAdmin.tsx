import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { localDate } from '../../lib/dates';
import { formatRs, ltr, parseRs } from '../../lib/money';
import { can, useMe } from '../../lib/queries';
import type { ExpenseList, FoodCostReport } from '../../lib/types';
import { EmptyRow, ErrorText, Field, PageHead } from './ui';

const SOURCES = ['DRAWER_CASH', 'OWNER_CASH', 'BANK'] as const;
const today = (): string => localDate();
const monthStart = (): string => `${today().slice(0, 8)}01`;
const newKey = (): string => `ui-${crypto.randomUUID()}`;

/** Food cost per item and the restaurant's expenses for a date range. */
export function CostsAdmin() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const food = useQuery({
    queryKey: ['food-cost', from, to],
    queryFn: () => api<FoodCostReport>(`/inventory/food-cost?from=${from}&to=${to}`),
    enabled: can(me.data, 'report.financial'),
  });
  const expenses = useQuery({
    queryKey: ['expenses', from, to],
    queryFn: () => api<ExpenseList>(`/expenses?from=${from}&to=${to}`),
  });

  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState('');
  const [paidFrom, setPaidFrom] = useState<(typeof SOURCES)[number]>('BANK');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const key = useRef(newKey());
  const add = useMutation({
    mutationFn: () =>
      api('/expenses', {
        method: 'POST',
        body: {
          category: category.trim(),
          amountPaisa: parseRs(amount) ?? 0,
          paidFrom,
          ...(note.trim() ? { note: note.trim() } : {}),
        },
        headers: { 'idempotency-key': key.current },
      }),
    onSuccess: async () => {
      setMessage(t('costPage.added'));
      setCategory('');
      setAmount('');
      setNote('');
      key.current = newKey();
      await qc.invalidateQueries({ queryKey: ['expenses'] });
    },
  });
  const uncosted = (food.data?.items ?? []).reduce((n, i) => n + i.uncostedLines, 0);

  return (
    <div className="max-w-6xl space-y-6 p-4 md:p-6">
      <PageHead title={t('costPage.title')} hint={t('costPage.hint')}>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('costPage.from')}>
            <input
              type="date"
              className="input w-auto"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </Field>
          <Field label={t('costPage.to')}>
            <input
              type="date"
              className="input w-auto"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </Field>
        </div>
      </PageHead>

      {food.data && (
        <section className="card space-y-3 p-4">
          <h2 className="text-lg font-bold">{t('costPage.foodCost')}</h2>
          <div
            className="grid grid-cols-2 gap-3 text-center sm:grid-cols-4"
            data-testid="food-cost-totals"
          >
            <Stat
              label={t('costPage.revenue')}
              value={ltr(formatRs(food.data.totals.revenuePaisa))}
            />
            <Stat label={t('costPage.cost')} value={ltr(formatRs(food.data.totals.costPaisa))} />
            <Stat
              label={t('costPage.margin')}
              value={ltr(formatRs(food.data.totals.marginPaisa))}
            />
            <Stat
              label={t('costPage.pct')}
              value={ltr(`${(food.data.totals.foodCostBps / 100).toFixed(1)}%`)}
            />
          </div>
          <div className="flex flex-wrap gap-4 text-sm text-slate-600">
            <span>
              {t('costPage.wastage')}: {ltr(formatRs(food.data.wastagePaisa))}
            </span>
            <span>
              {t('costPage.staffMeals')}: {ltr(formatRs(food.data.staffMealPaisa))}
            </span>
            {uncosted > 0 && (
              <span className="text-amber-800">{t('costPage.uncosted', { n: uncosted })}</span>
            )}
          </div>
          <div className="dt">
            <table className="min-w-[32rem]">
              <thead>
                <tr>
                  <th>{t('costPage.item')}</th>
                  <th className="num">{t('costPage.qty')}</th>
                  <th className="num">{t('costPage.revenue')}</th>
                  <th className="num">{t('costPage.cost')}</th>
                  <th className="num">{t('costPage.pct')}</th>
                </tr>
              </thead>
              <tbody>
                {food.data.items.map((i) => {
                  const tone =
                    i.costPaisa === 0
                      ? ''
                      : i.foodCostBps <= 3000
                        ? 'chip-ok'
                        : i.foodCostBps <= 4000
                          ? 'chip-warn'
                          : 'chip-bad';
                  return (
                    <tr key={i.itemId}>
                      <td className="name">{i.name}</td>
                      <td className="num">{ltr(String(i.qty))}</td>
                      <td className="num">{ltr(formatRs(i.revenuePaisa))}</td>
                      <td className="num">{ltr(formatRs(i.costPaisa))}</td>
                      <td className="num">
                        {i.costPaisa > 0 ? (
                          <span className={tone}>
                            {ltr(`${(i.foodCostBps / 100).toFixed(1)}%`)}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  );
                })}
                {food.data.items.length === 0 && (
                  <EmptyRow cols={5} icon="chart" text={t('costPage.noSales')} />
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card space-y-3 p-4">
        <h2 className="text-lg font-semibold">{t('costPage.expenses')}</h2>
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t('costPage.category')}>
            <input
              className="input w-40"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            />
          </Field>
          <Field label={t('costPage.amount')}>
            <input
              className="input w-36"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <Field label={t('costPage.paidFrom')}>
            <select
              className="input w-44"
              value={paidFrom}
              onChange={(e) => setPaidFrom(e.target.value as (typeof SOURCES)[number])}
            >
              {SOURCES.map((s) => (
                <option key={s} value={s}>
                  {t(`costPage.${s}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('costPage.note')}>
            <input className="input w-48" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <button
            className="btn-primary"
            disabled={!category.trim() || (parseRs(amount) ?? 0) <= 0 || add.isPending}
            onClick={() => add.mutate()}
          >
            {t('costPage.add')}
          </button>
        </div>
        {message && (
          <p role="status" className="rounded-lg bg-emerald-50 p-2 text-emerald-900">
            {message}
          </p>
        )}
        <ErrorText error={add.error} />
        {expenses.data && (
          <>
            <div className="flex items-baseline justify-between rounded-lg bg-slate-100 px-4 py-3 text-lg font-semibold">
              <span>{t('costPage.total')}</span>
              <span data-testid="expense-total">{ltr(formatRs(expenses.data.totalPaisa))}</span>
            </div>
            <div className="dt">
              <table className="min-w-[28rem]">
                <thead>
                  <tr>
                    <th>{t('costPage.category')}</th>
                    <th>{t('costPage.note')}</th>
                    <th className="num">{t('costPage.amount')}</th>
                  </tr>
                </thead>
                <tbody>
                  {expenses.data.items.map((e) => (
                    <tr key={e.id}>
                      <td>
                        <span className="chip-mute">{e.category}</span>
                      </td>
                      <td className="text-slate-700">{e.note}</td>
                      <td className="num">{ltr(formatRs(e.amountPaisa))}</td>
                    </tr>
                  ))}
                  {expenses.data.items.length === 0 && (
                    <EmptyRow cols={3} icon="cash" text={t('costPage.noExpenses')} />
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-300 bg-slate-50 p-3 text-start">
      <div className="micro">{label}</div>
      <div className="money text-xl font-semibold">{value}</div>
    </div>
  );
}
