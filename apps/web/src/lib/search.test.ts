import { describe, expect, it } from 'vitest';
import { matchesQuery, normalizeText } from './search';

const tikka = ['Chicken Tikka (Leg)', 'چکن تکہ (ران)', 'tikka tika', 'TIKKA-LEG'];

describe('matchesQuery', () => {
  it('finds a dish by any of its words, in any order, ignoring capitals and brackets', () => {
    expect(matchesQuery(tikka, 'tikka leg')).toBe(true);
    expect(matchesQuery(tikka, 'LEG tikka')).toBe(true);
    expect(matchesQuery(tikka, 'chicken (leg)')).toBe(true);
    expect(matchesQuery(tikka, 'karahi')).toBe(false);
    expect(matchesQuery(tikka, 'tikka chest')).toBe(false); // every word must be found
  });

  it('an empty search shows everything', () => {
    expect(matchesQuery(tikka, '')).toBe(true);
    expect(matchesQuery(tikka, '   ')).toBe(true);
  });

  it('matches the extra search words and the code, and skips missing fields', () => {
    expect(matchesQuery(['Karahi', null, 'handi desi', undefined], 'desi')).toBe(true);
    expect(matchesQuery(['Karahi', null, null, 'KRH-1'], 'krh 1')).toBe(true);
  });

  it('treats look-alike Urdu letters as the same (ی ي ى, ک ك, ہ ه)', () => {
    // typed with the Arabic yeh/kaf/heh that some keyboards produce
    expect(matchesQuery(['چکن کڑاہی'], 'كڑاهي')).toBe(true);
    expect(matchesQuery(['میٹھا'], 'ميٹها')).toBe(true);
  });

  it('ignores optional Urdu marks and treats Arabic-Indic digits as digits', () => {
    expect(normalizeText('کَڑاہی')).toBe(normalizeText('کڑاہی'));
    expect(matchesQuery(['Tikka 2 pcs'], 'tikka ٢')).toBe(true);
    expect(matchesQuery(['Tikka 2 pcs'], 'tikka ۲')).toBe(true);
  });

  it('folds English accents', () => {
    expect(matchesQuery(['Café Chai'], 'cafe')).toBe(true);
  });
});
