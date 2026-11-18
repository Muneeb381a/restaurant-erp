import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { failedCount, useOutbox, waitingCount } from '../../lib/outbox';
import { runOutbox } from '../../lib/sync';

/**
 * Says what is kept on this device. Orders taken without internet are NOT in the kitchen yet, and the
 * cashier must know that; anything the server refused when it came back is listed for a person to read.
 */
export function OutboxBar({ online }: { online: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const items = useOutbox((s) => s.items);
  const [open, setOpen] = useState(false);
  const waiting = waitingCount(items);
  const failed = failedCount(items);
  if (waiting === 0 && failed === 0) return null;
  const rejected = items.filter((c) => c.state === 'FAILED');

  return (
    <>
      {waiting > 0 && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-amber-100 px-4 py-2 text-sm font-semibold text-amber-950"
        >
          <Icon name="clock" size={18} />
          <span className="me-auto">
            {t('offline.waitingBar', { count: waiting })}{' '}
            {online ? t('offline.sendingNow') : t('offline.kitchenNotTold')}
          </span>
          {online && (
            <button className="btn-secondary px-3" onClick={() => void runOutbox(qc)}>
              {t('offline.retryNow')}
            </button>
          )}
        </div>
      )}
      {failed > 0 && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-rose-600 px-4 py-2 text-sm font-semibold text-white"
        >
          <Icon name="alert" size={18} />
          <span className="me-auto">{t('offline.failedBar', { count: failed })}</span>
          <button
            className="rounded-lg bg-white px-3 py-1.5 font-semibold text-rose-700"
            onClick={() => setOpen(true)}
          >
            {t('offline.review')}
          </button>
        </div>
      )}
      {open && (
        <Modal
          title={t('offline.failedTitle')}
          size="md"
          onClose={() => setOpen(false)}
          footer={
            <button className="btn-secondary" onClick={() => setOpen(false)}>
              {t('common.close')}
            </button>
          }
        >
          <p className="mb-3 text-sm text-slate-700">{t('offline.failedHint')}</p>
          <ul className="divide-y divide-slate-200 rounded-lg border border-slate-300">
            {rejected.map((c) => (
              <li key={c.id} className="space-y-1 p-3">
                <div className="font-medium">
                  {c.kind === 'ADD' ? `${c.qty}× ${c.label}` : c.label}
                </div>
                <p className="text-sm text-rose-700">{c.error}</p>
                <div className="flex gap-2">
                  <Link
                    to={`/order/${c.orderId}`}
                    className="btn-secondary px-3"
                    onClick={() => setOpen(false)}
                  >
                    {t('offline.openOrder')}
                  </Link>
                  <button
                    className="btn-quiet px-3"
                    onClick={() => {
                      useOutbox.getState().retry(c.id);
                      void runOutbox(qc);
                    }}
                  >
                    {t('offline.tryAgain')}
                  </button>
                  <button
                    className="btn-quiet px-3 text-rose-700"
                    onClick={() => useOutbox.getState().remove(c.id)}
                  >
                    {t('offline.forget')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </>
  );
}
