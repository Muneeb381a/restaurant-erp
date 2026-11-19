import { useQuery } from '@tanstack/react-query';
import { Loader } from '../../components/Loader';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { api } from '../../lib/api';
import { localDate } from '../../lib/dates';
import { formatRs, ltr } from '../../lib/money';
import type { BillListItem } from '../../lib/types';

type Preset = 'ALL' | 'TODAY' | 'YESTERDAY' | 'PICK';
type Status = 'ALL' | 'SETTLED' | 'PRE_BILLED';

const daysAgo = (n: number): string => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localDate(d);
};

/** "Wed 18 Nov" for a YYYY-MM-DD business date. */
const dayLabel = (iso: string, lang: string): string =>
  new Date(`${iso}T12:00:00`).toLocaleDateString(lang === 'ur' ? 'ur-PK' : 'en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });

/** Find a bill (by number and/or business day) to view, reprint or refund it. */
export function BillsPage() {
  const { t, i18n } = useTranslation();
  const [preset, setPreset] = useState<Preset>('ALL');
  const [picked, setPicked] = useState('');
  const [status, setStatus] = useState<Status>('ALL');
  const [billNo, setBillNo] = useState('');
  const date =
    preset === 'TODAY'
      ? daysAgo(0)
      : preset === 'YESTERDAY'
        ? daysAgo(1)
        : preset === 'PICK'
          ? picked
          : '';
  const query = new URLSearchParams({
    limit: '200',
    ...(date ? { businessDate: date } : {}),
    ...(/^\d+$/.test(billNo) ? { billNo } : {}),
  }).toString();
  const list = useQuery({
    queryKey: ['bills', query],
    queryFn: async () => (await api<{ items: BillListItem[] }>(`/bills?${query}`)).items,
  });

  const items = useMemo(
    () => (list.data ?? []).filter((b) => status === 'ALL' || b.status === status),
    [list.data, status],
  );
  const paid = items.filter((b) => b.status === 'SETTLED');
  const waiting = items.filter((b) => b.status === 'PRE_BILLED');
  const paidTotal = paid.reduce((n, b) => n + b.totalPaisa, 0);

  // one block per business day, newest first (the list already comes in that order)
  const days = useMemo(() => {
    const out: { date: string; bills: BillListItem[] }[] = [];
    for (const b of items) {
      const last = out[out.length - 1];
      if (last && last.date === b.businessDate) last.bills.push(b);
      else out.push({ date: b.businessDate, bills: [b] });
    }
    return out;
  }, [items]);

  const presets: { key: Preset; label: string }[] = [
    { key: 'ALL', label: t('billsPage.recent') },
    { key: 'TODAY', label: t('billsPage.today') },
    { key: 'YESTERDAY', label: t('billsPage.yesterday') },
    { key: 'PICK', label: t('billsPage.pickDate') },
  ];
  const statuses: { key: Status; label: string }[] = [
    { key: 'ALL', label: t('common.all') },
    { key: 'SETTLED', label: t('refund.status.SETTLED') },
    { key: 'PRE_BILLED', label: t('refund.status.PRE_BILLED') },
  ];
  const clock = (iso: string | null): string =>
    iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-6">
      <div>
        <h1 className="page-title">{t('refund.billsTitle')}</h1>
        <p className="hint">{t('refund.billsHint')}</p>
      </div>

      {/* what the list adds up to */}
      <div className="grid grid-cols-3 gap-3">
        <div className="card p-3">
          <div className="micro">{t('billsPage.bills')}</div>
          <div className="money mt-1 text-xl font-semibold sm:text-2xl">{items.length}</div>
        </div>
        <div className="card p-3">
          <div className="micro">{t('billsPage.paidTotal')}</div>
          <div className="money mt-1 text-xl font-semibold text-emerald-700 sm:text-2xl">
            {ltr(formatRs(paidTotal))}
          </div>
        </div>
        <div className="card p-3">
          <div className="micro">{t('billsPage.waiting')}</div>
          <div
            className={`money mt-1 text-xl font-semibold sm:text-2xl ${waiting.length ? 'text-amber-700' : ''}`}
          >
            {waiting.length}
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-56">
            <Icon
              name="search"
              size={18}
              className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-slate-500"
            />
            <input
              className="input ps-10"
              inputMode="numeric"
              placeholder={t('billsPage.findNo')}
              aria-label={t('refund.billNo')}
              value={billNo}
              onChange={(e) => setBillNo(e.target.value)}
            />
          </div>
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
                          {b.refunded && (
                            <span className="chip-bad">{t('billsPage.refunded')}</span>
                          )}
                        </span>
                        <span className="mt-0.5 block truncate text-sm text-slate-500">
                          {clock(b.settledAt) && (
                            <span className="money">{ltr(clock(b.settledAt))}</span>
                          )}
                          {clock(b.settledAt) && b.methods.length > 0 && ' · '}
                          {b.methods.join(', ')}
                          {!paidBill && t('billsPage.notPaidYet')}
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

      {list.isSuccess && items.length === 0 && (
        <div className="card flex flex-col items-center gap-2 p-10 text-center text-slate-600">
          <span className="flex size-14 items-center justify-center rounded-full bg-slate-100 text-slate-500">
            <Icon name="receipt" size={26} />
          </span>
          {t('refund.none')}
        </div>
      )}
      {list.isPending && <Loader />}
    </div>
  );
}
