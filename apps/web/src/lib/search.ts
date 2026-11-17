/**
 * Menu search that forgives how people type. Urdu has several look-alike letters that keyboards
 * produce differently (ی ي ى, ک ك, ہ ه ھ), marks that are optional (zabar, zer), and Arabic-Indic or
 * Persian digits; English has capitals and accents. All of these are folded together, and every word
 * the person typed must be found somewhere in the dish ("tikka leg" finds "Chicken Tikka (Leg)").
 */
export function normalizeText(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ًͯ-ٰٟـ‌‍]/g, '') // accents, harakat, tatweel, joiners
    .replace(/[يى]/g, 'ی') // ي ى → ی
    .replace(/ك/g, 'ک') // ك → ک
    .replace(/[هةھ]/g, 'ہ') // ه ة ھ → ہ (only for matching: both sides are folded)
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)) // ٠-٩
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)) // ۰-۹
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ') // brackets, dashes, slashes become spaces
    .trim();
}

/** True when every word of `query` appears in at least one of the `fields`. An empty query matches all. */
export function matchesQuery(fields: (string | null | undefined)[], query: string): boolean {
  const words = normalizeText(query).split(' ').filter(Boolean);
  if (words.length === 0) return true;
  const hay = normalizeText(fields.filter(Boolean).join(' '));
  return words.every((w) => hay.includes(w));
}
