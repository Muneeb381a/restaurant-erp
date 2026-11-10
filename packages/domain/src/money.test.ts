import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MoneyError, asPaisa, formatPaisa, paisaFromDb, parseRupees } from './money';

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
