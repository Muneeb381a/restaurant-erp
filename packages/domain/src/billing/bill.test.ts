import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MoneyError, asPaisa } from '../money';
import {
  BillError,
  computeBill,
  discountAmount,
  discountBps,
  discountNeedsApproval,
  roundToRupee,
} from './bill';

const p = asPaisa;
const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as BillError).code;
  }
  return undefined;
};

describe('roundToRupee (nearest rupee, halves up)', () => {
  it.each([
    [0, 0, 0],
    [100, 100, 0],
    [149, 100, -49],
    [150, 200, 50], // exactly half → up
    [151, 200, 49],
    [99, 100, 1],
    [49, 0, -49],
    [123456, 123500, 44],
  ])('%i → %i (round-off %i)', (total, rounded, off) => {
    expect(roundToRupee(p(total))).toEqual({ totalPaisa: rounded, roundOffPaisa: off });
  });

  it('property: result is a multiple of 100 within 50 paisa of the input', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000_000 }), (n) => {
        const r = roundToRupee(p(n));
        expect(r.totalPaisa % 100).toBe(0);
        expect(Math.abs(r.roundOffPaisa)).toBeLessThanOrEqual(50);
        expect(r.totalPaisa).toBe(n + r.roundOffPaisa);
      }),
    );
  });
});

describe('discountAmount', () => {
  it('percent of the subtotal, rounded half up', () => {
    expect(discountAmount(p(100000), { kind: 'PERCENT_BPS', bps: 1000 })).toBe(10000);
    expect(discountAmount(p(333), { kind: 'PERCENT_BPS', bps: 1000 })).toBe(33); // 33.3 → 33
    expect(discountAmount(p(335), { kind: 'PERCENT_BPS', bps: 1000 })).toBe(34); // 33.5 → 34
    expect(discountAmount(p(500), { kind: 'PERCENT_BPS', bps: 10_000 })).toBe(500);
    expect(discountAmount(p(500), { kind: 'PERCENT_BPS', bps: 0 })).toBe(0);
  });

  it('an amount, up to the subtotal; none means zero', () => {
    expect(discountAmount(p(1000), { kind: 'AMOUNT', paisa: p(1000) })).toBe(1000);
    expect(discountAmount(p(1000), { kind: 'AMOUNT', paisa: p(0) })).toBe(0);
    expect(discountAmount(p(1000), null)).toBe(0);
    expect(discountAmount(p(1000), undefined)).toBe(0);
  });

  it('rejects impossible discounts', () => {
    expect(code(() => discountAmount(p(1000), { kind: 'AMOUNT', paisa: p(1001) }))).toBe(
      'DISCOUNT_EXCEEDS_SUBTOTAL',
    );
    expect(code(() => discountAmount(p(1000), { kind: 'AMOUNT', paisa: -1 as never }))).toBe(
      'DISCOUNT_INVALID',
    );
    expect(code(() => discountAmount(p(1000), { kind: 'AMOUNT', paisa: 1.5 as never }))).toBe(
      'DISCOUNT_INVALID',
    );
    for (const bps of [-1, 10_001, 1.5])
      expect(code(() => discountAmount(p(1000), { kind: 'PERCENT_BPS', bps }))).toBe(
        'DISCOUNT_INVALID',
      );
  });
});

