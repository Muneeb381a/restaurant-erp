import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildDailySales, type DailyBill } from './daily-sales';

const bill = (o: Partial<DailyBill> & { id: string; totalPaisa: number }): DailyBill => ({
  billNo: 1,
  orderNo: 1,
  status: 'SETTLED',
  orderType: 'DINE_IN',
  channel: 'POS',
  subtotalPaisa: o.totalPaisa,
  discountPaisa: 0,
  serviceChargePaisa: 0,
  taxPaisa: 0,
  roundOffPaisa: 0,
  hour: 13,
  cashier: 'Sara',
  payments: [{ method: 'Cash', amountPaisa: o.totalPaisa, tipPaisa: 0 }],
  ...o,
});

describe('buildDailySales', () => {
  it('adds up a normal day', () => {
    const r = buildDailySales(
      [
        bill({
          id: 'a',
          totalPaisa: 100000,
          subtotalPaisa: 110000,
          discountPaisa: 10000,
          hour: 13,
        }),
        bill({
          id: 'b',
          totalPaisa: 50000,
          orderType: 'TAKEAWAY',
          channel: 'FOODPANDA',
          hour: 20,
          cashier: 'Ali',
          payments: [{ method: 'Card', amountPaisa: 50000, tipPaisa: 500 }],
        }),
        bill({ id: 'c', totalPaisa: 30000, status: 'PRE_BILLED', hour: 21 }),
      ],
      [{ amountPaisa: 5000, method: 'Cash' }],
      [
        { billId: 'a', name: 'Tikka', category: 'BBQ', qty: 3, netPaisa: 90000 },
        { billId: 'a', name: 'Naan', category: null, qty: 4, netPaisa: 20000 },
        { billId: 'b', name: 'Tikka', category: 'BBQ', qty: 1, netPaisa: 30000 },
        { billId: 'c', name: 'Tikka', category: 'BBQ', qty: 9, netPaisa: 999999 }, // unpaid: not counted
      ],
    );
    expect(r.paidBills).toBe(2);
    expect(r.grossSalesPaisa).toBe(160000);
    expect(r.discountPaisa).toBe(10000);
    expect(r.collectedPaisa).toBe(150000);
    expect(r.refundsPaisa).toBe(5000);
    expect(r.netAfterRefundsPaisa).toBe(145000);
    expect(r.avgBillPaisa).toBe(75000);
    expect(r.tipsPaisa).toBe(500);
    expect(r.unpaidBills).toBe(1);
    expect(r.unpaidPaisa).toBe(30000);
    expect(r.byMethod).toEqual([
      { key: 'Cash', bills: 1, amountPaisa: 100000 },
      { key: 'Card', bills: 1, amountPaisa: 50000 },
    ]);
    expect(r.byChannel.map((b) => b.key)).toEqual(['POS', 'FOODPANDA']);
    expect(r.byHour.map((b) => b.key)).toEqual(['13', '20']);
    expect(r.byCashier.map((b) => b.key)).toEqual(['Sara', 'Ali']);
    expect(r.topItems[0]).toEqual({ name: 'Tikka', qty: 4, amountPaisa: 120000 });
    expect(r.categories.map((c) => c.name)).toEqual(['BBQ', 'Uncategorised']);
    expect(r.refundsByMethod).toEqual([{ key: 'Cash', bills: 1, amountPaisa: 5000 }]);
  });

  it('an empty day is all zeros', () => {
    const r = buildDailySales([], [], []);
    expect(r).toMatchObject({
      paidBills: 0,
      collectedPaisa: 0,
      avgBillPaisa: 0,
      netAfterRefundsPaisa: 0,
    });
    expect(r.byMethod).toEqual([]);
  });

  it('an order without a type is grouped as OTHER and a missing cashier as Unknown', () => {
    const r = buildDailySales(
      [bill({ id: 'x', totalPaisa: 1000, orderType: null, channel: null, cashier: null })],
      [],
      [],
    );
    expect(r.byType[0]!.key).toBe('OTHER');
    expect(r.byChannel[0]!.key).toBe('POS');
    expect(r.byCashier[0]!.key).toBe('Unknown');
  });

  it('ties are ordered by name, and only the top N dishes are kept', () => {
    const r = buildDailySales(
      [bill({ id: 'a', totalPaisa: 3000 })],
      [],
      [
        { billId: 'a', name: 'Raita', category: 'Sides', qty: 1, netPaisa: 1000 },
        { billId: 'a', name: 'Daal', category: 'Sides', qty: 1, netPaisa: 1000 },
        { billId: 'a', name: 'Naan', category: 'Sides', qty: 1, netPaisa: 1000 },
      ],
      2,
    );
    expect(r.topItems.map((i) => i.name)).toEqual(['Daal', 'Naan']);
  });

  it('the parts always add up to the whole', () => {
    let seq = 0;
    const billArb = fc
      .record({
        total: fc.integer({ min: 0, max: 5_000_000 }),
        type: fc.constantFrom<DailyBill['orderType']>('DINE_IN', 'TAKEAWAY', 'DELIVERY', null),
        hour: fc.integer({ min: 0, max: 23 }),
        paid: fc.boolean(),
        methods: fc.integer({ min: 1, max: 3 }),
      })
      .map((x) => {
        const each = Math.floor(x.total / x.methods);
        const payments = Array.from({ length: x.methods }, (_, k) => ({
          method: ['Cash', 'Card', 'JazzCash'][k]!,
          amountPaisa: k === x.methods - 1 ? x.total - each * (x.methods - 1) : each,
          tipPaisa: 0,
        }));
        return bill({
          id: `b${(seq += 1)}`,
          totalPaisa: x.total,
          orderType: x.type,
          hour: x.hour,
          status: x.paid ? 'SETTLED' : 'PRE_BILLED',
          payments,
        });
      });
    fc.assert(
      fc.property(fc.array(billArb, { maxLength: 40 }), (bills) => {
        const r = buildDailySales(bills, [], []);
        const total = r.collectedPaisa;
        expect(r.byType.reduce((n, b) => n + b.amountPaisa, 0)).toBe(total);
        expect(r.byHour.reduce((n, b) => n + b.amountPaisa, 0)).toBe(total);
        expect(r.byCashier.reduce((n, b) => n + b.amountPaisa, 0)).toBe(total);
        expect(r.byMethod.reduce((n, b) => n + b.amountPaisa, 0)).toBe(total);
        expect(r.byType.reduce((n, b) => n + b.bills, 0)).toBe(r.paidBills);
      }),
    );
  });
});
