import { describe, expect, it } from 'vitest';
import { formatRs } from './money';

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
