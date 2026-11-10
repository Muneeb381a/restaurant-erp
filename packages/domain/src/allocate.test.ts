import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { allocateProRata } from './allocate';
import { MoneyError, asPaisa } from './money';

const p = asPaisa;

describe('allocateProRata', () => {
  it('splits proportionally; leftover paisa go to the last entry', () => {
    expect(allocateProRata(p(100), [1, 1, 1])).toEqual([33, 33, 34]);
    expect(allocateProRata(p(1000), [300, 300, 400])).toEqual([300, 300, 400]);
    expect(allocateProRata(p(1000), [1, 2])).toEqual([333, 666 + 1]);
    expect(allocateProRata(p(1), [5, 5, 5])).toEqual([0, 0, 1]);
  });

  it('handles a single entry, a zero total and zero weights', () => {
    expect(allocateProRata(p(777), [42])).toEqual([777]);
    expect(allocateProRata(p(0), [3, 4])).toEqual([0, 0]);
    expect(allocateProRata(p(100), [0, 5])).toEqual([0, 100]); // a free component gets nothing
  });

  it('splits equally when every weight is zero (remainder to the last)', () => {
    expect(allocateProRata(p(10), [0, 0, 0])).toEqual([3, 3, 4]);
  });

  it('rejects bad input', () => {
    for (const total of [-1, 1.5, Number.NaN]) {
      expect(() => allocateProRata(total as never, [1])).toThrow(MoneyError);
    }
    expect(() => allocateProRata(p(10), [])).toThrow(MoneyError);
    for (const bad of [[-1], [1.5], [Number.NaN]]) {
      expect(() => allocateProRata(p(10), bad)).toThrow(MoneyError);
    }
  });

  it('property: parts always add up to the whole and are never negative', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000_000 }),
        fc.array(fc.integer({ min: 0, max: 5_000_000 }), { minLength: 1, maxLength: 12 }),
        (total, weights) => {
          const parts = allocateProRata(p(total), weights);
          expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
          expect(parts.every((x) => x >= 0)).toBe(true);
          expect(parts).toHaveLength(weights.length);
        },
      ),
    );
  });

  it('property: every non-last part is its exact share rounded down (within 1 paisa)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.array(fc.integer({ min: 1, max: 10_000 }), { minLength: 2, maxLength: 8 }),
        (total, weights) => {
          const sum = weights.reduce((a, b) => a + b, 0);
          const parts = allocateProRata(p(total), weights);
          parts.slice(0, -1).forEach((part, i) => {
            const exact = (total * (weights[i] as number)) / sum;
            expect(part).toBeLessThanOrEqual(exact + 1e-9);
            expect(exact - part).toBeLessThan(1 + 1e-9);
          });
        },
      ),
    );
  });

  it('property: equal weights give near-equal parts (differ by less than the number of parts)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 1, max: 20 }),
        (total, n) => {
          const parts = allocateProRata(p(total), Array<number>(n).fill(1));
          expect(Math.max(...parts) - Math.min(...parts)).toBeLessThan(n);
        },
      ),
    );
  });
});