describe('computeBill', () => {
  it('no extras: total = subtotal', () => {
    expect(computeBill({ subtotalPaisa: p(125000), roundToRupee: false })).toEqual({
      subtotalPaisa: 125000,
      discountPaisa: 0,
      serviceChargePaisa: 0,
      taxablePaisa: 125000,
      taxPaisa: 0,
      roundOffPaisa: 0,
      totalPaisa: 125000,
    });
  });

  it('discount first, service charge on what remains, then rounding', () => {
    // Rs 1,234.56 − 10% (123.456 → 123.46) = 1,111.10 ; + 5% service (55.555 → 55.56) = 1,166.66 ; round → 1,167
    const t = computeBill({
      subtotalPaisa: p(123456),
      discount: { kind: 'PERCENT_BPS', bps: 1000 },
      serviceChargeBps: 500,
      roundToRupee: true,
    });
    expect(t).toEqual({
      subtotalPaisa: 123456,
      discountPaisa: 12346,
      serviceChargePaisa: 5556, // 55.555 → 55.56 (halves up)
      taxablePaisa: 116666,
      taxPaisa: 0,
      roundOffPaisa: 34,
      totalPaisa: 116700,
    });
  });

  it('the tax slot is added before rounding (for the tax engine)', () => {
    const t = computeBill({ subtotalPaisa: p(100000), taxPaisa: p(16000), roundToRupee: true });
    expect(t.totalPaisa).toBe(116000);
    expect(t.taxablePaisa).toBe(100000); // tax is not part of "taxable"
    const odd = computeBill({ subtotalPaisa: p(100049), taxPaisa: p(16008), roundToRupee: true });
    expect(odd.totalPaisa).toBe(116100); // 116,057 → 116,100
    expect(odd.roundOffPaisa).toBe(43);
  });

  it('rejects invalid service charge and tax', () => {
    for (const bps of [-1, 10_001, 0.5])
      expect(
        code(() =>
          computeBill({ subtotalPaisa: p(1000), serviceChargeBps: bps, roundToRupee: false }),
        ),
      ).toBe('SERVICE_CHARGE_INVALID');
    expect(
      code(() =>
        computeBill({ subtotalPaisa: p(1000), taxPaisa: -1 as never, roundToRupee: false }),
      ),
    ).toBe('TAX_INVALID');
    expect(() =>
      computeBill({ subtotalPaisa: p(1000), taxPaisa: 1.5 as never, roundToRupee: false }),
    ).toThrow(BillError);
  });

  it('a zero bill stays zero; a 100 % discount is a free bill', () => {
    expect(
      computeBill({ subtotalPaisa: p(0), serviceChargeBps: 500, roundToRupee: true }).totalPaisa,
    ).toBe(0);
    const free = computeBill({
      subtotalPaisa: p(54321),
      discount: { kind: 'PERCENT_BPS', bps: 10_000 },
      serviceChargeBps: 500,
      roundToRupee: true,
    });
    expect(free.totalPaisa).toBe(0);
    expect(free.serviceChargePaisa).toBe(0);
  });

  it('property: the DB invariants always hold (taxable math, total math, non-negative, ≤ 50 paisa round-off)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 500_000_000 }),
        fc.oneof(
          fc.constant(null),
          fc.integer({ min: 0, max: 10_000 }).map((bps) => ({ kind: 'PERCENT_BPS' as const, bps })),
        ),
        fc.integer({ min: 0, max: 3000 }),
        fc.integer({ min: 0, max: 100_000_000 }),
        fc.boolean(),
        (subtotal, discount, service, tax, round) => {
          const t = computeBill({
            subtotalPaisa: p(subtotal),
            discount,
            serviceChargeBps: service,
            taxPaisa: p(tax),
            roundToRupee: round,
          });
          expect(t.taxablePaisa).toBe(t.subtotalPaisa - t.discountPaisa + t.serviceChargePaisa); // bill_taxable_math
          expect(t.totalPaisa).toBe(t.taxablePaisa + t.taxPaisa + t.roundOffPaisa); // bill_total_math
          expect(t.discountPaisa).toBeLessThanOrEqual(t.subtotalPaisa);
          expect(t.totalPaisa).toBeGreaterThanOrEqual(0);
          expect(Math.abs(t.roundOffPaisa)).toBeLessThanOrEqual(round ? 50 : 0);
          if (round) expect(t.totalPaisa % 100).toBe(0);
        },
      ),
    );
  });

  it('inherits the money guards', () => {
    expect(() => computeBill({ subtotalPaisa: 1.5 as never, roundToRupee: false })).toThrow(
      MoneyError,
    );
  });
});

describe('discount approval', () => {
  it('measures the discount in basis points of the subtotal, rounded up', () => {
    expect(discountBps(p(1000), p(10000))).toBe(1000);
    expect(discountBps(p(1), p(3))).toBe(3334); // never rounds the discount down
    expect(discountBps(p(0), p(0))).toBe(0);
  });

  it("needs an approver only above the user's own limit", () => {
    expect(discountNeedsApproval(p(1000), p(10000), 1000)).toBe(false); // exactly at the limit
    expect(discountNeedsApproval(p(1001), p(10000), 1000)).toBe(true);
    expect(discountNeedsApproval(p(1), p(10000), 0)).toBe(true); // a user with no limit needs approval for anything
    expect(discountNeedsApproval(p(0), p(10000), 0)).toBe(false);
  });
});
