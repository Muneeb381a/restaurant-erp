import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { formatRs, ltr } from '../../lib/money';
import { can, useMe } from '../../lib/queries';
import { EmptyRow, ErrorText, Field } from './ui';

interface Summary {
  pending: number;
  retrying: number;
  rejected: number;
  done: number;
}
interface Job {
  id: string;
  docType: 'BILL' | 'CREDIT_NOTE';
  status: string;
  permanent: boolean;
  attempts: number;
  lastError: string | null;
  createdAt: string;
}
interface Reconciliation {
  businessDate: string;
  balanced: boolean;
  taxSoldPaisa: number;
  taxReportedPaisa: number;
  unreported: { id: string; billNo: number; totalPaisa: number; status: string }[];
}
type Settings = Record<string, unknown>;

/** What has been reported to the tax authority, what is stuck, and whether the day balances. */
export function FiscalAdmin() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useMe();
  const manage = can(me.data, 'tax.manage');
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => api<Settings>('/settings'),
    enabled: manage,
  });
  const summary = useQuery({
    queryKey: ['fiscal-summary'],
    queryFn: () => api<Summary>('/fiscal/summary'),
    refetchInterval: 10_000,
  });
  const jobs = useQuery({
    queryKey: ['fiscal-jobs'],
    queryFn: async () => (await api<{ items: Job[] }>('/fiscal/jobs?status=open')).items,
    refetchInterval: 10_000,
  });
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const recon = useQuery({
    queryKey: ['fiscal-recon', date],
    queryFn: () => api<Reconciliation>(`/fiscal/reconciliation?businessDate=${date}`),
    retry: false,
  });

  const provider = (settings.data?.['fiscal.provider'] as string | undefined) ?? 'OFF';
  const setProvider = useMutation({
    mutationFn: (value: string) =>
      api('/settings/fiscal.provider', { method: 'PUT', body: { value } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });
  const retry = useMutation({
    mutationFn: (id: string) => api(`/fiscal/jobs/${id}/retry`, { method: 'POST' }),
    onSuccess: async () => {
      await Promise.all(
        ['fiscal-summary', 'fiscal-jobs', 'fiscal-recon'].map((k) =>
          qc.invalidateQueries({ queryKey: [k] }),
        ),
      );
    },
  });

  const stat = (label: string, n: number | undefined, tone: string) => (
    <div className={`card p-3 text-center ${tone}`}>
      <div className="text-3xl font-bold">{n ?? '…'}</div>
      <div className="text-sm">{label}</div>
    </div>
  );

  return (
    <div className="max-w-6xl space-y-6 p-4 md:p-6">
      <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{t('fiscalPage.notice')}</p>

      {manage && (
        <section className="card space-y-2 p-4">
          <h2 className="text-lg font-bold">{t('fiscalPage.provider')}</h2>
          <div className="flex gap-2">
            {['OFF', 'MOCK'].map((p) => (
              <button
                key={p}
                className={provider === p ? 'btn-primary' : 'btn-secondary'}
                disabled={setProvider.isPending}
                onClick={() => setProvider.mutate(p)}
              >
                {p === 'OFF' ? t('fiscalPage.off') : t('fiscalPage.mock')}
              </button>
            ))}
          </div>
          <p className="text-sm text-slate-500">{t('fiscalPage.providerHint')}</p>
          <ErrorText error={setProvider.error} />
        </section>
      )}

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="fiscal-summary">
        {stat(t('fiscalPage.done'), summary.data?.done, 'text-emerald-800')}
        {stat(t('fiscalPage.pending'), summary.data?.pending, '')}
        {stat(t('fiscalPage.retrying'), summary.data?.retrying, 'text-amber-800')}
        {stat(t('fiscalPage.rejected'), summary.data?.rejected, 'text-rose-700')}
      </section>

      <section className="card space-y-2 p-4">
        <h2 className="text-lg font-bold">{t('fiscalPage.queue')}</h2>
        <ErrorText error={retry.error} />
        <div className="dt">
          <table className="min-w-[32rem]">
            <thead>
              <tr>
                <th>{t('fiscalPage.document')}</th>
                <th>{t('fiscalPage.status')}</th>
                <th className="num">{t('fiscalPage.attemptsHead')}</th>
                <th>{t('fiscalPage.lastError')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(jobs.data ?? []).length === 0 && (
                <EmptyRow cols={5} icon="check" text={t('fiscalPage.empty')} />
              )}
              {(jobs.data ?? []).map((j) => (
                <tr key={j.id}>
                  <td className="name">
                    {j.docType === 'BILL' ? t('fiscalPage.bill') : t('fiscalPage.creditNote')}
                  </td>
                  <td>
                    <span
                      className={
                        j.permanent ? 'chip-bad' : j.status === 'FAILED' ? 'chip-warn' : 'chip-info'
                      }
                    >
                      {j.permanent
                        ? t('fiscalPage.rejected')
                        : j.status === 'FAILED'
                          ? t('fiscalPage.retrying')
                          : t('fiscalPage.pending')}
                    </span>
                  </td>
                  <td className="num">{j.attempts}</td>
                  <td className="max-w-[18rem] truncate text-slate-700">{j.lastError}</td>
                  <td className="text-end">
                    {manage && (
                      <button
                        className="btn-secondary"
                        disabled={retry.isPending}
                        onClick={() => retry.mutate(j.id)}
                      >
                        {t('admin.retry')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card space-y-3 p-4">
        <h2 className="text-lg font-bold">{t('fiscalPage.reconciliation')}</h2>
        <Field label={t('fiscalPage.day')}>
          <input
            type="date"
            className="input w-auto"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
        {recon.isError && <p className="text-slate-500">{t('fiscalPage.noDay')}</p>}
        {recon.data && (
          <>
            <p
              data-testid="recon-status"
              className={`rounded-lg p-2 font-semibold ${recon.data.balanced ? 'bg-emerald-50 text-emerald-900' : 'bg-rose-50 text-rose-800'}`}
            >
              {recon.data.balanced ? t('fiscalPage.balanced') : t('fiscalPage.unbalanced')}
            </p>
            <div className="flex justify-between">
              <span>{t('fiscalPage.taxSold')}</span>
              <span>{ltr(formatRs(recon.data.taxSoldPaisa))}</span>
            </div>
            <div className="flex justify-between">
              <span>{t('fiscalPage.taxReported')}</span>
              <span>{ltr(formatRs(recon.data.taxReportedPaisa))}</span>
            </div>
            {recon.data.unreported.length > 0 && (
              <ul className="list-disc ps-5 text-sm">
                {recon.data.unreported.map((b) => (
                  <li key={b.id}>
                    {t('fiscalPage.bill')} {ltr(`#${b.billNo}`)} · {ltr(formatRs(b.totalPaisa))} ·{' '}
                    {b.status}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
    </div>
  );
}
