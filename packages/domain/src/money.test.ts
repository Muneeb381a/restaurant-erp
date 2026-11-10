import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MoneyError, asPaisa, formatPaisa, mulDivHalfUp, paisaFromDb, parseRupees } from './money';

describe('asPaisa', () => {
  it('accepts safe integers including zero and negatives', () => {
    expect(asPaisa(0)).toBe(0);
    expect(asPaisa(12345)).toBe(12345);
    expect(asPaisa(-50)).toBe(-50);
  });

  it('rejects floats, NaN, Infinity and unsafe integers', () => {
    for (const bad of [0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => asPaisa(bad)).toThrow(MoneyError);
    }
  });

  it('property: every safe integer round-trips', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
        (n) => {
          expect(asPaisa(n)).toBe(n);
        },
      ),
    );
  });
});

describe('paisaFromDb', () => {
  it('parses bigint text', () => {
    expect(paisaFromDb('150000')).toBe(150000);
    expect(paisaFromDb('-20')).toBe(-20);
  });

  it('rejects non-integer text and unsafe magnitudes', () => {
    expect(() => paisaFromDb('1.5')).toThrow(MoneyError);
    expect(() => paisaFromDb('abc')).toThrow(MoneyError);
    expect(() => paisaFromDb('9007199254740993')).toThrow(MoneyError);
  });
});

describe('parseRupees', () => {
  it.each([
    ['0', 0],
    ['0.5', 50],
    ['0.05', 5],
    ['99.99', 9999],
    ['1250', 125000],
    ['1250.5', 125050],
    ['1250.50', 125050],
    ['1,250', 125000],
    ['1,250.75', 125075],
    ['1,250,000', 125000000],
    ['  300  ', 30000],
    ['007', 700],
  ])('parses %s → %i paisa', (input, expected) => {
    expect(parseRupees(input)).toBe(expected);
  });

  it.each([
    '',
    ' ',
    'abc',
    '-5',
    '+5',
    '1.234',
    '1.',
    '.5',
    '1,25,000',
    '1,2',
    '1,2500',
    '12,34',
    'Rs 100',
    '1e3',
    '１２',
    '1 000',
    '1..5',
  ])('rejects %j', (input) => {
    expect(() => parseRupees(input)).toThrow(MoneyError);
    try {
      parseRupees(input);
    } catch (e) {
      expect((e as MoneyError).code).toBe('MONEY_INVALID_AMOUNT');
    }
  });

  it('rejects amounts beyond the safe integer range', () => {
    expect(() => parseRupees('99999999999999999999')).toThrow(MoneyError);
  });
});

describe('formatPaisa', () => {
  it('formats with exactly two decimals', () => {
    expect(formatPaisa(asPaisa(0))).toBe('0.00');
    expect(formatPaisa(asPaisa(5))).toBe('0.05');
    expect(formatPaisa(asPaisa(125050))).toBe('1250.50');
  });

  it('formats negatives', () => {
    expect(formatPaisa(asPaisa(-1))).toBe('-0.01');
    expect(formatPaisa(asPaisa(-250000))).toBe('-2500.00');
  });

  it('property: parseRupees(formatPaisa(p)) === p for every non-negative amount', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000_000_000 }), (n) => {
        const p = asPaisa(n);
        expect(parseRupees(formatPaisa(p))).toBe(p);
      }),
    );
  });

  it('property: grouped input equals ungrouped input', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2_000_000_000 }), (n) => {
        const grouped = String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        expect(parseRupees(grouped)).toBe(parseRupees(String(n)));
      }),
    );
  });
});

describe('mulDivHalfUp', () => {
  it.each([
    [1000, 1, 3, 333],
    [1000, 2, 3, 667],
    [5, 1, 2, 3], // 2.5 → 3 (half up)
    [1, 1, 2, 1], // 0.5 → 1
    [3, 1, 2, 2], // 1.5 → 2
    [499, 1, 1000, 0],
    [500, 1, 1000, 1],
    [0, 123, 7, 0],
    [7, 0, 5, 0],
    [123456789, 1000, 1000, 123456789],
  ])('%i × %i / %i = %i', (a, n, d, expected) => {
    expect(mulDivHalfUp(a, n, d)).toBe(expected);
  });

  it('rejects negatives, non-integers, zero divisor and results beyond the safe range', () => {
    for (const args of [
      [-1, 1, 1],
      [1, -1, 1],
      [1.5, 1, 1],
      [1, 1.5, 1],
      [1, 1, 0],
      [1, 1, -2],
      [1, 1, 0.5],
      [Number.NaN, 1, 1],
    ] satisfies [number, number, number][]) {
      expect(() => mulDivHalfUp(args[0], args[1], args[2])).toThrow(MoneyError);
    }
    expect(() => mulDivHalfUp(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 1)).toThrow(
      MoneyError,
    );
  });

  it('property: within half a unit of the exact quotient, rounding ties up', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 1, max: 100_000 }),
        (a, n, d) => {
          const r = mulDivHalfUp(a, n, d);
          const twice = 2 * (a * n); // integers < 2^53 here
          expect(Math.abs(2 * r * d - twice)).toBeLessThanOrEqual(d); // |r - x/d| <= 1/2
          if ((twice + d) % (2 * d) === 0) expect(2 * r * d - twice).toBe(d); // exact tie → rounded up
        },
      ),
    );
  });
});
