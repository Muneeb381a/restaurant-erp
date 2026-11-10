import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { usePrinterHealth } from '../../lib/queries';
import type { PrinterRow, PrintJobRow } from '../../lib/types';
import { Dialog, ErrorText, Field, Toggle, td, th } from './ui';

interface StationRow {
  id: string;
  code: string;
  name: string;
}

const STATE_STYLE: Record<string, string> = {
  OK: 'bg-emerald-100 text-emerald-800',
  OFFLINE: 'bg-rose-100 text-rose-800',
  UNKNOWN: 'bg-slate-100 text-slate-600',
  INACTIVE: 'bg-slate-100 text-slate-500',
};

export function PrintersAdmin() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const printers = useQuery({
    queryKey: ['admin-printers'],
    queryFn: async () => (await api<{ items: PrinterRow[] }>('/printers')).items,
  });
  const health = usePrinterHealth();
  const stations = useQuery({
    queryKey: ['admin-stations'],
    queryFn: async () => (await api<{ items: StationRow[] }>('/stations')).items,
  });
  const mappings = useQueries({
    queries: (stations.data ?? []).map((s) => ({
      queryKey: ['station-printers', s.id],
      queryFn: async () =>
        (await api<{ printerIds: string[] }>(`/stations/${s.id}/printers`)).printerIds,
    })),
  });
  const failed = useQuery({
    queryKey: ['admin-failed-jobs'],
    queryFn: async () => {
      const [dead, retrying] = await Promise.all([
        api<{ items: PrintJobRow[] }>('/print-jobs?status=DEAD'),
        api<{ items: PrintJobRow[] }>('/print-jobs?status=FAILED'),
      ]);
      return [...dead.items, ...retrying.items];
    },
    refetchInterval: 5000,
  });
  const [editing, setEditing] = useState<PrinterRow | 'new' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const refresh = (): Promise<unknown> =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['admin-printers'] }),
      qc.invalidateQueries({ queryKey: ['printers-health'] }),
    ]);

  const testPage = useMutation({
    mutationFn: (id: string) => api(`/printers/${id}/test`, { method: 'POST' }),
    onSuccess: () => {
      setError(null);
      setNotice(t('admin.printersPage.testSent'));
    },
    onError: setError,
  });
  const toggle = useMutation({
    mutationFn: (v: { id: string; on: boolean }) =>
      api(`/printers/${v.id}`, { method: 'PATCH', body: { is_active: v.on } }),
    onSuccess: refresh,
    onError: setError,
  });
  const map = useMutation({
    mutationFn: (v: { stationId: string; printerIds: string[] }) =>
      api(`/stations/${v.stationId}/printers`, {
        method: 'PUT',
        body: { printerIds: v.printerIds },
      }),
    onError: setError,
    // the optimistic tick (see `pending`) is dropped once the server has answered
    onSettled: async (_d, _e, v) => {
      await qc.invalidateQueries({ queryKey: ['station-printers', v.stationId] });
      setPending((p) => Object.fromEntries(Object.entries(p).filter(([id]) => id !== v.stationId)));
    },
  });
  /** Mapping shown immediately after a tap, before the server confirms (rolled back on refetch). */
  const [pending, setPending] = useState<Record<string, string[]>>({});
  const retry = useMutation({
    mutationFn: (id: string) => api(`/print-jobs/${id}/retry`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-failed-jobs'] }),
    onError: setError,
  });

  const healthOf = (id: string) => health.data?.find((h) => h.id === id);
  const kotPrinters = (printers.data ?? []).filter((p) => p.kind === 'KOT' && p.is_active);

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-2">
        <h2 className="me-auto text-xl font-bold">{t('admin.printers')}</h2>
        <button className="btn-primary" onClick={() => setEditing('new')}>
          + {t('admin.printersPage.add')}
        </button>
      </div>
      {notice && (
        <p role="status" className="rounded-lg bg-emerald-50 p-3 text-emerald-800">
          {notice}
        </p>
      )}
      <ErrorText error={error} />

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[44rem] text-sm">
          <thead className="border-b border-slate-200 bg-slate-50">
            <tr>
              <th className={th}>{t('admin.name')}</th>
              <th className={th}>{t('admin.printersPage.connection')}</th>
              <th className={th}>{t('admin.printersPage.paper')}</th>
              <th className={th}>{t('admin.printersPage.state')}</th>
              <th className={th}>{t('admin.printersPage.queued')}</th>
              <th className={th}>{t('admin.active')}</th>
              <th className={th} />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {(printers.data ?? []).map((p) => {
              const h = healthOf(p.id);
              const label = h
                ? t(
                    `admin.printersPage.${h.state.toLowerCase() === 'ok' ? 'ok' : h.state.toLowerCase()}`,
                  )
                : '';
              return (
                <tr key={p.id}>
                  <td className={td}>
                    <div className="font-medium">{p.name}</div>
                    <div className="text-xs text-slate-500">{p.kind}</div>
                  </td>
                  <td className={td}>
                    {p.conn_type}
                    {p.host ? ` · ${p.host}:${p.port}` : ''}
                  </td>
                  <td className={td}>{p.paper_mm}</td>
                  <td className={td}>
                    {h && (
                      <span
                        className={`rounded-full px-2 py-1 text-xs font-semibold ${STATE_STYLE[h.state]}`}
                      >
                        {label}
                      </span>
                    )}
                    {h?.lastError && (
                      <div className="mt-1 max-w-56 text-xs text-rose-700">{h.lastError}</div>
                    )}
                  </td>
                  <td className={td}>{h?.queued ?? 0}</td>
                  <td className={td}>
                    <Toggle
                      on={p.is_active}
                      label={`${t('admin.active')} ${p.name}`}
                      onChange={(on) => toggle.mutate({ id: p.id, on })}
                    />
                  </td>
                  <td className={`${td} whitespace-nowrap`}>
                    <button
                      className="btn-secondary me-1"
                      disabled={!p.is_active || testPage.isPending}
                      onClick={() => testPage.mutate(p.id)}
                      aria-label={`${t('admin.printersPage.test')} ${p.name}`}
                    >
                      {t('admin.printersPage.test')}
                    </button>
                    <button className="btn-secondary" onClick={() => setEditing(p)}>
                      {t('admin.edit')}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <section className="card space-y-2 p-4">
        <h3 className="text-lg font-semibold">{t('admin.printersPage.stations')}</h3>
        <div className="overflow-x-auto">
          <table className="text-sm">
            <thead>
              <tr>
                <th className={th}>{t('admin.station')}</th>
                {kotPrinters.map((p) => (
                  <th key={p.id} className={th}>
                    {p.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(stations.data ?? []).map((s, i) => {
                const mapped = pending[s.id] ?? mappings[i]?.data ?? [];
                return (
                  <tr key={s.id}>
                    <td className={`${td} font-medium`}>{s.code}</td>
                    {kotPrinters.map((p) => (
                      <td key={p.id} className={td}>
                        <input
                          type="checkbox"
                          className="size-6"
                          aria-label={`${s.code} → ${p.name}`}
                          checked={mapped.includes(p.id)}
                          onChange={(e) => {
                            const printerIds = e.target.checked
                              ? [...mapped, p.id]
                              : mapped.filter((x) => x !== p.id);
                            setPending((prev) => ({ ...prev, [s.id]: printerIds }));
                            map.mutate({ stationId: s.id, printerIds });
                          }}
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card space-y-2 p-4">
        <h3 className="text-lg font-semibold">{t('admin.printersPage.failedJobs')}</h3>
        {(failed.data ?? []).length === 0 ? (
          <p className="text-slate-500">{t('admin.printersPage.noFailed')}</p>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {(failed.data ?? []).map((j) => (
              <li key={j.id} className="flex items-center gap-3 py-2">
                <span className="me-auto">
                  <span className="font-medium">{j.title}</span> · {j.status} · {j.attempts}×<br />
                  <span className="text-xs text-rose-700">{j.last_error}</span>
                </span>
                <button
                  className="btn-secondary"
                  disabled={retry.isPending}
                  onClick={() => retry.mutate(j.id)}
                >
                  {t('admin.retry')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {editing && (
        <PrinterDialog
          printer={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onDone={() => void refresh()}
        />
      )}
    </div>
  );
}

function PrinterDialog({
  printer,
  onClose,
  onDone,
}: {
  printer: PrinterRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(printer?.name ?? '');
  const [kind, setKind] = useState<PrinterRow['kind']>(printer?.kind ?? 'KOT');
  const [connType, setConnType] = useState<PrinterRow['conn_type']>(
    printer?.conn_type ?? 'NETWORK',
  );
  const [host, setHost] = useState(printer?.host ?? '');
  const [port, setPort] = useState(String(printer?.port ?? 9100));
  const [paper, setPaper] = useState<58 | 80>(printer?.paper_mm ?? 80);
  const [error, setError] = useState<unknown>(null);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        kind,
        conn_type: connType,
        host: host.trim() || null,
        port: Number(port) || 9100,
        paper_mm: paper,
      };
      return printer
        ? api(`/printers/${printer.id}`, { method: 'PATCH', body })
        : api('/printers', { method: 'POST', body });
    },
    onSuccess: () => {
      onDone();
      onClose();
    },
    onError: setError,
  });

  return (
    <Dialog title={printer ? t('admin.edit') : t('admin.printersPage.add')} onClose={onClose}>
      <div className="space-y-3">
        <Field label={t('admin.name')}>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">
            <select
              className="input"
              value={kind}
              onChange={(e) => setKind(e.target.value as PrinterRow['kind'])}
            >
              <option value="KOT">KOT (kitchen)</option>
              <option value="RECEIPT">Receipt</option>
            </select>
          </Field>
          <Field label={t('admin.printersPage.connection')}>
            <select
              className="input"
              value={connType}
              onChange={(e) => setConnType(e.target.value as PrinterRow['conn_type'])}
            >
              <option value="NETWORK">Network (LAN)</option>
              <option value="USB">USB (not supported yet)</option>
              <option value="SERIAL">Serial (not supported yet)</option>
            </select>
          </Field>
          <Field label={t('admin.printersPage.host')}>
            <input
              className="input"
              inputMode="decimal"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="192.168.1.50"
            />
          </Field>
          <Field label={t('admin.printersPage.port')}>
            <input
              className="input"
              inputMode="numeric"
              value={port}
              onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
            />
          </Field>
          <Field label={t('admin.printersPage.paper')}>
            <select
              className="input"
              value={paper}
              onChange={(e) => setPaper(Number(e.target.value) as 58 | 80)}
            >
              <option value={80}>80</option>
              <option value={58}>58</option>
            </select>
          </Field>
        </div>
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
            {t('admin.save')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
