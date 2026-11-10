import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeTax, resolveRule, rulesOverlap, TaxError, type TaxRule } from './tax';

const rule = (over: Partial<TaxRule> = {}): TaxRule => ({
  id: 'r1',
  authority: 'PRA',
  categoryId: 'food',
  paymentClass: 'CASH_OTHER',
  rateBps: 1600,
  effectiveFrom: '2026-07-01',
  effectiveTo: null,
  ...over,
});
const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as TaxError).code;
  }
  return undefined;
};
const q = {
  authority: 'PRA',
  categoryId: 'food',
  paymentClass: 'CASH_OTHER' as const,
  date: '2026-08-01',
};

describe('resolveRule', () => {
  it('picks the one rule that applies by authority, category, class and date', () => {
    const rules = [
      rule({ id: 'cash' }),
      rule({ id: 'digital', paymentClass: 'DIGITAL', rateBps: 800 }),
      rule({ id: 'sindh', authority: 'SRB' }),
      rule({ id: 'other-cat', categoryId: 'goods' }),
    ];
    expect(resolveRule(rules, q).id).toBe('cash');
    expect(resolveRule(rules, { ...q, paymentClass: 'DIGITAL' }).id).toBe('digital');
  });

  it('respects the effective dates (inclusive on both ends)', () => {
    const rules = [
      rule({ id: 'old', effectiveFrom: '2025-07-01', effectiveTo: '2026-06-30' }),
      rule({ id: 'new' }),
    ];
    expect(resolveRule(rules, { ...q, date: '2026-06-30' }).id).toBe('old');
    expect(resolveRule(rules, { ...q, date: '2026-07-01' }).id).toBe('new');
  });

  it('an ANY rule serves every class', () => {
    const rules = [rule({ id: 'any', paymentClass: 'ANY' })];
    expect(resolveRule(rules, q).id).toBe('any');
    expect(resolveRule(rules, { ...q, paymentClass: 'DIGITAL' }).id).toBe('any');
  });

  it('is a hard error when nothing applies, and when two rules apply', () => {
    expect(code(() => resolveRule([], q))).toBe('TAX_RULE_MISSING');
    expect(code(() => resolveRule([rule({ effectiveFrom: '2026-09-01' })], q))).toBe(
      'TAX_RULE_MISSING',
    );
    expect(code(() => resolveRule([rule({ effectiveTo: '2026-07-31' })], q))).toBe(
      'TAX_RULE_MISSING',
    );
    expect(code(() => resolveRule([rule({ id: 'a' }), rule({ id: 'b' })], q))).toBe(
      'TAX_RULE_AMBIGUOUS',
    );
    // a class rule next to an ANY rule is ambiguous too: never guess which one the owner meant
    expect(
      code(() => resolveRule([rule({ id: 'a' }), rule({ id: 'b', paymentClass: 'ANY' })], q)),
    ).toBe('TAX_RULE_AMBIGUOUS');
  });
});

const flat = (bps: number) => () => rule({ rateBps: bps });

