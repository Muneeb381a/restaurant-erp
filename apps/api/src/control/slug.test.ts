import { describe, expect, it } from 'vitest';
import { checkSlug, suggestSlug } from './slug';

describe('checkSlug', () => {
  it('accepts ordinary restaurant codes', () => {
    for (const s of ['lahore-karahi', 'bbq-tonight', 'haji-sahib-2', 'abc'])
      expect(checkSlug(s), s).toBeNull();
  });
  it('refuses bad shapes', () => {
    for (const s of [
      '',
      'ab',
      'Lahore',
      '-start',
      'end-',
      'has space',
      'under_score',
      'x'.repeat(41),
    ])
      expect(checkSlug(s), s).toBe('FORMAT');
    expect(checkSlug('a--b')).toBe('DOUBLE_HYPHEN');
  });
  it('keeps back the words the app uses for its own routes', () => {
    for (const s of ['api', 'platform', 'admin', 'login']) expect(checkSlug(s), s).toBe('RESERVED');
  });
});

describe('suggestSlug', () => {
  it('turns a name into a valid code', () => {
    expect(suggestSlug('Lahore Karahi House!')).toBe('lahore-karahi-house');
    expect(suggestSlug("  Haji's  BBQ & Grill ")).toBe('haji-s-bbq-grill');
    expect(suggestSlug('Café Zahra')).toBe('cafe-zahra');
  });
  it('always returns something that passes the check, even for names with no usable letters', () => {
    for (const n of ['کراہی ہاؤس', '!!', 'A', 'x'.repeat(80)])
      expect(checkSlug(suggestSlug(n)), n).toBeNull();
  });
});
