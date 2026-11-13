import type { TFunction } from 'i18next';
import { ltr } from './money';

/**
 * How long ago, in the unit a person reads: "45 min", "3 h 05 min", "2 d". A table that has been open
 * for 2801 minutes is hard to take in at a glance; "46 h" (or "1 d") is not.
 */
export function formatAge(minutes: number, t: TFunction): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return ltr(t('age.min', { count: m }));
  if (m < 24 * 60) {
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return ltr(
      rest === 0 ? t('age.h', { h }) : t('age.hm', { h, m: String(rest).padStart(2, '0') }),
    );
  }
  return ltr(t('age.d', { count: Math.floor(m / (24 * 60)) }));
}
