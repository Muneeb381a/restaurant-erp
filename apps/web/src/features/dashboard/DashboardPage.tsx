import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { api } from '../../lib/api';
import { formatRs, ltr } from '../../lib/money';
import { Bar, HourChart, KitchenHourChart, TrendChart } from './charts';
import { Modal } from '../../components/Modal';
import { SummaryShare } from '../reports/SummaryShare';
import type { Dashboard } from './types';

type Preset = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'lastMonth' | 'custom';

const pad = (n: number): string => String(n).padStart(2, '0');
const iso = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number): Date =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

function rangeFor(p: Exclude<Preset, 'custom'>): { from: string; to: string } {
  const now = new Date();
  switch (p) {
    case 'today':
      return { from: iso(now), to: iso(now) };
    case 'yesterday':
      return { from: iso(addDays(now, -1)), to: iso(addDays(now, -1)) };
    case '7d':
      return { from: iso(addDays(now, -6)), to: iso(now) };
    case '30d':
      return { from: iso(addDays(now, -29)), to: iso(now) };
    case 'month':
      return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: iso(now) };
    case 'lastMonth':
      return {
        from: iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
        to: iso(new Date(now.getFullYear(), now.getMonth(), 0)),
      };
  }
}

const rs = (paisa: number): string => ltr(formatRs(paisa));
/** Headline figures are shown in whole rupees so seven-digit sums fit; the P&L below has the exact paisa. */
const rsWhole = (paisa: number): string => ltr(formatRs(Math.round(paisa / 100) * 100));
const pct = (bps: number | null): string =>
  bps === null || Math.abs(bps) > 100_000 ? '–' : ltr(`${(bps / 100).toFixed(1)}%`);
const nice = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/** Change against the previous period of the same length. "Good" depends on the metric (lower costs are good). */
function Delta({ cur, prev, good = 'up' }: { cur: number; prev: number; good?: 'up' | 'down' }) {
  const { t } = useTranslation();
  if (prev === 0 && cur === 0)
    return <span className="text-xs text-slate-600">{t('dash.noChange')}</span>;
  if (prev === 0) return <span className="chip-info">{t('dash.new')}</span>;
  const change = ((cur - prev) / Math.abs(prev)) * 100;
  if (Math.abs(change) < 0.05)
    return <span className="text-xs text-slate-600">{t('dash.noChange')}</span>;
  const up = change > 0;
  const ok = good === 'up' ? up : !up;
  return (
    <span className={ok ? 'chip-ok' : 'chip-bad'}>
      <Icon name={up ? 'plus' : 'minus'} size={12} />
      {ltr(`${Math.abs(change).toFixed(change > 99 ? 0 : 1)}%`)}
      <span className="sr-only">{up ? t('dash.up') : t('dash.down')}</span>
    </span>
  );
}

function Kpi({
  label,
  value,
  delta,
  sub,
  tone,
}: {
  label: string;
  value: string;
  delta?: ReactNode;
  sub?: ReactNode;
  tone?: 'bad' | 'ok';
}) {
  return (
    <div className="card min-w-0 space-y-1.5 p-4">
      <div className="micro">{label}</div>
      <div
        className={`money whitespace-nowrap text-[clamp(1.3rem,1.9vw,1.9rem)] font-semibold tracking-tight ${tone === 'bad' ? 'text-rose-700' : tone === 'ok' ? 'text-emerald-700' : ''}`}
      >
        {value}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
        {delta}
        {sub}
      </div>
    </div>
  );
}

function Card({
  title,
  hint,
  children,
  className = '',
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card min-w-0 space-y-3 p-4 ${className}`}>
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        {hint && <p className="hint">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Line({
  label,
  value,
  strong,
  indent,
  tone,
  note,
}: {
  label: string;
  value: string;
  strong?: boolean;
  indent?: boolean;
  tone?: 'bad' | 'ok';
  note?: string;
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-3 py-1.5 ${strong ? 'border-t border-slate-300 pt-2 font-semibold' : ''} ${indent ? 'ps-4 text-slate-700' : ''}`}
    >
      <dt className="min-w-0">
        {label}
        {note && <span className="block text-xs font-normal text-slate-600">{note}</span>}
      </dt>
      <dd
        className={`money shrink-0 ${tone === 'bad' ? 'text-rose-700' : tone === 'ok' ? 'text-emerald-700' : ''}`}
      >
        {value}
      </dd>
    </div>
  );
}

