import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { formatDaySummary, percentOf, rs, type DaySummaryInput } from './day-summary';

const base: DaySummaryInput = {
  restaurant: 'Lahore Karahi House',
  date: '2026-11-11',
  bills: 3,
  netSalesPaisa: 4_512_550,
  avgBillPaisa: 1_504_183,
  discountPaisa: 100_000,
  refundsPaisa: 0,
  costOfFoodPaisa: 1_400_000,
  expensesPaisa: 800_000,
  netProfitPaisa: 2_312_550,
  uncostedLines: 0,
  payments: [
    { method: 'Cash', amountPaisa: 3_000_000 },
    { method: 'Card', amountPaisa: 1_512_550 },
    { method: 'Khata', amountPaisa: 0 },
  ],
  topItems: [
    { name: 'Chicken Karahi', qty: 7 },
    { name: 'Naan', qty: 30 },
  ],
  cashDifferencePaisa: -50_000,
  voidedAfterKitchenLines: 1,
  medianKitchenSec: 840,
  lowStockCount: 2,
  khataOwedPaisa: 250_000,
};

describe('rs', () => {
  it('groups thousands and shows paisa only when there are some', () => {
    expect(rs(0)).toBe('Rs 0');
    expect(rs(125_000)).toBe('Rs 1,250');
    expect(rs(125_050)).toBe('Rs 1,250.50');
    expect(rs(123_456_789)).toBe('Rs 1,234,567.89');
    expect(rs(-30_000)).toBe('-Rs 300');
  });
  it('never prints a float artefact', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }), (n) => {
        expect(rs(n)).toMatch(/^-?Rs \d{1,3}(,\d{3})*(\.\d{2})?$/);
      }),
    );
  });
});

describe('percentOf', () => {
  it('is null without sales and rounds to a whole percent', () => {
    expect(percentOf(10, 0)).toBeNull();
    expect(percentOf(1, 3)).toBe(33);
    expect(percentOf(-50, 100)).toBe(-50);
  });
});

describe('formatDaySummary', () => {
  it('tells the owner the day in a few lines', () => {
    const t = formatDaySummary(base);
    expect(t).toContain('*Lahore Karahi House*');
    expect(t).toContain('Wednesday 11 November');
    expect(t).toContain('*Sales* Rs 45,125.50 · 3 bills (average Rs 15,041.83)');
    expect(t).toContain('Paid by: Cash Rs 30,000 · Card Rs 15,125.50'); // the zero Khata line is left out
    expect(t).toContain('*Net profit: Rs 23,125.50* (51% of sales)');
    expect(t).toContain('Discounts: Rs 1,000');
    expect(t).not.toContain('Refunds'); // nothing refunded: not mentioned
    expect(t).toContain('Cash difference: Rs 500 short');
    expect(t).toContain('Best sellers: Chicken Karahi ×7, Naan ×30');
    expect(t).toContain('Kitchen: typical 14 min');
    expect(t).toContain('Low stock: 2 items');
    expect(t).toContain('Khata owed to you: Rs 2,500');
    expect(t).not.toMatch(/\n{3,}/);
  });

  it('warns when profit ignores dishes without a recipe cost', () => {
    expect(formatDaySummary({ ...base, uncostedLines: 4 })).toContain(
      '4 sold lines have no recipe cost',
    );
  });

  it('says so plainly on a day with no sales, with no figures to misread', () => {
    const t = formatDaySummary({ ...base, bills: 0 });
    expect(t).toContain('No sales today.');
    expect(t).not.toContain('Net profit');
  });

  it('singular bill, over-counted cash, no profit percentage without sales', () => {
    const t = formatDaySummary({
      ...base,
      bills: 1,
      cashDifferencePaisa: 20_000,
      netSalesPaisa: 0,
    });
    expect(t).toContain('1 bill ');
    expect(t).toContain('Rs 200 over');
    expect(t).not.toContain('% of sales');
  });

  it('can be written in Urdu', () => {
    const t = formatDaySummary(base, 'ur');
    expect(t).toContain('خالص منافع');
    expect(t).toContain('3 بل');
    expect(t).toContain('Rs 23,125.50');
  });
});
