import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { asPaisa, mulDivHalfUp } from '../money';
import { LineError, allocateDealLine, orderSubtotal, priceLine, type LineInput } from './line';

const p = asPaisa;
const std = (o: Partial<LineInput> = {}): LineInput => ({
  kind: 'STANDARD',
  unitPricePaisa: p(50000),
  qty: 1,
  ...o,
});

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as LineError).code;
  }
  return undefined;
}

describe('priceLine — STANDARD', () => {
  it('is (unit + modifiers) × qty', () => {
    expect(priceLine(std({ qty: 3 }))).toEqual({
      lineTotalPaisa: 150000,
      modifiersTotalPaisa: 0,
      unitTotalPaisa: 50000,
    });
    expect(priceLine(std({ qty: 2, modifiersDeltaPerUnitPaisa: p(5000) }))).toEqual({
      lineTotalPaisa: 110000,
      modifiersTotalPaisa: 10000,
      unitTotalPaisa: 55000,
    });
  });

  it('ignores deal upcharges and allows a free item', () => {
    expect(priceLine(std({ dealUpchargePerUnitPaisa: p(9999) })).lineTotalPaisa).toBe(50000);
    expect(priceLine(std({ unitPricePaisa: p(0) })).lineTotalPaisa).toBe(0);
  });

  it('allows a discounting modifier but never a negative line', () => {
    expect(priceLine(std({ modifiersDeltaPerUnitPaisa: p(-1000) })).lineTotalPaisa).toBe(49000);
    expect(
      code(() => priceLine(std({ unitPricePaisa: p(500), modifiersDeltaPerUnitPaisa: p(-1000) }))),
    ).toBe('LINE_NEGATIVE_TOTAL');
  });

  it('rejects bad quantities and a weight', () => {
    for (const qty of [0, -1, 1.5, 1001, Number.NaN])
      expect(code(() => priceLine(std({ qty })))).toBe('LINE_QTY_INVALID');
    expect(priceLine(std({ qty: 1000 })).lineTotalPaisa).toBe(50_000_000);
    expect(code(() => priceLine(std({ weightG: 500 })))).toBe('LINE_WEIGHT_NOT_ALLOWED');
  });
});

describe('priceLine — DEAL', () => {
  it('adds option upcharges and modifiers per deal, times qty', () => {
    const deal = priceLine({
      kind: 'DEAL',
      unitPricePaisa: p(400000),
      qty: 2,
      dealUpchargePerUnitPaisa: p(30000),
      modifiersDeltaPerUnitPaisa: p(1000),
    });
    expect(deal).toEqual({
      lineTotalPaisa: 862000,
      modifiersTotalPaisa: 2000,
      unitTotalPaisa: 431000,
    });
    expect(priceLine({ kind: 'DEAL', unitPricePaisa: p(400000), qty: 1 }).lineTotalPaisa).toBe(
      400000,
    );
  });
});

describe('priceLine — WEIGHT', () => {
  const w = (
    weightG: number | undefined,
    price = 480000,
    extra: Partial<LineInput> = {},
  ): LineInput => ({
    kind: 'WEIGHT',
    unitPricePaisa: p(price),
    qty: 1,
    weightG,
    ...extra,
  });

  it('is round_half_up(price per kg × grams / 1000)', () => {
    expect(priceLine(w(1000)).lineTotalPaisa).toBe(480000);
    expect(priceLine(w(500)).lineTotalPaisa).toBe(240000);
    expect(priceLine(w(250)).lineTotalPaisa).toBe(120000);
    expect(priceLine(w(750, 333)).lineTotalPaisa).toBe(250); // 249.75 → 250
    expect(priceLine(w(1, 499)).lineTotalPaisa).toBe(0); // 0.499 → 0
    expect(priceLine(w(1, 500)).lineTotalPaisa).toBe(1); // 0.5 → 1 (half up)
    expect(priceLine(w(3, 500)).lineTotalPaisa).toBe(2); // 1.5 → 2
    expect(priceLine(w(2, 500)).lineTotalPaisa).toBe(1); // exactly 1.0
  });

  it('adds modifiers once per line, not per kg', () => {
    const r = priceLine(w(2000, 480000, { modifiersDeltaPerUnitPaisa: p(5000) }));
    expect(r).toEqual({
      lineTotalPaisa: 965000,
      modifiersTotalPaisa: 5000,
      unitTotalPaisa: 960000,
    });
  });

  it('requires a sane weight and qty 1', () => {
    expect(code(() => priceLine(w(undefined)))).toBe('LINE_WEIGHT_REQUIRED');
    for (const g of [0, -5, 0.5, 1_000_001])
      expect(code(() => priceLine(w(g)))).toBe('LINE_WEIGHT_INVALID');
    expect(code(() => priceLine(w(500, 480000, { qty: 2 })))).toBe('LINE_QTY_INVALID');
    expect(code(() => priceLine(w(1000, 100, { modifiersDeltaPerUnitPaisa: p(-500) })))).toBe(
      'LINE_NEGATIVE_TOTAL',
    );
  });

  it('property: the weighed price is within half a paisa of the exact value, and monotone in weight', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.integer({ min: 1, max: 100_000 }),
        (price, grams) => {
          const total = priceLine(w(grams, price)).lineTotalPaisa;
          // |total - price*grams/1000| <= 0.5  ⇔  |1000*total - price*grams| <= 500   (all integers)
          expect(Math.abs(1000 * total - price * grams)).toBeLessThanOrEqual(500);
          if (grams > 1)
            expect(total).toBeGreaterThanOrEqual(priceLine(w(grams - 1, price)).lineTotalPaisa);
        },
      ),
    );
  });

  it('property: weighing a kg in two halves never differs from the whole by more than 1 paisa', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2_000_000 }),
        fc.integer({ min: 1, max: 999 }),
        (price, a) => {
          const whole = priceLine(w(1000, price)).lineTotalPaisa;
          const parts =
            priceLine(w(a, price)).lineTotalPaisa + priceLine(w(1000 - a, price)).lineTotalPaisa;
          expect(Math.abs(whole - parts)).toBeLessThanOrEqual(1);
        },
      ),
    );
  });
});

