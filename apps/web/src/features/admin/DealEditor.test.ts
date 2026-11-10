import { describe, expect, it } from 'vitest';
import { parseSignedRs } from './DealEditor';

describe('parseSignedRs', () => {
  it('parses signed rupee amounts to integer paisa without floats', () => {
    expect(parseSignedRs('50')).toBe(5000);
    expect(parseSignedRs('-50')).toBe(-5000);
    expect(parseSignedRs('0')).toBe(0);
    expect(parseSignedRs('25.5')).toBe(2550);
    expect(parseSignedRs('-0.07')).toBe(-7);
  });
  it('rejects anything else', () => {
    for (const bad of ['', 'x', '1.234', '--5', '1,000', '.5'])
      expect(parseSignedRs(bad)).toBeNull();
  });
});
