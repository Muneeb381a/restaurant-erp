import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { Loader } from '../../components/Loader';
import { ApiError, api } from '../../lib/api';
import { localDate } from '../../lib/dates';
import { formatRs, ltr } from '../../lib/money';
import type { BillListItem } from '../../lib/types';

type Preset = 'TODAY' | 'YESTERDAY' | 'WEEK' | 'PICK' | 'ALL';
type Status = 'ALL' | 'SETTLED' | 'PRE_BILLED';

const LIMIT = 500;

const daysAgo = (n: number): string => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localDate(d);
};

/** "Wed 18 Nov" for a YYYY-MM-DD date. */
const dayLabel = (iso: string, lang: string): string =>
  new Date(`${iso}T12:00:00`).toLocaleDateString(lang === 'ur' ? 'ur-PK' : 'en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
  });

/** The calendar days a preset covers, in the shop's time (the bill's own day, not the business-day label). */
function range(preset: Preset, picked: string): { from?: string; to?: string } {
  switch (preset) {
    case 'TODAY':
      return { from: daysAgo(0), to: daysAgo(0) };
    case 'YESTERDAY':
      return { from: daysAgo(1), to: daysAgo(1) };
    case 'WEEK':
      return { from: daysAgo(6), to: daysAgo(0) };
    case 'PICK':
      return picked ? { from: picked, to: picked } : {};
    default:
      return {};
  }
}