describe('computeTax', () => {
  it('taxes each line on its net less its discount share, plus the service share when taxable', () => {
    // 60000 + 40000, discount 10000, service 4500 (taxable), 16 %
    const r = computeTax({
      lines: [
        { id: 'a', netPaisa: 60000, categoryId: 'food' },
        { id: 'b', netPaisa: 40000, categoryId: 'food' },
      ],
      discountPaisa: 10000,
      serviceChargePaisa: 4500,
      serviceChargeTaxable: true,
      ruleFor: flat(1600),
    });
    // a: 60000 − 6000 + 2700 = 56700 → 9072 ; b: 40000 − 4000 + 1800 = 37800 → 6048
    expect(r.lines.map((l) => l.taxPaisa)).toEqual([9072, 6048]);
    expect(r.taxPaisa).toBe(15120);
    expect(r.singleRule).toEqual({ ruleId: 'r1', rateBps: 1600 });
  });

  it('leaves the service charge out of the base when it is not taxable', () => {
    const r = computeTax({
      lines: [{ id: 'a', netPaisa: 100000, categoryId: 'food' }],
      discountPaisa: 0,
      serviceChargePaisa: 5000,
      serviceChargeTaxable: false,
      ruleFor: flat(1600),
    });
    expect(r.taxPaisa).toBe(16000);
  });

  it('uses each line’s own category rule and reports no single rule when they differ', () => {
    const r = computeTax({
      lines: [
        { id: 'a', netPaisa: 10000, categoryId: 'food' },
        { id: 'b', netPaisa: 10000, categoryId: 'goods' },
      ],
      discountPaisa: 0,
      serviceChargePaisa: 0,
      serviceChargeTaxable: true,
      ruleFor: (c) =>
        c === 'food' ? rule({ id: 'f', rateBps: 1600 }) : rule({ id: 'g', rateBps: 500 }),
    });
    expect(r.lines.map((l) => [l.ruleId, l.taxPaisa])).toEqual([
      ['f', 1600],
      ['g', 500],
    ]);
    expect(r.singleRule).toBeNull();
  });

  it('rounds half-up per line and a zero rate gives zero tax', () => {
    const r = computeTax({
      lines: [{ id: 'a', netPaisa: 1, categoryId: 'food' }],
      discountPaisa: 0,
      serviceChargePaisa: 0,
      serviceChargeTaxable: true,
      ruleFor: flat(5000),
    });
    expect(r.taxPaisa).toBe(1); // 0.5 → 1
    expect(
      computeTax({
        lines: [{ id: 'a', netPaisa: 999, categoryId: 'food' }],
        discountPaisa: 0,
        serviceChargePaisa: 0,
        serviceChargeTaxable: true,
        ruleFor: flat(0),
      }).taxPaisa,
    ).toBe(0);
  });

  it('a near-total discount can make a line base negative; the parts still add up', () => {
    const r = computeTax({
      lines: [
        { id: 'a', netPaisa: 5000, categoryId: 'food' },
        { id: 'b', netPaisa: 5000, categoryId: 'food' },
        { id: 'c', netPaisa: 2, categoryId: 'food' },
      ],
      discountPaisa: 10001,
      serviceChargePaisa: 0,
      serviceChargeTaxable: true,
      ruleFor: flat(1600),
    });
    expect(r.taxPaisa).toBe(r.lines.reduce((n, l) => n + l.taxPaisa, 0));
  });

  it('refuses a bill with no lines, and propagates a missing rule', () => {
    expect(
      code(() =>
        computeTax({
          lines: [],
          discountPaisa: 0,
          serviceChargePaisa: 0,
          serviceChargeTaxable: true,
          ruleFor: flat(1),
        }),
      ),
    ).toBe('TAX_INPUT_INVALID');
    expect(
      code(() =>
        computeTax({
          lines: [{ id: 'a', netPaisa: 1, categoryId: 'x' }],
          discountPaisa: 0,
          serviceChargePaisa: 0,
          serviceChargeTaxable: true,
          ruleFor: () => resolveRule([], q),
        }),
      ),
    ).toBe('TAX_RULE_MISSING');
  });

  it('the bill tax is always the sum of the line taxes, whatever the numbers (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 3_000_000 }), { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 0, max: 40 }),
        fc.integer({ min: 0, max: 50_000 }),
        fc.integer({ min: 0, max: 3000 }),
        fc.boolean(),
        (nets, discPct, svc, bps, taxable) => {
          const subtotal = nets.reduce((n, v) => n + v, 0);
          const discount = Math.floor((subtotal * discPct) / 100);
          const r = computeTax({
            lines: nets.map((n, i) => ({ id: `l${i}`, netPaisa: n, categoryId: 'food' })),
            discountPaisa: discount,
            serviceChargePaisa: svc,
            serviceChargeTaxable: taxable,
            ruleFor: flat(bps),
          });
          expect(r.taxPaisa).toBe(r.lines.reduce((n, l) => n + l.taxPaisa, 0));
          expect(r.taxPaisa).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });
});

describe('rulesOverlap', () => {
  const base = {
    authority: 'PRA',
    categoryId: 'food',
    paymentClass: 'CASH_OTHER' as const,
    effectiveFrom: '2026-07-01',
    effectiveTo: null,
  };
  it('detects shared days in the same scope', () => {
    expect(rulesOverlap(base, { ...base, effectiveFrom: '2027-01-01' })).toBe(true); // open-ended
    expect(
      rulesOverlap(
        { ...base, effectiveTo: '2026-12-31' },
        { ...base, effectiveFrom: '2027-01-01' },
      ),
    ).toBe(false);
    expect(
      rulesOverlap(
        { ...base, effectiveTo: '2026-12-31' },
        { ...base, effectiveFrom: '2026-12-31' },
      ),
    ).toBe(true);
  });
  it('different scopes never overlap; ANY overlaps every class', () => {
    expect(rulesOverlap(base, { ...base, authority: 'SRB' })).toBe(false);
    expect(rulesOverlap(base, { ...base, categoryId: 'goods' })).toBe(false);
    expect(rulesOverlap(base, { ...base, paymentClass: 'DIGITAL' })).toBe(false);
    expect(rulesOverlap(base, { ...base, paymentClass: 'ANY' })).toBe(true);
  });
});
