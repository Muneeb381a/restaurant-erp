import { useTranslation } from 'react-i18next';
import { ApiError } from '../../lib/api';
import { creditUse, daysSince, debtAge } from '../../lib/khata';
import { formatRs, ltr } from '../../lib/money';
import type { KhataAccount } from '../../lib/types';

export const rs = (paisa: number): string => ltr(formatRs(paisa));

export const shortDate = (iso: string, lang: string): string =>
  ltr(
    new Date(iso).toLocaleDateString(lang === 'ur' ? 'ur-PK' : 'en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }),
  );

const BAR = {
  clear: 'bg-slate-300',
  ok: 'bg-emerald-600',
  near: 'bg-amber-500',
  over: 'bg-rose-600',
};
const BAR_DARK = {
  clear: 'bg-slate-500',
  ok: 'bg-emerald-400',
  near: 'bg-amber-400',
  over: 'bg-rose-400',
};

/** How much of the credit limit is used, as a bar (with the numbers beside it unless told not to). */
export function UsageBar({
  a,
  withText = true,
  dark = false,
}: {
  a: Pick<KhataAccount, 'balancePaisa' | 'creditLimitPaisa'>;
  withText?: boolean;
  dark?: boolean;
}) {
  const { t } = useTranslation();
  const u = creditUse(a.balancePaisa, a.creditLimitPaisa);
  return (
    <div className="min-w-[8rem] space-y-1">
      <div
        className={`h-2 overflow-hidden rounded-full ${dark ? 'bg-white/15' : 'bg-slate-200'}`}
        role="img"
        aria-label={`${Math.round(u.pct)}%`}
      >
        <div
          className={`h-full rounded-full ${(dark ? BAR_DARK : BAR)[u.state]}`}
          style={{ width: `${u.pct}%` }}
        />
      </div>
      {withText && (
        <div className="text-xs text-slate-600">
          {t('khata.creditUsed', {
            used: rs(Math.max(a.balancePaisa, 0)),
            limit: rs(a.creditLimitPaisa),
          })}
        </div>
      )}
    </div>
  );
}

/** "34 d" with a colour: how long the oldest unpaid credit has been waiting. */
export function AgeChip({ a }: { a: Pick<KhataAccount, 'balancePaisa' | 'owingSince'> }) {
  const { t } = useTranslation();
  if (a.balancePaisa <= 0)
    return <span className="text-sm text-slate-500">{t('khata.nothingOwed')}</span>;
  const days = daysSince(a.owingSince);
  if (days === null) return <span className="text-slate-500">–</span>;
  const age = debtAge(days);
  return (
    <span className={age === 'overdue' ? 'chip-bad' : age === 'late' ? 'chip-warn' : 'chip-mute'}>
      {days === 0 ? t('khata.ageToday') : ltr(t('khata.ageDays', { n: days }))}
    </span>
  );
}

/** The server's reason in the user's words (the number may already belong to someone). */
export function useExplain(): (e: unknown) => string {
  const { t } = useTranslation();
  return (e) => {
    if (e instanceof ApiError && e.code === 'KHATA_PHONE_EXISTS') {
      const name = typeof e.body.customer === 'string' ? e.body.customer : undefined;
      return name ? t('khata.phoneExists', { name }) : e.message;
    }
    if (e instanceof ApiError && e.code === 'KHATA_OVERPAYMENT') return t('khata.overpay');
    if (e instanceof ApiError && e.code === 'SHIFT_NOT_OPEN') return t('bill.noShift');
    return e instanceof ApiError ? e.message : t('common.error');
  };
}
