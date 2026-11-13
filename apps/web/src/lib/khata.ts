import { rs } from '@erp/domain';

/** Whole days from an ISO timestamp to `now` (0 = today); null when there is no date. */
export function daysSince(iso: string | null | undefined, now: Date = new Date()): number | null {
  if (!iso) return null;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  const start = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.max(0, Math.round((start(now) - start(then)) / 86_400_000));
}

/** How old a debt is, as a traffic light: up to 2 weeks is normal, a month is worth a call, two is overdue. */
export function debtAge(days: number | null): 'none' | 'fresh' | 'late' | 'overdue' {
  if (days === null) return 'none';
  if (days > 60) return 'overdue';
  if (days > 30) return 'late';
  return 'fresh';
}

/** How much of the credit limit is used: clear (nothing owed), ok, near (90% or more) or over. */
export function creditUse(
  balancePaisa: number,
  limitPaisa: number,
): { pct: number; state: 'clear' | 'ok' | 'near' | 'over' } {
  if (balancePaisa <= 0) return { pct: 0, state: 'clear' };
  if (limitPaisa <= 0) return { pct: 100, state: 'over' };
  const pct = Math.min(100, (balancePaisa / limitPaisa) * 100);
  if (balancePaisa > limitPaisa) return { pct: 100, state: 'over' };
  return { pct, state: balancePaisa * 10 >= limitPaisa * 9 ? 'near' : 'ok' };
}

/**
 * The message the owner sends to a customer who owes money. Polite and short, with the exact amount;
 * the person taps Send in WhatsApp themselves (nothing is sent from the till).
 */
export function reminderText(
  input: { customer: string; restaurant: string; balancePaisa: number },
  lang: 'en' | 'ur',
): string {
  const amount = rs(input.balancePaisa);
  return lang === 'ur'
    ? `السلام علیکم ${input.customer}، ${input.restaurant} کی طرف سے یاد دہانی: آپ کے کھاتے میں ${amount} بقایا ہیں۔ براہِ مہربانی سہولت سے ادا کر دیجیے۔ شکریہ!`
    : `Assalam o Alaikum ${input.customer}, a friendly reminder from ${input.restaurant}: your khata balance is ${amount}. Please pay when convenient. Thank you!`;
}
