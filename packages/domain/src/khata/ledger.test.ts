import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  assertCanCharge,
  assertCanReceivePayment,
  availableCredit,
  khataBalance,
  khataDelta,
  KhataError,
  type KhataKind,
} from './ledger';

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as KhataError).code;
  }
  return undefined;
};

describe('khataDelta / khataBalance', () => {
  it('charges and upward adjustments add; payments, refunds and downward adjustments subtract', () => {
    expect(khataDelta('CHARGE', 500)).toBe(500);
    expect(khataDelta('ADJUST_UP', 500)).toBe(500);
    expect(khataDelta('PAYMENT', 500)).toBe(-500);
    expect(khataDelta('REFUND', 500)).toBe(-500);
    expect(khataDelta('ADJUST_DOWN', 500)).toBe(-500);
  });

  it('rejects zero, negative and fractional amounts', () => {
    for (const bad of [0, -1, 1.5, Number.NaN])
      expect(code(() => khataDelta('CHARGE', bad))).toBe('KHATA_AMOUNT_INVALID');
  });

  it('the balance is the signed sum, in any order (property)', () => {
    const kinds: KhataKind[] = ['CHARGE', 'PAYMENT', 'ADJUST_UP', 'ADJUST_DOWN', 'REFUND'];
    const entry = fc.record({
      kind: fc.constantFrom(...kinds),
      amountPaisa: fc.integer({ min: 1, max: 10_000_000 }),
    });
    fc.assert(
      fc.property(fc.array(entry, { maxLength: 40 }), (entries) => {
        const total = khataBalance(entries);
        expect(khataBalance([...entries].reverse())).toBe(total);
        expect(total).toBe(entries.reduce((n, e) => n + khataDelta(e.kind, e.amountPaisa), 0));
      }),
    );
    expect(khataBalance([])).toBe(0);
  });
});

describe('credit limit', () => {
  it('available credit is limit − balance and never negative', () => {
    expect(availableCredit(30000, 100000)).toBe(70000);
    expect(availableCredit(100000, 100000)).toBe(0);
    expect(availableCredit(150000, 100000)).toBe(0); // limit lowered below the balance
    expect(availableCredit(-5000, 100000)).toBe(105000); // customer in credit
  });

  it('allows a charge up to exactly the limit and refuses one paisa more', () => {
    expect(() => assertCanCharge(30000, 100000, 70000)).not.toThrow();
    expect(code(() => assertCanCharge(30000, 100000, 70001))).toBe('KHATA_LIMIT_EXCEEDED');
    expect(code(() => assertCanCharge(0, 0, 1))).toBe('KHATA_LIMIT_EXCEEDED'); // no limit = no credit
    expect(code(() => assertCanCharge(0, 100, 0))).toBe('KHATA_AMOUNT_INVALID');
  });

  it('carries the numbers so the cashier can be told what is left', () => {
    try {
      assertCanCharge(30000, 100000, 80000);
    } catch (e) {
      expect((e as KhataError).extra).toEqual({ balancePaisa: 30000, limitPaisa: 100000 });
    }
  });
});

describe('payments', () => {
  it('may clear the balance but not exceed it', () => {
    expect(() => assertCanReceivePayment(50000, 50000)).not.toThrow();
    expect(() => assertCanReceivePayment(50000, 1)).not.toThrow();
    expect(code(() => assertCanReceivePayment(50000, 50001))).toBe('KHATA_OVERPAYMENT');
    expect(code(() => assertCanReceivePayment(0, 1))).toBe('KHATA_OVERPAYMENT');
    expect(code(() => assertCanReceivePayment(100, -1))).toBe('KHATA_AMOUNT_INVALID');
  });
});