/** Find a bill to view, reprint or refund it: by day, by status, or by bill number / token / table / name. */
export function BillsPage() {
  const { t, i18n } = useTranslation();
  const [preset, setPreset] = useState<Preset>('WEEK');
  const [picked, setPicked] = useState(daysAgo(0));
  const [status, setStatus] = useState<Status>('ALL');
  const [search, setSearch] = useState('');
  const term = search.trim();

  const { from, to } = range(preset, picked);
  const query = new URLSearchParams({
    limit: String(LIMIT),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(status !== 'ALL' ? { status } : {}),
    ...(term ? { search: term } : {}),
  }).toString();
  const list = useQuery({
    queryKey: ['bills', query],
    queryFn: async () => (await api<{ items: BillListItem[] }>(`/bills?${query}`)).items,
    placeholderData: (previous) => previous,
  });

  const items = useMemo(() => list.data ?? [], [list.data]);
  const paid = items.filter((b) => b.status === 'SETTLED');
  const waiting = items.filter((b) => b.status === 'PRE_BILLED');
  const paidTotal = paid.reduce((n, b) => n + b.totalPaisa, 0);
  const waitingTotal = waiting.reduce((n, b) => n + b.totalPaisa, 0);
  const average = paid.length ? Math.round(paidTotal / paid.length) : 0;

  // one block per calendar day, newest first (the list already comes newest first)
  const days = useMemo(() => {
    const out: { date: string; bills: BillListItem[] }[] = [];
    for (const b of items) {
      const last = out[out.length - 1];
      if (last && last.date === b.billedOn) last.bills.push(b);
      else out.push({ date: b.billedOn, bills: [b] });
    }
    return out;
  }, [items]);

  const presets: { key: Preset; label: string }[] = [
    { key: 'TODAY', label: t('billsPage.today') },
    { key: 'YESTERDAY', label: t('billsPage.yesterday') },
    { key: 'WEEK', label: t('billsPage.last7') },
    { key: 'ALL', label: t('billsPage.all') },
    { key: 'PICK', label: t('billsPage.pickDate') },
  ];
  const statuses: { key: Status; label: string }[] = [
    { key: 'ALL', label: t('common.all') },
    { key: 'SETTLED', label: t('refund.status.SETTLED') },
    { key: 'PRE_BILLED', label: t('refund.status.PRE_BILLED') },
  ];
  const clock = (iso: string | null): string =>
    iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

  const offline = list.isError && list.error instanceof ApiError && list.error.code === 'OFFLINE';

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-6">
      <div>
        <h1 className="page-title">{t('refund.billsTitle')}</h1>
        <p className="hint">{t('refund.billsHint')}</p>
      </div>

      {/* what the list adds up to */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="card p-3">
          <div className="micro">{t('billsPage.paidTotal')}</div>
          <div className="money mt-1 text-xl font-semibold text-emerald-700 sm:text-2xl">
            {ltr(formatRs(paidTotal))}
          </div>
          <div className="mt-0.5 text-xs text-slate-500">
            {t('billsPage.dayLine', { count: paid.length })}
          </div>
        </div>
        <div className="card p-3">
          <div className="micro">{t('billsPage.average')}</div>
          <div className="money mt-1 text-xl font-semibold sm:text-2xl">
            {ltr(formatRs(average))}
          </div>
        </div>
        <div className="card p-3">
          <div className="micro">{t('billsPage.waiting')}</div>
          <div
            className={`money mt-1 text-xl font-semibold sm:text-2xl ${waiting.length ? 'text-amber-700' : ''}`}
          >
            {waiting.length}
          </div>
          {waiting.length > 0 && (
            <div className="mt-0.5 text-xs text-amber-700">{ltr(formatRs(waitingTotal))}</div>
          )}
        </div>
        <div className="card p-3">
          <div className="micro">{t('billsPage.bills')}</div>
          <div className="money mt-1 text-xl font-semibold sm:text-2xl">{items.length}</div>
        </div>
      </div>

      <div className="space-y-3">
        <div className="relative">
          <Icon
            name="search"
            size={18}
            className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-slate-500"
          />
          <input
            className="input ps-10"
            placeholder={t('billsPage.search')}
            aria-label={t('billsPage.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="seg" role="group" aria-label={t('refund.date')}>
            {presets.map((p) => (
              <button
                key={p.key}
                className="seg-item"
                aria-pressed={preset === p.key}
                onClick={() => setPreset(p.key)}
              >
                {p.label}
              </button>
            ))}
          </div>
          {preset === 'PICK' && (
            <input
              type="date"
              className="input w-auto"
              aria-label={t('refund.date')}
              value={picked}
              onChange={(e) => setPicked(e.target.value)}
            />
          )}
          <div className="seg ms-auto" role="group" aria-label={t('refund.state')}>
            {statuses.map((x) => (
              <button
                key={x.key}
                className="seg-item"
                aria-pressed={status === x.key}
                onClick={() => setStatus(x.key)}
              >
                {x.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {list.isError && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-xl bg-rose-50 p-3 text-rose-800"
        >
          <Icon name="alert" size={20} />
          <span className="min-w-0 flex-1 text-sm">
            {offline ? t('billsPage.offlineNote') : t('billsPage.loadFailed')}
          </span>
          <button className="btn-secondary" onClick={() => void list.refetch()}>
            {t('billsPage.retry')}
          </button>
        </div>
      )}

      {days.map((d) => {
        const dayPaid = d.bills
          .filter((b) => b.status === 'SETTLED')
          .reduce((n, b) => n + b.totalPaisa, 0);
        return (
          <section key={d.date} className="space-y-2">
            <div className="flex items-baseline gap-3 px-1">
              <h2 className="text-base font-semibold text-slate-900">
                {dayLabel(d.date, i18n.language)}
              </h2>
              <span className="text-sm text-slate-500">
                {t('billsPage.dayLine', { count: d.bills.length })}
              </span>
              <span className="money ms-auto text-sm font-semibold text-slate-800">
                {ltr(formatRs(dayPaid))}
              </span>
            </div>
            <ul className="card divide-y divide-slate-100 overflow-hidden">
              {d.bills.map((b) => {
                const paidBill = b.status === 'SETTLED';
                const where = b.tableCode
                  ? `${t('order.table')} ${b.tableCode}`
                  : b.orderType === 'DELIVERY'
                    ? t('order.delivery')
                    : t('order.takeaway');
                const when = clock(b.settledAt ?? b.createdAt);
                return (
                  <li key={b.id}>
                    <Link
                      to={`/order/${b.orderId}/pay`}
                      className="flex min-h-16 items-center gap-3 px-4 py-3 transition-colors hover:bg-slate-50"
                    >
                      <span
                        className={`flex size-11 shrink-0 items-center justify-center rounded-xl ${paidBill ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-800'}`}
                      >
                        <Icon name="receipt" size={22} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="text-base font-semibold">{ltr(`#${b.billNo}`)}</span>
                          <span className="chip bg-slate-100 text-slate-700">{where}</span>
                          {b.orderNo ? (
                            <span className="chip bg-slate-100 text-slate-700">
                              {t('billsPage.token')} {ltr(String(b.orderNo))}
                            </span>
                          ) : null}
                          {b.refunded && (
                            <span className="chip-bad">{t('billsPage.refunded')}</span>
                          )}
                        </span>
                        <span className="mt-0.5 block truncate text-sm text-slate-500">
                          {when && <span className="money">{ltr(when)}</span>}
                          {b.customerName ? ` · ${b.customerName}` : ''}
                          {b.methods.length > 0 && ` · ${b.methods.join(', ')}`}
                          {!paidBill && ` · ${t('billsPage.notPaidYet')}`}
                        </span>
                      </span>
                      <span className="text-end">
                        <span className="money block text-lg font-semibold">
                          {ltr(formatRs(b.totalPaisa))}
                        </span>
                        <span className={paidBill ? 'chip-ok' : 'chip-warn'}>
                          {t(`refund.status.${b.status}`)}
                        </span>
                      </span>
                      <Icon
                        name="chevronRight"
                        size={18}
                        data-flip
                        className="shrink-0 text-slate-400"
                      />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}

      {items.length >= LIMIT && (
        <p className="text-center text-sm text-slate-500">
          {t('billsPage.moreHint', { count: LIMIT })}
        </p>
      )}

      {list.isSuccess && items.length === 0 && (
        <div className="card flex flex-col items-center gap-3 p-10 text-center text-slate-600">
          <span className="flex size-14 items-center justify-center rounded-full bg-slate-100 text-slate-500">
            <Icon name="receipt" size={26} />
          </span>
          {preset !== 'ALL' && !term ? t('billsPage.emptyDay') : t('refund.none')}
          {preset !== 'WEEK' && preset !== 'ALL' && (
            <button className="btn-secondary" onClick={() => setPreset('WEEK')}>
              {t('billsPage.showRecent')}
            </button>
          )}
        </div>
      )}
      {list.isPending && <Loader />}
    </div>
  );
}