const TYPE_KEY = {
  DINE_IN: 'dash.dineIn',
  TAKEAWAY: 'order.takeaway',
  DELIVERY: 'order.delivery',
} as const;

export function DashboardPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [preset, setPreset] = useState<Preset>('today');
  const [sharing, setSharing] = useState<string | null>(null);
  const [custom, setCustom] = useState(() => rangeFor('7d'));
  const range = preset === 'custom' ? custom : rangeFor(preset);
  const q = useQuery({
    queryKey: ['dashboard', range.from, range.to],
    queryFn: () => api<Dashboard>(`/reports/dashboard?from=${range.from}&to=${range.to}`),
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  });
  const d = q.data;
  const presets: { key: Preset; label: string }[] = [
    { key: 'today', label: t('dash.today') },
    { key: 'yesterday', label: t('dash.yesterday') },
    { key: '7d', label: t('dash.last7') },
    { key: '30d', label: t('dash.last30') },
    { key: 'month', label: t('dash.thisMonth') },
    { key: 'lastMonth', label: t('dash.lastMonth') },
    { key: 'custom', label: t('dash.custom') },
  ];

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="me-auto">
          <h1 className="page-title">{t('dash.title')}</h1>
          <p className="hint">
            {d
              ? `${ltr(d.range.from)}${d.range.from === d.range.to ? '' : ` → ${ltr(d.range.to)}`} · ${t('dash.vs', { from: ltr(d.previousRange.from), to: ltr(d.previousRange.to) })}`
              : t('common.loading')}
          </p>
        </div>
        {d && d.range.from === d.range.to && (
          <button className="btn-secondary" onClick={() => setSharing(d.range.to)}>
            <Icon name="receipt" size={18} />
            {t('summary.share')}
          </button>
        )}
        <div className="seg max-w-full overflow-x-auto" role="group" aria-label={t('dash.period')}>
          {presets.map((p) => (
            <button
              key={p.key}
              className="seg-item shrink-0 whitespace-nowrap"
              aria-pressed={preset === p.key}
              onClick={() => setPreset(p.key)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {preset === 'custom' && (
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1">
            <span className="label block">{t('dash.from')}</span>
            <input
              type="date"
              className="input w-auto"
              value={custom.from}
              max={custom.to}
              onChange={(e) => e.target.value && setCustom({ ...custom, from: e.target.value })}
            />
          </label>
          <label className="space-y-1">
            <span className="label block">{t('dash.to')}</span>
            <input
              type="date"
              className="input w-auto"
              value={custom.to}
              min={custom.from}
              onChange={(e) => e.target.value && setCustom({ ...custom, to: e.target.value })}
            />
          </label>
        </div>
      )}

      {q.isError && (
        <p role="alert" className="rounded-lg bg-rose-50 p-3 text-rose-700">
          {t('common.error')}
        </p>
      )}
      {!d && !q.isError && <p className="p-6 text-center text-slate-600">{t('common.loading')}</p>}

      {d && <Body d={d} lang={lang} />}
      {sharing && (
        <Modal title={t('summary.title')} onClose={() => setSharing(null)}>
          <SummaryShare date={sharing} />
        </Modal>
      )}
    </div>
  );
}

function Body({ d, lang }: { d: Dashboard; lang: string }) {
  const { t } = useTranslation();
  const c = d.current;
  const p = d.previous;
  const empty = c.bills === 0 && c.expensesPaisa === 0;
  const maxMethod = Math.max(...d.payments.map((m) => m.amountPaisa), 1);
  const maxCat = Math.max(...d.categories.map((x) => x.revenuePaisa), 1);
  const maxType = Math.max(...d.orderTypes.map((x) => x.salesPaisa), 1);
  const maxExp = Math.max(...d.expensesByCategory.map((x) => x.totalPaisa), 1);
  const cashSales = d.payments.filter((m) => m.isCash).reduce((n, m) => n + m.amountPaisa, 0);
  const creditSales = d.payments.filter((m) => m.isCredit).reduce((n, m) => n + m.amountPaisa, 0);
  const digital = d.payments
    .filter((m) => !m.isCash && !m.isCredit)
    .reduce((n, m) => n + m.amountPaisa, 0);
  const collected = cashSales + creditSales + digital;
  const ctl = d.controls;
  const k = d.kitchen;
  const maxStation = Math.max(...k.stations.map((x) => x.avgTotalSec), 1);
  const dur = (sec: number): string =>
    ltr(sec < 60 ? t('dash.underMin') : t('dash.minutes', { count: Math.round(sec / 60) }));
  const discountBps =
    c.grossSalesPaisa > 0 ? Math.round((ctl.discountPaisa * 10_000) / c.grossSalesPaisa) : 0;
  // "where each Rs 100 went": share of net sales as costs and profit (display only)
  const net = c.netSalesPaisa;
  const foodPct = net > 0 ? Math.min(100, (c.costOfFoodPaisa / net) * 100) : 0;
  const expPct = net > 0 ? Math.min(100 - foodPct, (c.expensesPaisa / net) * 100) : 0;
  const profitPct = net > 0 ? Math.max(0, 100 - foodPct - expPct) : 0;

  return (
    <>
      {empty && (
        <div className="flex items-start gap-3 rounded-xl border border-slate-300 bg-white p-4 text-slate-700">
          <Icon name="info" />
          <p>{t('dash.empty')}</p>
        </div>
      )}

      {/* headline numbers */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi
          label={t('dash.netSales')}
          value={rsWhole(c.netSalesPaisa)}
          delta={<Delta cur={c.netSalesPaisa} prev={p.netSalesPaisa} />}
          sub={t('dash.billsN', { count: c.bills })}
        />
        <Kpi
          label={t('dash.netProfit')}
          value={rsWhole(c.netProfitPaisa)}
          tone={c.netProfitPaisa < 0 ? 'bad' : c.bills > 0 ? 'ok' : undefined}
          delta={<Delta cur={c.netProfitPaisa} prev={p.netProfitPaisa} />}
          sub={c.netMarginBps !== null ? t('dash.margin', { pct: pct(c.netMarginBps) }) : undefined}
        />
        <Kpi
          label={t('dash.expenses')}
          value={rsWhole(c.expensesPaisa)}
          delta={<Delta cur={c.expensesPaisa} prev={p.expensesPaisa} good="down" />}
          sub={t('dash.expensesSub')}
        />
        <Kpi
          label={t('dash.foodCost')}
          value={pct(c.foodCostBps)}
          delta={<Delta cur={c.foodCostBps ?? 0} prev={p.foodCostBps ?? 0} good="down" />}
          sub={t('dash.foodCostSub', { amount: rsWhole(c.costOfFoodPaisa) })}
        />
        <Kpi
          label={t('dash.avgBill')}
          value={rsWhole(c.avgBillPaisa)}
          delta={<Delta cur={c.avgBillPaisa} prev={p.avgBillPaisa} />}
          sub={
            c.covers > 0
              ? t('dash.perGuest', { amount: rs(Math.round(net / c.covers)) })
              : undefined
          }
        />
      </div>

      {c.uncostedLines > 0 && (
        <div
          role="note"
          className="flex items-start gap-3 rounded-xl border border-amber-400 bg-amber-50 p-3 text-amber-900"
        >
          <Icon name="alert" />
          <p className="text-sm">{t('dash.uncosted', { count: c.uncostedLines })}</p>
        </div>
      )}

      {/* profit and loss + where the money went */}
      <div className="grid gap-3 lg:grid-cols-5">
        <Card className="lg:col-span-3" title={t('dash.pl')} hint={t('dash.plHint')}>
          <dl className="divide-y divide-slate-100">
            <Line
              label={t('dash.grossSales')}
              value={rs(c.grossSalesPaisa)}
              note={t('dash.grossSalesNote')}
            />
            <Line indent label={t('dash.discounts')} value={rs(-c.discountPaisa)} />
            <Line indent label={t('dash.service')} value={rs(c.servicePaisa)} />
            <Line indent label={t('dash.refunds')} value={rs(-c.refundsPaisa)} />
            <Line strong label={t('dash.netSales')} value={rs(c.netSalesPaisa)} />
            <Line
              indent
              label={t('dash.costOfFood')}
              value={rs(-c.costOfFoodPaisa)}
              note={t('dash.costOfFoodNote')}
            />
            <Line
              strong
              label={t('dash.grossProfit')}
              value={rs(c.grossProfitPaisa)}
              tone={c.grossProfitPaisa < 0 ? 'bad' : undefined}
            />
            {d.expensesByCategory.map((e) => (
              <Line key={e.category} indent label={nice(e.category)} value={rs(-e.totalPaisa)} />
            ))}
            {d.expensesByCategory.length === 0 && (
              <Line indent label={t('dash.expenses')} value={rs(0)} note={t('dash.noExpenses')} />
            )}
            <Line
              strong
              label={t('dash.netProfit')}
              value={rs(c.netProfitPaisa)}
              tone={c.netProfitPaisa < 0 ? 'bad' : 'ok'}
            />
          </dl>
          <p className="hint">{t('dash.taxNote', { amount: rs(c.taxPaisa) })}</p>
          {d.range.days < 28 && c.expensesPaisa > 0 && (
            <p className="chip-info whitespace-normal">{t('dash.tip')}</p>
          )}
        </Card>

        <div className="space-y-3 lg:col-span-2">
          <Card title={t('dash.rs100')} hint={t('dash.rs100Hint')}>
            {net > 0 ? (
              <>
                <div
                  className="flex h-9 overflow-hidden rounded-lg"
                  role="img"
                  aria-label={t('dash.rs100Aria', {
                    food: foodPct.toFixed(0),
                    exp: expPct.toFixed(0),
                    profit: profitPct.toFixed(0),
                  })}
                >
                  <div className="bg-amber-400" style={{ width: `${foodPct}%` }} />
                  <div className="bg-sky-500" style={{ width: `${expPct}%` }} />
                  <div className="bg-emerald-600" style={{ width: `${profitPct}%` }} />
                </div>
                <ul className="space-y-1.5 text-sm">
                  <li className="flex items-center gap-2">
                    <span className="size-3 rounded-sm bg-amber-400" />
                    {t('dash.costOfFood')}
                    <span className="money ms-auto font-semibold">
                      {ltr(`Rs ${foodPct.toFixed(0)}`)}
                    </span>
                  </li>
                  <li className="flex items-center gap-2">
                    <span className="size-3 rounded-sm bg-sky-500" />
                    {t('dash.expenses')}
                    <span className="money ms-auto font-semibold">
                      {ltr(`Rs ${expPct.toFixed(0)}`)}
                    </span>
                  </li>
                  <li className="flex items-center gap-2">
                    <span className="size-3 rounded-sm bg-emerald-600" />
                    {t('dash.profit')}
                    <span className="money ms-auto font-semibold">
                      {ltr(`Rs ${profitPct.toFixed(0)}`)}
                    </span>
                  </li>
                </ul>
                {c.netProfitPaisa < 0 && <p className="chip-bad">{t('dash.lossNote')}</p>}
              </>
            ) : (
              <p className="hint">{t('dash.noSalesYet')}</p>
            )}
          </Card>
          <Card title={t('dash.expensesByCat')}>
            {d.expensesByCategory.length === 0 ? (
              <p className="hint">{t('dash.noExpenses')}</p>
            ) : (
              <div className="space-y-3">
                {d.expensesByCategory.map((e) => (
                  <Bar
                    key={e.category}
                    label={nice(e.category)}
                    value={e.totalPaisa}
                    max={maxExp}
                    tone="bg-sky-500"
                    right={rs(e.totalPaisa)}
                  />
                ))}
              </div>
            )}
            <p className="hint">{t('dash.purchasesNote', { amount: rs(c.purchasesPaisa) })}</p>
          </Card>
        </div>
      </div>

      {/* trend + hours */}
      <div className="grid gap-3 lg:grid-cols-5">
        {d.range.days > 1 && (
          <Card className="lg:col-span-3" title={t('dash.trend')} hint={t('dash.trendHint')}>
            <TrendChart data={d.daily} lang={lang} />
            <div className="flex flex-wrap gap-4 text-sm text-slate-700">
              <span className="flex items-center gap-2">
                <span className="size-3 rounded-sm bg-emerald-500" />
                {t('dash.netSales')}
              </span>
              <span className="flex items-center gap-2">
                <span className="h-0.5 w-4 bg-amber-500" />
                {t('dash.gross')}
              </span>
            </div>
          </Card>
        )}
        <Card
          className={d.range.days > 1 ? 'lg:col-span-2' : 'lg:col-span-5'}
          title={d.range.days > 1 ? t('dash.hours') : t('dash.byHour')}
          hint={t('dash.hoursHint')}
        >
          <HourChart data={d.hourly} />
        </Card>
      </div>

      {/* payments, channels, categories */}
      <div className="grid gap-3 lg:grid-cols-3">
        <Card title={t('dash.payments')} hint={t('dash.paymentsHint')}>
          {d.payments.length === 0 ? (
            <p className="hint">{t('dash.noSalesYet')}</p>
          ) : (
            <div className="space-y-3">
              {d.payments.map((m) => (
                <Bar
                  key={m.code}
                  label={m.method}
                  value={m.amountPaisa}
                  max={maxMethod}
                  tone={m.isCash ? 'bg-emerald-600' : m.isCredit ? 'bg-amber-400' : 'bg-sky-500'}
                  right={rs(m.amountPaisa)}
                  sub={`${pct(m.shareBps)} · ${t('dash.billsN', { count: m.count })}${m.isCredit ? ` · ${t('dash.onCredit')}` : ''}`}
                />
              ))}
              <dl className="mt-2 divide-y divide-slate-100 border-t border-slate-200 pt-1 text-sm">
                <Line label={t('dash.cash')} value={rs(cashSales)} />
                <Line label={t('dash.digital')} value={rs(digital)} />
                <Line label={t('dash.credit')} value={rs(creditSales)} />
                <Line strong label={t('dash.collected')} value={rs(collected)} />
              </dl>
            </div>
          )}
        </Card>
        <Card title={t('dash.channels')}>
          {d.orderTypes.length === 0 ? (
            <p className="hint">{t('dash.noSalesYet')}</p>
          ) : (
            <div className="space-y-3">
              {d.orderTypes.map((x) => (
                <Bar
                  key={x.type}
                  label={t(TYPE_KEY[x.type])}
                  value={x.salesPaisa}
                  max={maxType}
                  right={rs(x.salesPaisa)}
                  sub={t('dash.billsN', { count: x.bills })}
                />
              ))}
            </div>
          )}
        </Card>
        <Card title={t('dash.categories')}>
          {d.categories.length === 0 ? (
            <p className="hint">{t('dash.noSalesYet')}</p>
          ) : (
            <div className="space-y-3">
              {d.categories.slice(0, 7).map((x) => (
                <Bar
                  key={x.name}
                  label={x.name}
                  value={x.revenuePaisa}
                  max={maxCat}
                  right={rs(x.revenuePaisa)}
                />
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* menu performance */}
      <div className="grid gap-3 lg:grid-cols-5">
        <Card className="lg:col-span-3" title={t('dash.topItems')} hint={t('dash.topItemsHint')}>
          {d.topItems.length === 0 ? (
            <p className="hint">{t('dash.noSalesYet')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[28rem] text-sm">
                <thead>
                  <tr className="micro text-start">
                    <th className="py-1.5 text-start">{t('dash.item')}</th>
                    <th className="py-1.5 text-end">{t('dash.sold')}</th>
                    <th className="py-1.5 text-end">{t('dash.sales')}</th>
                    <th className="py-1.5 text-end">{t('dash.margin2')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {d.topItems.map((i, k) => (
                    <tr key={i.name}>
                      <td className="py-2 pe-2 font-medium">
                        <span className="me-2 text-slate-500">{ltr(String(k + 1))}</span>
                        {i.name}
                      </td>
                      <td className="money py-2 text-end">
                        {ltr(String(Math.round(i.qty * 10) / 10))}
                      </td>
                      <td className="money py-2 text-end">{rs(i.revenuePaisa)}</td>
                      <td className="money py-2 text-end">
                        {i.costPaisa > 0
                          ? pct(Math.round((i.marginPaisa * 10_000) / i.revenuePaisa))
                          : '–'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card className="lg:col-span-2" title={t('dash.slow')} hint={t('dash.slowHint')}>
          {d.slowItems.length === 0 ? (
            <p className="hint">{t('dash.noSalesYet')}</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {d.slowItems.map((i) => (
                <li key={i.name} className="flex items-baseline justify-between gap-3 py-2">
                  <span className="min-w-0 truncate font-medium">{i.name}</span>
                  <span className="money shrink-0 text-slate-700">
                    {t('dash.soldN', { count: Math.round(i.qty * 10) / 10 })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* how fast the kitchen is */}
      <Card title={t('dash.kitchen')} hint={t('dash.kitchenHint')}>
        {k.timedTickets === 0 ? (
          <p className="hint">{t('dash.kitchenNone', { sent: k.ticketsSent })}</p>
        ) : (
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Mini
                label={t('dash.kMedian')}
                value={dur(k.medianTotalSec)}
                sub={t('dash.kMedianSub', { n: k.timedTickets })}
              />
              <Mini label={t('dash.kWait')} value={dur(k.avgWaitSec)} sub={t('dash.kWaitSub')} />
              <Mini label={t('dash.kCook')} value={dur(k.avgCookSec)} sub={t('dash.kCookSub')} />
              <Mini
                label={t('dash.kSlowest')}
                value={dur(k.p90TotalSec)}
                sub={t('dash.kSlowestSub', { pct: pct(k.over25MinBps) })}
              />
            </div>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              {k.previousMedianTotalSec !== null && (
                <span className="flex items-center gap-2">
                  <Delta cur={k.medianTotalSec} prev={k.previousMedianTotalSec} good="down" />
                  <span className="text-slate-600">{t('dash.vsPrev')}</span>
                </span>
              )}
              <span className="chip-ok">{t('dash.kFast', { pct: pct(k.within15MinBps) })}</span>
            </div>
            <div className="grid gap-5 lg:grid-cols-2">
              <div className="space-y-3">
                <h3 className="micro">{t('dash.kStations')}</h3>
                {k.stations.map((x) => (
                  <Bar
                    key={x.station}
                    label={x.station}
                    value={x.avgTotalSec}
                    max={maxStation}
                    tone={
                      x.avgTotalSec > 1500
                        ? 'bg-rose-500'
                        : x.avgTotalSec > 1200
                          ? 'bg-amber-500'
                          : 'bg-emerald-500'
                    }
                    right={dur(x.avgTotalSec)}
                    sub={t('dash.kStationSub', {
                      count: x.tickets,
                      wait: Math.round(x.avgWaitSec / 60),
                      cook: Math.round(x.avgCookSec / 60),
                    })}
                  />
                ))}
              </div>
              <div className="space-y-3">
                <h3 className="micro">{t('dash.kHours')}</h3>
                <KitchenHourChart data={k.hours} />
              </div>
            </div>
            {(k.untimedTickets > 0 || k.ignoredTickets > 0) && (
              <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                {t('dash.kCaveat', { untimed: k.untimedTickets, ignored: k.ignoredTickets })}
              </p>
            )}
          </div>
        )}
      </Card>

      {/* leaks and controls */}
      <Card title={t('dash.controls')} hint={t('dash.controlsHint')}>
        <div className="grid gap-x-6 sm:grid-cols-2 lg:grid-cols-3">
          <Control
            label={t('dash.cDiscounts')}
            value={rs(ctl.discountPaisa)}
            detail={t('dash.cDiscountsD', {
              bills: ctl.discountBills,
              pct: pct(discountBps),
              approved: ctl.discountsApprovedByManager,
            })}
            flag={discountBps > 500 ? 'warn' : undefined}
          />
          <Control
            label={t('dash.cVoids')}
            value={rs(ctl.voidedAfterKitchenPaisa)}
            detail={t('dash.cVoidsD', { count: ctl.voidedAfterKitchenLines })}
            flag={ctl.voidedAfterKitchenLines > 0 ? 'info' : undefined}
          />
          <Control
            label={t('dash.cComps')}
            value={rs(ctl.complimentaryPaisa)}
            detail={t('dash.cCompsD', { count: ctl.complimentaryLines })}
          />
          <Control
            label={t('dash.cRefunds')}
            value={rs(ctl.refundPaisa)}
            detail={t('dash.cRefundsD', { count: ctl.refundCount })}
            flag={ctl.refundCount > 0 ? 'info' : undefined}
          />
          <Control
            label={t('dash.cNoSale')}
            value={ltr(String(ctl.noSaleOpens))}
            detail={t('dash.cNoSaleD')}
            flag={ctl.noSaleOpens > 3 ? 'warn' : undefined}
          />
          <Control
            label={t('dash.cPaidOut')}
            value={rs(ctl.paidOutPaisa)}
            detail={t('dash.cPaidOutD')}
          />
          <Control
            label={t('dash.cCash')}
            value={rs(ctl.cashDifferencePaisa)}
            detail={t('dash.cCashD', { off: ctl.shiftsWithDifference, total: ctl.closedShifts })}
            flag={ctl.cashShortPaisa < 0 ? 'bad' : undefined}
          />
          <Control
            label={t('dash.cWaste')}
            value={rs(ctl.wastagePaisa)}
            detail={t('dash.cWasteD')}
          />
          <Control
            label={t('dash.cStaff')}
            value={rs(ctl.staffMealPaisa)}
            detail={t('dash.cStaffD')}
          />
        </div>
        {d.waiters.length > 0 && (
          <div className="overflow-x-auto border-t border-slate-200 pt-3">
            <div className="micro mb-1">{t('dash.byCashier')}</div>
            <table className="w-full min-w-[22rem] text-sm">
              <tbody className="divide-y divide-slate-100">
                {d.waiters.map((w) => (
                  <tr key={w.name}>
                    <td className="py-1.5 font-medium">{w.name}</td>
                    <td className="py-1.5 text-end">{t('dash.billsN', { count: w.bills })}</td>
                    <td className="money py-1.5 text-end">
                      {t('dash.discountGiven', { amount: rs(w.discountPaisa) })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* the balance sheet side: what is owed and what is on the shelf right now */}
      <Card title={t('dash.position')} hint={t('dash.positionHint')}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Mini
            label={t('dash.khataOwed')}
            value={rs(d.position.khataOwedToUsPaisa)}
            sub={t('dash.accountsN', { count: d.position.khataAccountsOwing })}
          />
          <Mini
            label={t('dash.suppliersOwed')}
            value={rs(d.position.owedToSuppliersPaisa)}
            sub={t('dash.suppliersN', { count: d.position.suppliersOwed })}
          />
          <Mini
            label={t('dash.stockValue')}
            value={rs(d.position.stockValuePaisa)}
            sub={t('dash.lowN', { count: d.position.lowStockCount })}
          />
          <Mini
            label={t('dash.openNow')}
            value={ltr(String(d.position.openOrders))}
            sub={t('dash.openTablesN', { count: d.position.openTables })}
          />
        </div>
        {d.position.lowStock.length > 0 && (
          <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
            <div className="font-semibold">{t('dash.reorder')}</div>
            <p>
              {d.position.lowStock
                .map((i) => `${i.name} (${ltr(`${i.onHand} ${i.uom}`)})`)
                .join(' · ')}
            </p>
          </div>
        )}
      </Card>

      <details className="card p-4 text-sm">
        <summary className="cursor-pointer font-semibold">{t('dash.howTitle')}</summary>
        <ul className="mt-2 list-disc space-y-1 ps-5 text-slate-700">
          <li>{t('dash.how1')}</li>
          <li>{t('dash.how2')}</li>
          <li>{t('dash.how3')}</li>
          <li>{t('dash.how4')}</li>
          <li>{t('dash.how5')}</li>
        </ul>
      </details>
    </>
  );
}

function Control({
  label,
  value,
  detail,
  flag,
}: {
  label: string;
  value: string;
  detail: string;
  flag?: 'info' | 'warn' | 'bad';
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-start justify-between gap-3 border-b border-slate-200 py-3">
      <div className="min-w-0">
        <div className="font-medium">{label}</div>
        <div className="text-xs text-slate-600">{detail}</div>
      </div>
      <div className="shrink-0 text-end">
        <div className="money font-semibold">{value}</div>
        {flag === 'warn' && <span className="chip-warn">{t('dash.watch')}</span>}
        {flag === 'bad' && <span className="chip-bad">{t('dash.check')}</span>}
      </div>
    </div>
  );
}

function Mini({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="panel space-y-1 p-3">
      <div className="micro">{label}</div>
      <div className="money text-xl font-semibold">{value}</div>
      <div className="text-xs text-slate-600">{sub}</div>
    </div>
  );
}