describe('allocateDealLine', () => {
  const comps = [
    { key: 'karahi', listPricePaisa: p(110000), count: 1 },
    { key: 'naan', listPricePaisa: p(5000), count: 4 },
    { key: 'cola', listPricePaisa: p(8000), count: 2 },
  ];

  it('spreads the line total pro-rata to list prices; parts add up to the whole', () => {
    const r = allocateDealLine(p(400000), comps);
    expect(r.map((x) => x.key)).toEqual(['karahi', 'naan', 'cola']);
    expect(r.reduce((a, x) => a + x.allocatedPaisa, 0)).toBe(400000);
    // weights 110000 : 20000 : 16000 of 146000
    expect(r[0]!.allocatedPaisa).toBe(Math.floor((400000 * 110000) / 146000));
  });

  it('gives free components nothing and a deal with no priced component an equal split', () => {
    expect(
      allocateDealLine(p(1000), [
        { key: 'a', listPricePaisa: p(0), count: 1 },
        { key: 'b', listPricePaisa: p(100), count: 1 },
      ]).map((x) => x.allocatedPaisa),
    ).toEqual([0, 1000]);
    expect(
      allocateDealLine(p(1000), [
        { key: 'a', listPricePaisa: p(0), count: 1 },
        { key: 'b', listPricePaisa: p(0), count: 2 },
      ]).map((x) => x.allocatedPaisa),
    ).toEqual([500, 500]);
  });

  it('property: always sums to the deal line total', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50_000_000 }),
        fc.array(
          fc.record({
            listPricePaisa: fc.integer({ min: 0, max: 1_000_000 }),
            count: fc.integer({ min: 1, max: 10 }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        (total, cs) => {
          const r = allocateDealLine(
            p(total),
            cs.map((c, i) => ({
              key: `c${i}`,
              listPricePaisa: p(c.listPricePaisa),
              count: c.count,
            })),
          );
          expect(r.reduce((a, x) => a + x.allocatedPaisa, 0)).toBe(total);
        },
      ),
    );
  });
});

describe('orderSubtotal', () => {
  const line = (total: number, status = 'NEW', parentLineId: string | null = null) => ({
    lineTotalPaisa: p(total),
    status,
    parentLineId,
  });

  it('sums live top-level lines only (void lines and deal components excluded)', () => {
    expect(
      orderSubtotal([
        line(1000),
        line(2000, 'SENT'),
        line(5000, 'VOID'),
        line(0, 'NEW', 'deal-1'),
        line(300, 'SERVED'),
      ]),
    ).toBe(3300);
  });

  it('is zero for an empty order', () => {
    expect(orderSubtotal([])).toBe(0);
    expect({ lineTotalPaisa: p(10), status: 'NEW' }).toBeTruthy();
    expect(orderSubtotal([{ lineTotalPaisa: p(10), status: 'NEW' }])).toBe(10); // parentLineId omitted
  });

  it('agrees with priceLine totals', () => {
    const a = priceLine(std({ qty: 2 }));
    const b = priceLine({ kind: 'WEIGHT', unitPricePaisa: p(480000), qty: 1, weightG: 750 });
    expect(orderSubtotal([line(a.lineTotalPaisa), line(b.lineTotalPaisa)])).toBe(
      a.lineTotalPaisa + b.lineTotalPaisa,
    );
    expect(mulDivHalfUp(480000, 750, 1000)).toBe(b.lineTotalPaisa);
  });
});
