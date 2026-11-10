import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, api } from '../../lib/api';
import { formatRs, ltr } from '../../lib/money';
import { usePaymentMethods } from '../../lib/queries';
import type { Bill, RefundPreview, Refundable } from '../../lib/types';

/**
 * Return some or all of a paid bill. The amounts are computed by the server (dry run on every change);
 * this dialog only collects what to return, why, and how the money goes back.
 */
export function RefundDialog({ bill, onClose }: { bill: Bill; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const methods = usePaymentMethods();
  const data = useQuery({
    queryKey: ['refundable', bill.id],
    queryFn: () => api<Refundable>(`/bills/${bill.id}/refundable`),
  });
  const [qty, setQty] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [methodId, setMethodId] = useState('');
  const [reference, setReference] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const key = useRef(`cn-${crypto.randomUUID()}`);

  const chosen = Object.entries(qty)
    .map(([billLineId, v]) => ({ billLineId, qty: Number(v) }))
    .filter((l) => Number.isFinite(l.qty) && l.qty > 0);
  const method = (methods.data ?? []).find((m) => m.id === methodId);

  const preview = useQuery({
    queryKey: ['refund-preview', bill.id, JSON.stringify(chosen), methodId],
    enabled: chosen.length > 0 && !!methodId,
    retry: false,
    queryFn: () =>
      api<RefundPreview>(`/bills/${bill.id}/credit-notes?dryRun=true`, {
        method: 'POST',
        body: { lines: chosen, reason: 'preview', methodId },
      }),
  });

  const submit = useMutation({
    mutationFn: () =>
      api<RefundPreview & { cnNo: number }>(`/bills/${bill.id}/credit-notes`, {
        method: 'POST',
        body: {
          lines: chosen,
          reason: reason.trim(),
          methodId,
          ...(reference.trim() ? { reference: reference.trim() } : {}),
        },
        headers: { 'idempotency-key': key.current },
      }),
    onSuccess: async (out) => {
      setDone(out.totalPaisa);
      await qc.invalidateQueries({ queryKey: ['bill'] });
      await qc.invalidateQueries({ queryKey: ['refundable', bill.id] });
      await qc.invalidateQueries({ queryKey: ['khata'] });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.body.reason === 'DRAWER_INSUFFICIENT_CASH')
        setMessage(t('refund.drawerShort'));
      else if (e instanceof ApiError && e.code === 'KHATA_REFUND_EXCEEDS')
        setMessage(t('refund.khataOnly'));
      else if (e instanceof ApiError && e.code === 'SHIFT_NOT_OPEN')
        setMessage(t('refund.needShift'));
      else if (e instanceof ApiError && e.code === 'NOTHING_TO_REFUND')
        setMessage(t('refund.already'));
      else setMessage(e instanceof ApiError ? e.message : t('common.error'));
    },
  });

  const list = data.data;
  const usable = (methods.data ?? []).filter((m) => m.code !== 'KHATA' || !!bill.khata);
  const valid =
    chosen.length > 0 &&
    reason.trim().length >= 3 &&
    !!method &&
    (!method.needs_reference || reference.trim().length > 0) &&
    preview.isSuccess;

  if (done !== null)
    return (
      <Shell title={t('refund.done')}>
        <div className="text-center text-3xl font-bold">{ltr(formatRs(done))}</div>
        <button className="btn-primary w-full" onClick={onClose}>
          {t('common.close')}
        </button>
      </Shell>
    );

  return (
    <Shell title={t('refund.title')}>
      {message && (
        <p role="alert" className="rounded-lg bg-amber-50 p-2 text-sm text-amber-900">
          {message}
        </p>
      )}
      {!list ? (
        <p>{t('common.loading')}</p>
      ) : (
        <>
          <ul className="divide-y divide-slate-100">
            {list.lines.map((l) => (
              <li key={l.id} className="flex items-center gap-2 py-2">
                <span className="me-auto">
                  {l.description}
                  <span className="ms-2 text-sm text-slate-500">
                    {t('refund.qtyLeft', { n: l.remainingQty })}
                  </span>
                </span>
                <input
                  className="input w-24"
                  inputMode="decimal"
                  aria-label={`${l.description} qty`}
                  disabled={l.remainingQty <= 0}
                  value={qty[l.id] ?? ''}
                  placeholder="0"
                  onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })}
                />
              </li>
            ))}
          </ul>
          <button
            className="btn-secondary w-full"
            onClick={() =>
              setQty(
                Object.fromEntries(
                  list.lines
                    .filter((l) => l.remainingQty > 0)
                    .map((l) => [l.id, String(l.remainingQty)]),
                ),
              )
            }
          >
            {t('refund.returnAll')}
          </button>

          <div className="text-sm font-semibold">{t('refund.method')}</div>
          <div className="flex flex-wrap gap-2">
            {usable.map((m) => (
              <button
                key={m.id}
                className={methodId === m.id ? 'btn-primary' : 'btn-secondary'}
                onClick={() => setMethodId(m.id)}
              >
                {m.name}
              </button>
            ))}
          </div>
          {method?.needs_reference && (
            <input
              className="input"
              placeholder={t('refund.reference')}
              aria-label={t('refund.reference')}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          )}
          <input
            className="input"
            placeholder={t('refund.reason')}
            aria-label={t('refund.reason')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />

          <div className="flex justify-between text-xl font-bold">
            <span>{t('refund.total')}</span>
            <span data-testid="refund-total">
              {preview.data ? ltr(formatRs(preview.data.totalPaisa)) : '—'}
            </span>
          </div>
          {preview.isError && (
            <p className="text-sm text-amber-800">
              {preview.error instanceof ApiError ? preview.error.message : t('common.error')}
            </p>
          )}
        </>
      )}
      <div className="flex gap-2">
        <button className="btn-secondary flex-1" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button
          className="btn-danger flex-1"
          disabled={!valid || submit.isPending}
          onClick={() => submit.mutate()}
        >
          {t('refund.confirm')}
        </button>
      </div>
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center overflow-auto bg-black/50 p-4">
      <div className="card w-full max-w-md space-y-3 p-5">
        <h2 className="text-xl font-bold">{title}</h2>
        {children}
      </div>
    </div>
  );
}
