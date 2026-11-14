/**
 * The restaurant code that appears in the address (/r/<slug>). Lowercase letters, digits and
 * hyphens, 3 to 40 characters, starting and ending with a letter or digit. A few words are kept
 * back because they are routes of the app itself.
 */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

export const RESERVED_SLUGS = new Set([
  'api',
  'r',
  'm',
  'app',
  'admin',
  'platform',
  'login',
  'logout',
  'health',
  'static',
  'assets',
  'public',
  'www',
  'demo-system',
]);

export type SlugProblem = 'FORMAT' | 'RESERVED' | 'DOUBLE_HYPHEN';

export function checkSlug(slug: string): SlugProblem | null {
  if (!SLUG_PATTERN.test(slug)) return 'FORMAT';
  if (slug.includes('--')) return 'DOUBLE_HYPHEN';
  if (RESERVED_SLUGS.has(slug)) return 'RESERVED';
  return null;
}

/** "Lahore Karahi House!" -> "lahore-karahi-house" (a suggestion; the admin may edit it). */
export function suggestSlug(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return base.length >= 3 ? base : `${base}-rest`.replace(/^-/, '').padEnd(3, 'x');
}
