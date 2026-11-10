import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { assertCanTakeOut, cashVariance, DrawerError, expectedCash } from './drawer';

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as DrawerError).code;
  }
  return undefined;
};
const base = {
  openingFloatPaisa: 500000,
  cashSalesPaisa: 0,
  cashInPaisa: 0,
  khataCashPaisa: 0,
  paidOutPaisa: 0,
  dropsPaisa: 0,
};

describe('expectedCash', () => {
  it('is float + sales + cash in − paid out − drops', () => {
    expect(
      expectedCash({
        openingFloatPaisa: 500000,
        cashSalesPaisa: 1250000,
        cashInPaisa: 20000,
        khataCashPaisa: 40000,
        paidOutPaisa: 35000,
        dropsPaisa: 1000000,
      }),
    ).toBe(775000);
    expect(expectedCash(base)).toBe(500000);
  });

  it('matches the arithmetic for any non-negative flows (property)', () => {
    const n = fc.integer({ min: 0, max: 1_000_000_000 });
    fc.assert(
      fc.property(n, n, n, n, n, n, (a, b, c, k, d, e) => {
        const got = expectedCash({
          openingFloatPaisa: a,
          cashSalesPaisa: b,
          cashInPaisa: c,
          khataCashPaisa: k,
          paidOutPaisa: d,
          dropsPaisa: e,
        });
        expect(got).toBe(a + b + c + k - d - e);
      }),
    );
  });

  it.each([
    'openingFloatPaisa',
    'cashSalesPaisa',
    'cashInPaisa',
    'khataCashPaisa',
    'paidOutPaisa',
    'dropsPaisa',
  ] as const)('rejects a negative or fractional %s', (field) => {
    expect(code(() => expectedCash({ ...base, [field]: -1 }))).toBe('DRAWER_AMOUNT_INVALID');
    expect(code(() => expectedCash({ ...base, [field]: 1.5 }))).toBe('DRAWER_AMOUNT_INVALID');
  });
});

describe('cashVariance', () => {
  it('is counted − expected: negative = short, positive = over', () => {
    expect(cashVariance(99000, 100000)).toBe(-1000);
    expect(cashVariance(101000, 100000)).toBe(1000);
    expect(cashVariance(100000, 100000)).toBe(0);
  });
  it('rejects bad counts', () => {
    expect(code(() => cashVariance(-1, 0))).toBe('DRAWER_AMOUNT_INVALID');
    expect(code(() => cashVariance(1.5, 0))).toBe('DRAWER_AMOUNT_INVALID');
    expect(code(() => cashVariance(0, 0.5))).toBe('DRAWER_AMOUNT_INVALID');
  });
});

describe('assertCanTakeOut', () => {
  it('allows up to exactly what the drawer holds', () => {
    expect(() => assertCanTakeOut(100, 100)).not.toThrow();
    expect(() => assertCanTakeOut(1, 100)).not.toThrow();
  });
  it('refuses zero, negative, fractional and more than the drawer holds', () => {
    expect(code(() => assertCanTakeOut(0, 100))).toBe('DRAWER_AMOUNT_INVALID');
    expect(code(() => assertCanTakeOut(-5, 100))).toBe('DRAWER_AMOUNT_INVALID');
    expect(code(() => assertCanTakeOut(1.5, 100))).toBe('DRAWER_AMOUNT_INVALID');
    expect(code(() => assertCanTakeOut(101, 100))).toBe('DRAWER_INSUFFICIENT_CASH');
  });
});
