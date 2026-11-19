import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { toast } from '../../components/Toast';
import { api } from '../../lib/api';
import { apiBase, appOrigin } from '../../lib/tenant';
import { downloadText, installerBatch } from './printHelperInstaller';
import { ErrorText } from './ui';

interface Agent {
  id: string;
  name: string;
  computer: string | null;
  lastSeenAt: string | null;
  online: boolean;
  printersSeen: { name: string; isDefault?: boolean }[];
  printers: {
    id: string;
    kind: 'RECEIPT' | 'KOT';
    windowsName: string | null;
    lastError: string | null;
  }[];
  queued: number;
}

/**
 * Printing without setup. A website cannot see or reach a printer, so a small "print helper" runs on the
 * counter computer: the owner downloads one file and opens it once. It finds the printer by itself,
 * prints receipts and kitchen tickets as soon as they are made, and when it is switched off the app falls
 * back to the browser's print window, so a receipt is never lost.
 */
export function PrintHelp() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const agents = useQuery({
    queryKey: ['print-agents'],
    queryFn: async () => (await api<{ items: Agent[] }>('/print-agents')).items,
    refetchInterval: 4000,
  });
  const [downloaded, setDownloaded] = useState(false);
  const refresh = (): Promise<void> => qc.invalidateQueries({ queryKey: ['print-agents'] });

  /** The server's address as this counter computer must call it (the helper needs the full address). */
  const serverUrl = `${new URL(appOrigin()).origin}${apiBase()}`;

  const create = useMutation({
    mutationFn: (name: string) =>
      api<{ id: string; key: string }>('/print-agents', { method: 'POST', body: { name } }),
    onSuccess: async (out) => {
      downloadText('Install print helper.bat', installerBatch({ url: serverUrl, key: out.key }));
      setDownloaded(true);
      await refresh();
    },
  });
  const choose = useMutation({
    mutationFn: (v: { id: string; printer: string }) =>
      api(`/print-agents/${v.id}`, { method: 'PATCH', body: { printer: v.printer } }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/print-agents/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      setDownloaded(false);
      await refresh();
    },
  });
  const testPage = useMutation({
    mutationFn: (printerId: string) =>
      api(`/printers/${printerId}/test`, { method: 'POST', body: {} }),
    onSuccess: () => toast(t('printHelp.testSent')),
  });

  const list = agents.data ?? [];

  return (
    <div className="space-y-4 text-sm">
      {list.length === 0 && (
        <div className="space-y-3">
          <p>{t('printHelp.intro')}</p>
          <ol className="list-decimal space-y-1 ps-5 text-slate-700">
            <li>{t('printHelp.step1')}</li>
            <li>{t('printHelp.step2')}</li>
            <li>{t('printHelp.step3')}</li>
          </ol>
          <button
            className="btn-primary btn-lg"
            disabled={create.isPending}
            onClick={() => create.mutate(t('printHelp.defaultName'))}
          >
            <Icon name="printer" size={20} />
            {t('printHelp.setup')}
          </button>
          <ErrorText error={create.error} />
        </div>
      )}

      {list.map((a) => {
        const receipt = a.printers.find((p) => p.kind === 'RECEIPT');
        const current = receipt?.windowsName ?? '';
        const problem = a.printers.find((p) => p.lastError)?.lastError;
        return (
          <div key={a.id} className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <span
                className={`flex size-10 items-center justify-center rounded-xl ${a.online ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-800'}`}
              >
                <Icon name="printer" size={20} />
              </span>
              <div className="me-auto min-w-0">
                <div className="font-semibold">{a.computer ?? a.name}</div>
                <div className={a.online ? 'text-emerald-700' : 'text-amber-800'}>
                  <span
                    aria-hidden="true"
                    className={`me-1.5 inline-block size-2 rounded-full ${a.online ? 'bg-emerald-500' : 'animate-pulse bg-amber-500'}`}
                  />
                  {a.online
                    ? t('printHelp.connected')
                    : a.lastSeenAt
                      ? t('printHelp.offline')
                      : t('printHelp.waiting')}
                </div>
              </div>
              <button
                className="btn-secondary min-h-9 px-3 text-sm"
                disabled={!a.online || !receipt || testPage.isPending}
                onClick={() => receipt && testPage.mutate(receipt.id)}
              >
                {t('printHelp.testPage')}
              </button>
              <button
                className="btn-danger-quiet min-h-9 px-3 text-sm"
                disabled={remove.isPending}
                onClick={() => remove.mutate(a.id)}
              >
                {t('printHelp.remove')}
              </button>
            </div>

            {a.printersSeen.length > 0 && (
              <label className="block space-y-1">
                <span className="label">{t('printHelp.printerUsed')}</span>
                <select
                  className="input max-w-sm"
                  value={current}
                  onChange={(e) => choose.mutate({ id: a.id, printer: e.target.value })}
                >
                  {a.printersSeen.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <span className="hint block">{t('printHelp.printerAuto')}</span>
              </label>
            )}
            {a.online && a.printersSeen.length === 0 && (
              <p className="rounded-lg bg-amber-50 p-2 text-amber-900">
                {t('printHelp.noPrinter')}
              </p>
            )}
            {a.queued > 0 && (
              <p className="text-slate-700">{t('printHelp.queued', { count: a.queued })}</p>
            )}
            {problem && <p className="text-rose-700">{t('printHelp.problem', { why: problem })}</p>}
            {!a.online && !a.lastSeenAt && downloaded && (
              <p className="rounded-lg bg-sky-50 p-2 text-sky-900">{t('printHelp.openFile')}</p>
            )}
            {!a.online && a.lastSeenAt && <p className="hint">{t('printHelp.offlineHint')}</p>}
          </div>
        );
      })}
      <ErrorText error={remove.error ?? choose.error ?? testPage.error} />

      <details className="rounded-lg border border-slate-200 p-3">
        <summary className="cursor-pointer font-medium text-slate-700">
          {t('printHelp.withoutTitle')}
        </summary>
        <p className="mt-2 text-slate-600">{t('printHelp.without')}</p>
      </details>
    </div>
  );
}
