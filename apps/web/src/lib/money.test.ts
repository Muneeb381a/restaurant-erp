import { describe, expect, it } from 'vitest';
import { formatRs, parseRs } from './money';

describe('formatRs', () => {
  it.each([
    [0, 'Rs 0'],
    [5, 'Rs 0.05'],
    [50, 'Rs 0.50'],
    [100, 'Rs 1'],
    [125050, 'Rs 1,250.50'],
    [360000, 'Rs 3,600'],
    [125000000, 'Rs 1,250,000'],
    [-300, '-Rs 3'],
  ])('%i paisa → %s', (paisa, text) => {
    expect(formatRs(paisa)).toBe(text);
  });

  it('refuses non-integers instead of rounding silently', () => {
    expect(() => formatRs(10.5)).toThrow();
  });
});

describe('parseRs', () => {
  it('parses rupees to integer paisa without floats', () => {
    expect(parseRs('1500')).toBe(150000);
    expect(parseRs('1,500.5')).toBe(150050);
    expect(parseRs('0.07')).toBe(7);
    expect(parseRs('19.99')).toBe(1999);
  });
  it('rejects anything that is not an amount', () => {
    for (const bad of ['', 'abc', '-5', '1.234', '1e3', '1.', '.5'])
      expect(parseRs(bad)).toBeNull();
  });
});
