import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, api } from '../../lib/api';
import { formatRs, ltr } from '../../lib/money';
import { useFloor } from '../../lib/queries';
import type { Order } from '../../lib/types';

type Mode = 'move' | 'merge' | 'cancel';

/** Move to another table, merge another table's order into this one, or cancel the whole order. */
export function OrderActions({
  order,
  canTransfer,
  canCancel,
  onChanged,
  onCancelled,
}: {
  order: Order;
  canTransfer: boolean;
  canCancel: boolean;
  onChanged: (o: Order) => void;
  onCancelled: () => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode | null>(null);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const floor = useFloor();

  const fail = (e: unknown): void => {
    if (e instanceof ApiError && e.code === 'TABLE_OCCUPIED')
      setMessage(t('orderActions.occupied'));
    else if (e instanceof ApiError && e.code === 'ORDER_HAS_SENT_ITEMS')
      setMessage(t('orderActions.hasSent'));
    else if (e instanceof ApiError && e.code === 'VERSION_CONFLICT')
      setMessage(t('order.conflict'));
    else setMessage(e instanceof ApiError ? e.message : t('common.error'));
  };
  const close = (): void => {
    setMode(null);
    setReason('');
    setMessage(null);
  };

  const move = useMutation({
    mutationFn: (tableId: string) =>
      api<Order>(`/orders/${order.id}/transfer`, {
        method: 'POST',
        body: { tableId },
        ifMatch: order.version,
      }),
    onSuccess: (o) => {
      onChanged(o);
      close();
    },
    onError: fail,
  });
  const merge = useMutation({
    mutationFn: (sourceOrderId: string) =>
      api<Order>(`/orders/${order.id}/merge`, {
        method: 'POST',
        body: { sourceOrderId },
        ifMatch: order.version,
      }),
    onSuccess: (o) => {
      onChanged(o);
      close();
    },
    onError: fail,
  });
  const cancel = useMutation({
    mutationFn: () =>
      api<Order>(`/orders/${order.id}/cancel`, {
        method: 'POST',
        body: { reason: reason.trim() },
        ifMatch: order.version,
      }),
    onSuccess: () => {
      close();
      onCancelled();
    },
    onError: fail,
  });

  const tables = floor.data?.tables ?? [];
  const freeTables = tables.filter((x) => x.status === 'FREE');
  const others = tables.filter(
    (x) => x.order && x.order.id !== order.id && x.status === 'OCCUPIED',
  );

  return (
    <>
      <div className="flex flex-wrap gap-2 border-b border-slate-200 p-2">
        {canTransfer && order.type === 'DINE_IN' && (
          <button className="btn-secondary" onClick={() => setMode('move')}>
            {t('orderActions.move')}
          </button>
        )}
        {canTransfer && order.type === 'DINE_IN' && (
          <button className="btn-secondary" onClick={() => setMode('merge')}>
            {t('orderActions.merge')}
          </button>
        )}
        {canCancel && (
          <button className="btn-secondary text-rose-700" onClick={() => setMode('cancel')}>
            {t('orderActions.cancel')}
          </button>
        )}
      </div>

      {mode && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/50 p-4">
          <div className="card max-h-[90vh] w-full max-w-md space-y-3 overflow-auto p-5">
            <h2 className="text-xl font-bold">{t(`orderActions.${mode}`)}</h2>
            {message && (
              <p role="alert" className="rounded-lg bg-amber-50 p-2 text-sm text-amber-900">
                {message}
              </p>
            )}
            {mode === 'move' && (
              <div className="grid grid-cols-3 gap-2">
                {freeTables.length === 0 && (
                  <p className="col-span-3 text-slate-500">{t('orderActions.noFree')}</p>
                )}
                {freeTables.map((x) => (
                  <button
                    key={x.id}
                    className="btn-secondary"
                    disabled={move.isPending}
                    onClick={() => move.mutate(x.id)}
                  >
                    {ltr(x.code)}
                  </button>
                ))}
              </div>
            )}
            {mode === 'merge' && (
              <ul className="divide-y divide-slate-100">
                {others.length === 0 && (
                  <li className="py-2 text-slate-500">{t('orderActions.noOthers')}</li>
                )}
                {others.map((x) => (
                  <li key={x.id}>
                    <button
                      className="flex min-h-touch w-full items-center gap-2 py-2 text-start"
                      disabled={merge.isPending}
                      onClick={() => merge.mutate(x.order!.id)}
                    >
                      <span className="me-auto font-semibold">{ltr(x.code)}</span>
                      <span className="text-sm text-slate-500">{ltr(`#${x.order!.orderNo}`)}</span>
                      <span>{ltr(formatRs(x.order!.subtotalPaisa))}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {mode === 'cancel' && (
              <>
                <p className="text-sm text-slate-600">{t('orderActions.cancelHint')}</p>
                <input
                  className="input"
                  autoFocus
                  placeholder={t('common.reason')}
                  aria-label={t('common.reason')}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </>
            )}
            <div className="flex gap-2">
              <button className="btn-secondary flex-1" onClick={close}>
                {t('common.cancel')}
              </button>
              {mode === 'cancel' && (
                <button
                  className="btn-danger flex-1"
                  disabled={reason.trim().length < 3 || cancel.isPending}
                  onClick={() => cancel.mutate()}
                >
                  {t('orderActions.cancel')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
