import { describe, expect, it } from 'vitest';
import { splitEqually } from './split';

describe('splitEqually', () => {
  it('shares always add up to the bill, with the odd paisa on the last person', () => {
    expect(splitEqually(100_000, 3)).toEqual([33_333, 33_333, 33_334]);
    expect(splitEqually(100_000, 4)).toEqual([25_000, 25_000, 25_000, 25_000]);
    expect(splitEqually(1, 3)).toEqual([0, 0, 1]);
    expect(splitEqually(500_000, 1)).toEqual([500_000]);
  });

  it('adds up exactly for every bill and group size (property check)', () => {
    for (const total of [0, 1, 7, 99, 100, 12_345, 999_999, 5_000_001]) {
      for (let n = 1; n <= 12; n++) {
        const parts = splitEqually(total, n);
        expect(parts).toHaveLength(n);
        expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
        // nobody pays more than a paisa-per-person more than anybody else
        expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(n - 1);
      }
    }
  });

  it('refuses a nonsense group size', () => {
    expect(() => splitEqually(1000, 0)).toThrow(RangeError);
    expect(() => splitEqually(1000, 2.5)).toThrow(RangeError);
    expect(() => splitEqually(1000, 21)).toThrow(RangeError);
  });
});
