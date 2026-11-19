import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Loader } from '../../components/Loader';
import { api } from '../../lib/api';
import { localDate } from '../../lib/dates';
import { formatRs } from '../../lib/money';
import { ErrorText, PageHead } from './ui';

interface Overview {
  headcount: {
    total: number;
    byStatus: Record<string, number>;
    byDepartment: Record<string, number>;
  };
  today: {
    counts: Record<string, number>;
    notYetIn: { id: string; code: string; fullName: string }[];
    late: { id: string; fullName: string; minutes: number }[];
    onLeave: { id: string; fullName: string }[];
    clockedIn: number;
  };
  month: {
    attendedDays: number;
    absentDays: number;
    absenceRateBps: number;
    lateCount: number;
    lateMinutes: number;
    overtimeMinutes: number;
    topAbsent: { id: string; fullName: string; days: number }[];
    topLate: { id: string; fullName: string; count: number; minutes: number }[];
  };
  leave: { pendingRequests: number };
  money: null | {
    payrollNetPaisa: number;
    approvedRuns: number;
    draftRuns: number;
    salesPaisa: number;
    labourCostBps: number | null;
    owedByStaffPaisa: number;
    peopleWhoOwe: number;
  };
}

/** basis points as a percentage with one decimal ("12.5%"): display only */
const pct = (bps: number): string => `${(bps / 100).toFixed(1)}%`;
const hrs = (min: number): string => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;

