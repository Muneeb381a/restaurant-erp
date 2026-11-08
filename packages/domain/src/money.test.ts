import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MoneyError, asPaisa, paisaFromDb } from './money';

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
