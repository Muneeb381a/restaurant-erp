import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  foodCostBps,
  formatScaled,
  lineCostPaisa,
  needsReorder,
  parseScaled,
  purchaseToBaseMilli,
  recipeConsumption,
  StockError,
  unitCostMicro,
  weightedAverageMicro,
} from './stock';

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as StockError).code;
  }
  return undefined;
};

describe('parseScaled / formatScaled', () => {
  it('parses decimals to scaled integers and formats them back', () => {
    expect(parseScaled('12.5', 3)).toBe(12500);
    expect(parseScaled('0.001', 3)).toBe(1);
    expect(parseScaled('7', 3)).toBe(7000);
    expect(parseScaled('1.0000', 4)).toBe(10000);
    expect(formatScaled(12500, 3)).toBe('12.5');
    expect(formatScaled(7000, 3)).toBe('7');
    expect(formatScaled(-1500, 3)).toBe('-1.5');
    expect(formatScaled(1, 3)).toBe('0.001');
  });
  it('rejects junk, signs and too many decimals', () => {
    for (const bad of ['', 'x', '-1', '1.2345', '1,5', '.5'])
      expect(code(() => parseScaled(bad, 3))).toBe('STOCK_DECIMAL_INVALID');
  });
  it('round-trips (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000_000 }),
        (v) => parseScaled(formatScaled(v, 3), 3) === v,
      ),
    );
  });
});

describe('purchase units and cost', () => {
  it('converts 2.5 kg to 2500 g and rounds half-up', () => {
    expect(purchaseToBaseMilli(2500, 10_000_000)).toBe(2_500_000); // 2.5 kg × 1000 g = 2500 g (in milli)
    expect(purchaseToBaseMilli(1, 5000)).toBe(1); // 0.001 × 0.5 = 0.0005 -> half-up 1 milli
    expect(code(() => purchaseToBaseMilli(0, 10_000))).toBe('STOCK_INVALID_INPUT');
    expect(code(() => purchaseToBaseMilli(1, 0))).toBe('STOCK_INVALID_INPUT');
  });

  it('usable cost divides by the purchase factor and by the yield', () => {
    // Rs 1,800 per kg gosht = 180000 paisa; 1000 g/kg; 100 % yield -> 180 paisa/g = 180e6 micro
    expect(unitCostMicro(180_000, 10_000_000, 10_000)).toBe(180_000_000);
    // 80 % yield: usable gram costs 25 % more
    expect(unitCostMicro(180_000, 10_000_000, 8000)).toBe(225_000_000);
    expect(code(() => unitCostMicro(-1, 10_000_000, 10_000))).toBe('STOCK_INVALID_INPUT');
    expect(code(() => unitCostMicro(1, 0, 10_000))).toBe('STOCK_INVALID_INPUT');
    expect(code(() => unitCostMicro(1, 10_000, 0))).toBe('STOCK_INVALID_INPUT');
    expect(code(() => unitCostMicro(1, 10_000, 10_001))).toBe('STOCK_INVALID_INPUT');
  });

  it('weighted average: new cost with nothing on hand, a blend otherwise, bounded by both costs', () => {
    expect(
      weightedAverageMicro({ onHandMilli: 0, avgMicro: 5, addedMilli: 10, addedCostMicro: 200 }),
    ).toBe(200);
    expect(
      weightedAverageMicro({ onHandMilli: -50, avgMicro: 5, addedMilli: 10, addedCostMicro: 200 }),
    ).toBe(200);
    expect(
      weightedAverageMicro({
        onHandMilli: 1000,
        avgMicro: 100,
        addedMilli: 1000,
        addedCostMicro: 200,
      }),
    ).toBe(150);
    expect(
      code(() =>
        weightedAverageMicro({ onHandMilli: 1, avgMicro: 1, addedMilli: 0, addedCostMicro: 1 }),
      ),
    ).toBe('STOCK_INVALID_INPUT');
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000_000 }),
        (onHand, avg, added, cost) => {
          const r = weightedAverageMicro({
            onHandMilli: onHand,
            avgMicro: avg,
            addedMilli: added,
            addedCostMicro: cost,
          });
          expect(r).toBeGreaterThanOrEqual(Math.min(avg, cost));
          expect(r).toBeLessThanOrEqual(Math.max(avg, cost));
        },
      ),
    );
  });

  it('line cost: quantity × cost, half-up to paisa', () => {
    expect(lineCostPaisa(250_000, 180_000_000)).toBe(45_000); // 250 g × 180 paisa/g
    expect(lineCostPaisa(1000, 500_000)).toBe(1); // 1 unit at 0.5 paisa rounds up
    expect(lineCostPaisa(1000, 499_999)).toBe(0);
    expect(lineCostPaisa(0, 5)).toBe(0);
    expect(code(() => lineCostPaisa(-1, 1))).toBe('STOCK_INVALID_INPUT');
    expect(code(() => lineCostPaisa(1, -1))).toBe('STOCK_INVALID_INPUT');
  });
});

describe('recipeConsumption', () => {
  const lines = [
    { ingredientId: 'gosht', qtyMilli: 500_000 }, // 500 g per portion
    { ingredientId: 'oil', qtyMilli: 30_000 },
  ];
  it('scales by pieces sold', () => {
    expect(recipeConsumption(lines, { qtyMilli: 3000 })).toEqual([
      { ingredientId: 'gosht', qtyMilli: 1_500_000 },
      { ingredientId: 'oil', qtyMilli: 90_000 },
    ]);
  });
  it('weight items: the recipe is per 1000 g, scaled by the grams sold', () => {
    // 750 g sold of an item whose recipe is 1000 g gosht + 100 g masala per kg
    expect(
      recipeConsumption(
        [
          { ingredientId: 'g', qtyMilli: 1_000_000 },
          { ingredientId: 'm', qtyMilli: 100_000 },
        ],
        { qtyMilli: 1000, weightG: 750 },
      ),
    ).toEqual([
      { ingredientId: 'g', qtyMilli: 750_000 },
      { ingredientId: 'm', qtyMilli: 75_000 },
    ]);
  });
  it('refuses a zero or fractional-milli quantity', () => {
    expect(code(() => recipeConsumption(lines, { qtyMilli: 0 }))).toBe('STOCK_INVALID_INPUT');
    expect(code(() => recipeConsumption(lines, { qtyMilli: 1.5 }))).toBe('STOCK_INVALID_INPUT');
  });
});

describe('food cost and reorder', () => {
  it('food cost % in basis points', () => {
    expect(foodCostBps(35_000, 100_000)).toBe(3500);
    expect(foodCostBps(1, 3)).toBe(3333);
    expect(foodCostBps(5, 0)).toBe(0);
  });
  it('reorder alert only below a set level', () => {
    expect(needsReorder(900, 1000)).toBe(true);
    expect(needsReorder(1000, 1000)).toBe(false);
    expect(needsReorder(-5, null)).toBe(false);
  });
});