function Card({
  title,
  value,
  tone = '',
  hint,
}: {
  title: string;
  value: ReactNode;
  tone?: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-sm text-slate-500">{title}</div>
      <div className={`mt-1 text-2xl font-bold ${tone}`} dir="ltr">
        {value}
      </div>
      {hint && <div className="mt-0.5 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h3 className="mb-2 font-semibold">{title}</h3>
      {children}
    </section>
  );
}

/** Staff at a glance: who is here today, how the month is going, and what the staff cost. */
export function HrOverview() {
  const { t } = useTranslation();
  const [date, setDate] = useState(localDate());
  const month = date.slice(0, 7);
  const q = useQuery({
    queryKey: ['hr-overview', date],
    queryFn: () => api<Overview>(`/hr/overview?date=${date}&month=${month}`),
  });
  const d = q.data;
  return (
    <div className="max-w-6xl space-y-5 p-4 md:p-6">
      <PageHead title={t('overview.title')} hint={t('overview.hint')}>
        <input
          type="date"
          className="input w-auto"
          aria-label={t('hr.date')}
          value={date}
          onChange={(e) => e.target.value && setDate(e.target.value)}
        />
      </PageHead>
      <ErrorText error={q.error} />
      {!d && !q.error && <Loader />}
      {d && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Card
              title={t('hr.st.PRESENT')}
              value={d.today.counts.PRESENT! + d.today.counts.HALF_DAY!}
              tone="text-emerald-700"
              hint={t('overview.inNow', { count: d.today.clockedIn })}
            />
            <Card
              title={t('hr.st.ABSENT')}
              value={d.today.counts.ABSENT}
              tone={d.today.counts.ABSENT ? 'text-rose-700' : ''}
            />
            <Card title={t('hr.st.LEAVE')} value={d.today.counts.LEAVE} />
            <Card
              title={t('hr.notMarked')}
              value={d.today.counts.UNMARKED}
              tone={d.today.counts.UNMARKED ? 'text-amber-700' : ''}
              hint={t('overview.offToday', {
                count: d.today.counts.WEEKLY_OFF! + d.today.counts.HOLIDAY!,
              })}
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Panel title={t('overview.today')}>
              <div className="space-y-3 text-sm">
                {d.today.notYetIn.length > 0 && (
                  <div>
                    <div className="font-medium text-amber-700">{t('overview.notMarkedList')}</div>
                    <div className="text-slate-700">
                      {d.today.notYetIn.map((p) => p.fullName).join(', ')}
                    </div>
                    <Link
                      className="text-emerald-700 underline-offset-2 hover:underline"
                      to="/admin/attendance"
                    >
                      {t('overview.markNow')}
                    </Link>
                  </div>
                )}
                {d.today.late.length > 0 && (
                  <div>
                    <div className="font-medium text-rose-700">{t('overview.lateToday')}</div>
                    <div className="text-slate-700">
                      {d.today.late
                        .map((p) => `${p.fullName} (${p.minutes} ${t('hr.min')})`)
                        .join(', ')}
                    </div>
                  </div>
                )}
                {d.today.onLeave.length > 0 && (
                  <div>
                    <div className="font-medium">{t('overview.onLeaveToday')}</div>
                    <div className="text-slate-700">
                      {d.today.onLeave.map((p) => p.fullName).join(', ')}
                    </div>
                  </div>
                )}
                {d.today.notYetIn.length + d.today.late.length + d.today.onLeave.length === 0 && (
                  <p className="text-slate-500">{t('overview.allGood')}</p>
                )}
                {d.leave.pendingRequests > 0 && (
                  <Link
                    to="/admin/leave"
                    className="block rounded-lg bg-amber-50 p-2 text-amber-900"
                  >
                    {t('overview.pendingLeave', { count: d.leave.pendingRequests })}
                  </Link>
                )}
              </div>
            </Panel>

            <Panel title={t('overview.team', { count: d.headcount.total })}>
              <ul className="space-y-1.5 text-sm">
                {Object.entries(d.headcount.byDepartment)
                  .sort((a, b) => b[1] - a[1])
                  .map(([dept, n]) => (
                    <li key={dept} className="flex items-center gap-3">
                      <span className="w-24 shrink-0 text-slate-600">{t(`hr.dept.${dept}`)}</span>
                      <span
                        className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100"
                        aria-hidden="true"
                      >
                        <span
                          className="block h-full rounded-full bg-emerald-500"
                          style={{
                            width: `${Math.round((n / Math.max(1, d.headcount.total)) * 100)}%`,
                          }}
                        />
                      </span>
                      <span className="w-6 text-end font-semibold">{n}</span>
                    </li>
                  ))}
              </ul>
              {(d.headcount.byStatus.ON_NOTICE ?? 0) > 0 && (
                <p className="mt-2 text-xs text-amber-700">
                  {t('overview.onNotice', { count: d.headcount.byStatus.ON_NOTICE })}
                </p>
              )}
            </Panel>
          </div>

          <h3 className="text-lg font-semibold">
            {t('overview.thisMonth')} · <span dir="ltr">{month}</span>
          </h3>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Card
              title={t('overview.absenceRate')}
              value={pct(d.month.absenceRateBps)}
              hint={t('overview.absentDays', { count: d.month.absentDays })}
            />
            <Card
              title={t('hr.late')}
              value={d.month.lateCount}
              hint={`${d.month.lateMinutes} ${t('hr.min')}`}
            />
            <Card title={t('hr.overtime')} value={`${hrs(d.month.overtimeMinutes)} h`} />
            <Card title={t('overview.attendedDays')} value={d.month.attendedDays} />
          </div>
          {(d.month.topAbsent.length > 0 || d.month.topLate.length > 0) && (
            <div className="grid gap-4 md:grid-cols-2">
              <Panel title={t('overview.mostAbsent')}>
                <ul className="space-y-1 text-sm">
                  {d.month.topAbsent.map((p) => (
                    <li key={p.id} className="flex justify-between">
                      <span>{p.fullName}</span>
                      <b>{p.days}</b>
                    </li>
                  ))}
                  {d.month.topAbsent.length === 0 && <li className="text-slate-500">–</li>}
                </ul>
              </Panel>
              <Panel title={t('overview.mostLate')}>
                <ul className="space-y-1 text-sm">
                  {d.month.topLate.map((p) => (
                    <li key={p.id} className="flex justify-between">
                      <span>{p.fullName}</span>
                      <b>
                        {p.count}× · {p.minutes} {t('hr.min')}
                      </b>
                    </li>
                  ))}
                  {d.month.topLate.length === 0 && <li className="text-slate-500">–</li>}
                </ul>
              </Panel>
            </div>
          )}

          {d.money && (
            <>
              <h3 className="text-lg font-semibold">{t('overview.cost')}</h3>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Card
                  title={t('overview.payrollNet')}
                  value={formatRs(d.money.payrollNetPaisa)}
                  hint={t('overview.runs', {
                    approved: d.money.approvedRuns,
                    draft: d.money.draftRuns,
                  })}
                />
                <Card title={t('overview.sales')} value={formatRs(d.money.salesPaisa)} />
                <Card
                  title={t('overview.labourCost')}
                  value={d.money.labourCostBps === null ? '–' : pct(d.money.labourCostBps)}
                  hint={t('overview.labourHint')}
                />
                <Card
                  title={t('overview.owed')}
                  value={formatRs(d.money.owedByStaffPaisa)}
                  tone={d.money.owedByStaffPaisa ? 'text-amber-700' : ''}
                  hint={t('overview.peopleOwe', { count: d.money.peopleWhoOwe })}
                />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
