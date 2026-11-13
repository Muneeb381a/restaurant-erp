import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { api } from '../../lib/api';
import { formatRs, ltr } from '../../lib/money';
import type { BillListItem } from '../../lib/types';

/** Find a bill (by number and/or business day) to view, reprint or refund it. */
export function BillsPage() {
  const { t } = useTranslation();
  const nav = useNavigate();
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
    <div className="mx-auto max-w-6xl space-y-4 p-4 md:p-6">
      <div>
        <h1 className="page-title">{t('refund.billsTitle')}</h1>
        <p className="hint">{t('refund.billsHint')}</p>
      </div>
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
      <div className="dt">
        <table className="min-w-[28rem]">
          <thead>
            <tr>
              <th>{t('refund.billNo')}</th>
              <th>{t('refund.date')}</th>
              <th>{t('refund.state')}</th>
              <th className="num">{t('bill.total')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(list.data ?? []).map((b) => (
              <tr
                key={b.id}
                className="cursor-pointer"
                onClick={() => nav(`/order/${b.orderId}/pay`)}
              >
                <td className="name">
                  <Link to={`/order/${b.orderId}/pay`} onClick={(e) => e.stopPropagation()}>
                    {ltr(`#${b.billNo}`)}
                  </Link>
                </td>
                <td className="money text-slate-700">{ltr(b.businessDate)}</td>
                <td>
                  <span className={b.status === 'SETTLED' ? 'chip-ok' : 'chip-warn'}>
                    {t(`refund.status.${b.status}`)}
                  </span>
                </td>
                <td className="num font-semibold">{ltr(formatRs(b.totalPaisa))}</td>
                <td className="w-8 text-slate-500">
                  <Icon name="chevronRight" size={18} data-flip />
                </td>
              </tr>
            ))}
            {list.data?.length === 0 && (
              <tr>
                <td colSpan={5} className="!py-10 text-center text-slate-600">
                  {t('refund.none')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
