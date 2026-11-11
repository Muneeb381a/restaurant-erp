import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Icon } from '../../components/Icon';
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
      <h1 className="page-title">{t('refund.billsTitle')}</h1>
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1">
          <span className="label block">{t('refund.date')}</span>
          <input
            type="date"
            className="input w-auto"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label className="space-y-1">
          <span className="label block">{t('refund.billNo')}</span>
          <input
            className="input w-40"
            inputMode="numeric"
            value={billNo}
            onChange={(e) => setBillNo(e.target.value)}
          />
        </label>
      </div>
      <ul className="card divide-y divide-slate-200">
        {(list.data ?? []).map((b) => (
          <li key={b.id}>
            <Link
              to={`/order/${b.orderId}/pay`}
              className="flex min-h-touch items-center gap-3 p-3"
            >
              <span className="font-semibold">{ltr(`#${b.billNo}`)}</span>
              <span className="text-sm text-slate-600">{ltr(b.businessDate)}</span>
              <span className={`ms-auto ${b.status === 'SETTLED' ? 'chip-ok' : 'chip-warn'}`}>
                {t(`refund.status.${b.status}`)}
              </span>
              <span className="money w-24 text-end font-semibold">
                {ltr(formatRs(b.totalPaisa))}
              </span>
              <Icon name="chevronRight" size={18} data-flip className="text-slate-500" />
            </Link>
          </li>
        ))}
        {list.data?.length === 0 && <li className="p-4 text-slate-600">{t('refund.none')}</li>}
      </ul>
    </div>
  );
}
