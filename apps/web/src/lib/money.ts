import { asPaisa, formatPaisa } from '@erp/domain';

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
