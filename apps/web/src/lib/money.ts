import { asPaisa, formatPaisa } from '@erp/domain';

/**
 * Wraps text that must keep its left-to-right order (amounts, dates, codes) in Unicode
 * directional isolates, so it renders correctly inside Urdu (RTL) sentences: without it
 * "Rs 1,250+" shows as "+Rs 1,250" and "2026-11-10" as "10-11-2026".
 */
export const ltr = (text: string): string => `⁦${text}⁩`;

/**
 * Display only — the UI never computes authoritative totals (CLAUDE.md rule 5); the server's
 * numbers are formatted here. "Rs 1,250" (paisa shown only when non-zero: "Rs 1,250.50").
 */
export function formatRs(paisa: number): string {
  const plain = formatPaisa(asPaisa(paisa)); // "1250.50" / "-3.00"
  const negative = plain.startsWith('-');
  const [whole = '0', frac = '00'] = plain.replace('-', '').split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}Rs ${grouped}${frac === '00' ? '' : `.${frac}`}`;
}

/**
 * Parses what a cashier types ("1500", "1,500.5") into integer paisa without floats.
 * Returns null for anything that is not a plain amount with at most two decimals.
 */
export function parseRs(text: string): number | null {
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text.replace(/,/g, '').trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
}
