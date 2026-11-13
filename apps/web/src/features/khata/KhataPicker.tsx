import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatRs, ltr } from '../../lib/money';
import { useKhataAccounts } from '../../lib/queries';
import type { KhataAccount } from '../../lib/types';

/** Search-and-pick a khata customer (used on the payment screen). Numbers come from the server. */
export function KhataPicker({
  selected,
  onSelect,
}: {
  selected: KhataAccount | null;
  onSelect: (a: KhataAccount | null) => void;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const list = useKhataAccounts(search);

  if (selected)
    return (
      <div
        className="flex items-center gap-2 rounded-lg bg-slate-50 p-2"
        data-testid="khata-chosen"
      >
        <div className="me-auto">
          <div className="font-semibold">{selected.name}</div>
          <div className="text-sm text-slate-600">
            {t('khata.owes')} {ltr(formatRs(selected.balancePaisa))} · {t('khata.available')}{' '}
            {ltr(formatRs(selected.availableCreditPaisa))}
          </div>
        </div>
        <button className="btn-secondary" onClick={() => onSelect(null)}>
          ×
        </button>
      </div>
    );

  return (
    <div className="space-y-2">
      <input
        className="input"
        placeholder={t('khata.pickCustomer')}
        aria-label={t('khata.search')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <ul className="max-h-48 divide-y divide-slate-100 overflow-auto rounded-lg border border-slate-200">
        {(list.data ?? [])
          .filter((a) => a.isActive)
          .map((a) => (
            <li key={a.id}>
              <button
                className="flex min-h-touch w-full items-center gap-2 p-2 text-start"
                onClick={() => onSelect(a)}
              >
                <span className="me-auto">
                  {a.name}
                  {a.phone ? (
                    <span className="ms-2 text-sm text-slate-500">{ltr(a.phone)}</span>
                  ) : null}
                </span>
                <span className="text-end text-sm text-slate-600">
                  <span className="block">{ltr(formatRs(a.availableCreditPaisa))}</span>
                  {a.balancePaisa > 0 && (
                    <span className="block text-xs text-rose-700">
                      {t('khata.owes')} {ltr(formatRs(a.balancePaisa))}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        {list.data && list.data.length === 0 && (
          <li className="p-2 text-slate-500">{t('khata.none')}</li>
        )}
      </ul>
      <p className="hint">{t('khata.askManager')}</p>
    </div>
  );
}
