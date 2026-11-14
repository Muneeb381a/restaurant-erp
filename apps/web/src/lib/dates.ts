/**
 * Today's date on THIS device's clock, as YYYY-MM-DD.
 *
 * Do not use `new Date().toISOString().slice(0, 10)` for this: that is the UTC date, which in Pakistan
 * (UTC+5) is still yesterday between midnight and 5 a.m., exactly when late-night restaurants are open.
 */
export function localDate(d: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
