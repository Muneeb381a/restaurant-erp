import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeBill } from './bill';
import {
  computeRefund,
  linePaidValues,
  RefundError,
  type RefundableLine,
  type RefundBill,
} from './refund';

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as RefundError).code;
  }
  return undefined;
};

const plain: RefundBill = {
  subtotalPaisa: 100000,
  discountPaisa: 0,
  serviceChargePaisa: 0,
  roundOffPaisa: 0,
  totalPaisa: 100000,
};
const line = (id: string, netPaisa: number, qty: number, refunded = 0): RefundableLine => ({
  id,
  netPaisa,
  qtyMilli: qty * 1000,
  refundedQtyMilli: refunded * 1000,
});

describe('computeRefund', () => {
  it('returns part of a line pro rata and says the bill is not complete', () => {
    const r = computeRefund(plain, [line('a', 100000, 4)], [{ lineId: 'a', qtyMilli: 1000 }]);
    expect(r.totalPaisa).toBe(25000);
    expect(r.completesBill).toBe(false);
  });

  it('a discount and a service charge are shared across the lines', () => {
    // 2 lines: 60000 + 40000; 10% discount (10000) and 5% service on the discounted amount (4500)
    const t = computeBill({
      subtotalPaisa: 100000 as never,
      discount: { kind: 'PERCENT_BPS', bps: 1000 },
      serviceChargeBps: 500,
      roundToRupee: false,
    });
    const bill: RefundBill = {
      subtotalPaisa: t.subtotalPaisa,
      discountPaisa: t.discountPaisa,
      serviceChargePaisa: t.serviceChargePaisa,
      roundOffPaisa: t.roundOffPaisa,
      totalPaisa: t.totalPaisa,
    };
    const lines = [line('a', 60000, 1), line('b', 40000, 1)];
    expect(linePaidValues(bill, lines).reduce((n, v) => n + v, 0)).toBe(
      bill.totalPaisa - bill.roundOffPaisa,
    );
    const all = computeRefund(bill, lines, [
      { lineId: 'a', qtyMilli: 1000 },
      { lineId: 'b', qtyMilli: 1000 },
    ]);
    expect(all.totalPaisa).toBe(bill.totalPaisa);
    expect(all.completesBill).toBe(true);
    // the customer paid Rs 945 for Rs 1,000 of food: returning the Rs 600 line gives back 567
    const one = computeRefund(bill, lines, [{ lineId: 'a', qtyMilli: 1000 }]);
    expect(one.totalPaisa).toBe(56700);
  });

  it('the round-off comes back with the last line, so a full return equals the bill total', () => {
    const bill: RefundBill = {
      ...plain,
      subtotalPaisa: 99950,
      totalPaisa: 100000,
      roundOffPaisa: 50,
    };
    const lines = [line('a', 99950, 1)];
    const r = computeRefund(bill, lines, [{ lineId: 'a', qtyMilli: 1000 }]);
    expect(r.totalPaisa).toBe(100000);
    // a partial return of a bill with round-off does not touch it
    const half = computeRefund(bill, [line('a', 99950, 2)], [{ lineId: 'a', qtyMilli: 1000 }]);
    expect(half.totalPaisa).toBe(49975);
  });

  it('weights work in thousandths', () => {
    const r = computeRefund(
      plain,
      [{ id: 'w', netPaisa: 100000, qtyMilli: 750, refundedQtyMilli: 0 }],
      [{ lineId: 'w', qtyMilli: 250 }],
    );
    expect(r.totalPaisa).toBe(33333);
  });

  it('rejects empty, unknown, duplicate, zero, fractional and excessive requests', () => {
    const lines = [line('a', 100000, 2, 1)];
    expect(code(() => computeRefund(plain, lines, []))).toBe('REFUND_EMPTY');
    expect(code(() => computeRefund(plain, lines, [{ lineId: 'zzz', qtyMilli: 1000 }]))).toBe(
      'REFUND_UNKNOWN_LINE',
    );
    expect(
      code(() =>
        computeRefund(plain, lines, [
          { lineId: 'a', qtyMilli: 500 },
          { lineId: 'a', qtyMilli: 500 },
        ]),
      ),
    ).toBe('REFUND_DUPLICATE_LINE');
    for (const bad of [0, -1, 1.5])
      expect(code(() => computeRefund(plain, lines, [{ lineId: 'a', qtyMilli: bad }]))).toBe(
        'REFUND_QTY_INVALID',
      );
    expect(code(() => computeRefund(plain, lines, [{ lineId: 'a', qtyMilli: 1001 }]))).toBe(
      'REFUND_QTY_EXCEEDS',
    );
  });

  it('a negative per-line share (extreme discount) still adds up', () => {
    // one tiny line among big ones under a near-total discount can get a negative paid value
    const bill: RefundBill = {
      subtotalPaisa: 10002,
      discountPaisa: 10001,
      serviceChargePaisa: 0,
      roundOffPaisa: 0,
      totalPaisa: 1,
    };
    const lines = [line('a', 5000, 1), line('b', 5000, 1), line('c', 2, 1)];
    const all = computeRefund(
      bill,
      lines,
      lines.map((l) => ({ lineId: l.id, qtyMilli: 1000 })),
    );
    expect(all.totalPaisa).toBe(1);
    expect(all.lines.reduce((n, l) => n + l.paisa, 0)).toBe(1);
  });

  it('returning in steps equals returning at once, and never exceeds the bill (property)', () => {
    const lineArb = fc.record({
      net: fc.integer({ min: 0, max: 5_000_000 }),
      qty: fc.integer({ min: 1, max: 12 }),
    });
    fc.assert(
      fc.property(
        fc.array(lineArb, { minLength: 1, maxLength: 6 }),
        fc.integer({ min: 0, max: 3000 }),
        fc.integer({ min: 0, max: 1000 }),
        fc.boolean(),
        (ls, discBps, svcBps, round) => {
          const subtotal = ls.reduce((n, l) => n + l.net, 0);
          const t = computeBill({
            subtotalPaisa: subtotal as never,
            discount: { kind: 'PERCENT_BPS', bps: discBps },
            serviceChargeBps: svcBps,
            roundToRupee: round,
          });
          const bill: RefundBill = {
            subtotalPaisa: t.subtotalPaisa,
            discountPaisa: t.discountPaisa,
            serviceChargePaisa: t.serviceChargePaisa,
            roundOffPaisa: t.roundOffPaisa,
            totalPaisa: t.totalPaisa,
          };
          const base: RefundableLine[] = ls.map((l, i) => line(`l${i}`, l.net, l.qty));
          // all at once
          const once = computeRefund(
            bill,
            base,
            base.map((l) => ({ lineId: l.id, qtyMilli: l.qtyMilli })),
          );
          expect(once.totalPaisa).toBe(bill.totalPaisa);
          // one unit at a time, line by line
          let refunded = base.map((l) => ({ ...l }));
          let total = 0;
          let completed = false;
          for (let i = 0; i < base.length; i++) {
            for (let u = 0; u < (base[i] as RefundableLine).qtyMilli / 1000; u++) {
              const step = computeRefund(bill, refunded, [
                { lineId: (base[i] as RefundableLine).id, qtyMilli: 1000 },
              ]);
              total += step.totalPaisa;
              completed = step.completesBill;
              refunded = refunded.map((l, k) =>
                k === i ? { ...l, refundedQtyMilli: l.refundedQtyMilli + 1000 } : l,
              );
            }
          }
          expect(completed).toBe(true);
          expect(total).toBe(bill.totalPaisa);
        },
      ),
    );
  });
});
