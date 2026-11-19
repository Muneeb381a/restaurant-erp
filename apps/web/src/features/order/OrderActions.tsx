import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon, type IconName } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { ApiError, api } from '../../lib/api';
import { formatRs, ltr } from '../../lib/money';
import { useFloor } from '../../lib/queries';
import type { Order } from '../../lib/types';

type Mode = 'move' | 'merge' | 'cancel';

/**
 * Everything that is not "add items / send / bill" lives behind one "More" menu, so the cart only
 * ever shows the one thing to do next: hold, move table, merge tables, cancel the order.
 */
export function OrderActions({
  order,
  canTransfer,
  canCancel,
  holdBusy,
  onHold,
  onChanged,
  onCancelled,
}: {
  order: Order;
  canTransfer: boolean;
  canCancel: boolean;
  holdBusy: boolean;
  onHold: () => void;
  onChanged: (o: Order) => void;
  onCancelled: () => void;
}) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState(false);
  const [mode, setMode] = useState<Mode | null>(null);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const floor = useFloor();
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const down = (e: MouseEvent): void => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setMenu(false);
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(false);
    };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [menu]);

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

  const entries: { key: string; icon: IconName; label: string; tone?: 'bad'; run: () => void }[] = [
    {
      key: 'hold',
      icon: 'pause',
      label: order.held ? t('order.resume') : t('order.hold'),
      run: onHold,
    },
  ];
  if (canTransfer && order.type === 'DINE_IN') {
    entries.push({
      key: 'move',
      icon: 'swap',
      label: t('orderActions.move'),
      run: () => setMode('move'),
    });
    entries.push({
      key: 'merge',
      icon: 'merge',
      label: t('orderActions.merge'),
      run: () => setMode('merge'),
    });
  }
  if (canCancel)
    entries.push({
      key: 'cancel',
      icon: 'trash',
      label: t('orderActions.cancel'),
      tone: 'bad',
      run: () => setMode('cancel'),
    });

  return (
    <div className="relative" ref={wrap}>
      <button
        type="button"
        className="btn-secondary px-3"
        aria-haspopup="menu"
        aria-expanded={menu}
        aria-label={t('order.more')}
        disabled={holdBusy}
        onClick={() => setMenu(!menu)}
      >
        <Icon name="more" />
        <span className="hidden sm:inline">{t('order.more')}</span>
      </button>
      {menu && (
        <div
          role="menu"
          className="absolute end-0 z-30 mt-1 w-72 rounded-xl border border-slate-300 bg-white p-1.5 shadow-sheet"
        >
          {entries.map((en) => (
            <button
              key={en.key}
              type="button"
              role="menuitem"
              className={`flex min-h-touch w-full items-center gap-3 rounded-md px-3 text-start hover:bg-slate-100 ${en.tone === 'bad' ? 'text-rose-700' : ''}`}
              onClick={() => {
                setMenu(false);
                en.run();
              }}
            >
              <Icon name={en.icon} size={20} />
              {en.label}
            </button>
          ))}
        </div>
      )}

      {mode && (
        <Modal
          title={t(`orderActions.${mode}`)}
          onClose={close}
          footer={
            <>
              <button className="btn-secondary" onClick={close}>
                {t('common.cancel')}
              </button>
              {mode === 'cancel' && (
                <button
                  className="btn-danger"
                  disabled={reason.trim().length < 3 || cancel.isPending}
                  onClick={() => cancel.mutate()}
                >
                  {t('orderActions.cancel')}
                </button>
              )}
            </>
          }
        >
          {message && (
            <p role="alert" className="mb-3 rounded-lg bg-amber-50 p-2 text-sm text-amber-900">
              {message}
            </p>
          )}
          {mode === 'move' && (
            <>
              <p className="hint mb-3">{t('orderActions.moveHint')}</p>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {freeTables.length === 0 && (
                  <p className="col-span-full text-slate-600">{t('orderActions.noFree')}</p>
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
            </>
          )}
          {mode === 'merge' && (
            <>
              <p className="hint mb-2">{t('orderActions.mergeHint')}</p>
              <ul className="divide-y divide-slate-200">
                {others.length === 0 && (
                  <li className="py-2 text-slate-600">{t('orderActions.noOthers')}</li>
                )}
                {others.map((x) => (
                  <li key={x.id}>
                    <button
                      className="flex min-h-touch w-full items-center gap-2 py-2 text-start"
                      disabled={merge.isPending}
                      onClick={() => merge.mutate(x.order!.id)}
                    >
                      <span className="me-auto font-semibold">{ltr(x.code)}</span>
                      <span className="text-sm text-slate-600">
                        {t('order.token')} {ltr(String(x.order!.orderNo))}
                      </span>
                      <span className="money">{ltr(formatRs(x.order!.subtotalPaisa))}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {mode === 'cancel' && (
            <div className="space-y-2">
              <p className="hint">{t('orderActions.cancelHint')}</p>
              <input
                className="input"
                autoFocus
                placeholder={t('common.reason')}
                aria-label={t('common.reason')}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
