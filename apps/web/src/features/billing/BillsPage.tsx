import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { formatRs, ltr } from '../../lib/money';
import type { BillListItem } from '../../lib/types';

/** Find a bill (by number and/or business day) to view, reprint or refund it. */
export function BillsPage() {
  const { t } = useTranslation();
  const [date, setDate] = useState('');
  const [billNo, setBillNo] = useState('');
  const query = new URLSearchParams({
    ...(date ? { businessDate: date } : {}),
    ...(/^\d+$/.test(billNo) ? { billNo } : {}),
  }).toString();
  const list = useQuery({
    queryKey: ['bills', query],
    queryFn: async () => (await api<{ items: BillListItem[] }>(`/bills?${query}`)).items,
  });

  return (
    <div className="mx-auto max-w-3xl space-y-3 p-3">
      <h1 className="text-2xl font-bold">{t('refund.billsTitle')}</h1>
      <div className="flex flex-wrap gap-2">
        <input
          type="date"
          className="input w-auto"
          aria-label={t('refund.date')}
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        <input
          className="input w-40"
          inputMode="numeric"
          placeholder={t('refund.billNo')}
          aria-label={t('refund.billNo')}
          value={billNo}
          onChange={(e) => setBillNo(e.target.value)}
        />
      </div>
      <ul className="card divide-y divide-slate-100">
        {(list.data ?? []).map((b) => (
          <li key={b.id}>
            <Link
              to={`/order/${b.orderId}/pay`}
              className="flex min-h-touch items-center gap-3 p-3"
            >
              <span className="font-semibold">{ltr(`#${b.billNo}`)}</span>
              <span className="text-sm text-slate-500">{ltr(b.businessDate)}</span>
              <span className="ms-auto rounded bg-slate-100 px-2 text-sm">
                {t(`refund.status.${b.status}`)}
              </span>
              <span>{ltr(formatRs(b.totalPaisa))}</span>
            </Link>
          </li>
        ))}
        {list.data?.length === 0 && <li className="p-4 text-slate-500">{t('refund.none')}</li>}
      </ul>
    </div>
  );
}
