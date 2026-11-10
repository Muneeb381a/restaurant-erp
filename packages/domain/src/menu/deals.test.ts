import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { asPaisa } from '../money';
import {
  DealError,
  defaultDealPicks,
  validateDealDefinition,
  validateDealSelection,
  type DealSlotDef,
} from './deals';

const opt = (id: string, variantId: string, delta = 0, isDefault = false) => ({
  id,
  variantId,
  priceDeltaPaisa: asPaisa(delta),
  isDefault,
});

// "Family deal": choose 1 karahi (mutton costs +Rs 500), 4 naan fixed, choose 2 drinks
const slots: DealSlotDef[] = [
  {
    id: 'karahi',
    name: 'Karahi',
    qty: 1,
    options: [opt('k-chicken', 'v-ck', 0, true), opt('k-mutton', 'v-mk', 50000)],
  },
  { id: 'naan', name: 'Naan', qty: 4, options: [opt('n-plain', 'v-naan')] },
  {
    id: 'drink',
    name: 'Drinks',
    qty: 2,
    options: [
      opt('d-cola', 'v-cola'),
      opt('d-sprite', 'v-sprite'),
      opt('d-lassi', 'v-lassi', 8000),
    ],
  },
];

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as DealError).code;
  }
  return undefined;
}

describe('validateDealSelection', () => {
  it('accepts a complete valid selection and totals upcharges', () => {
    const r = validateDealSelection(slots, [
      { slotId: 'karahi', optionId: 'k-mutton', count: 1 },
      { slotId: 'naan', optionId: 'n-plain', count: 4 },
      { slotId: 'drink', optionId: 'd-cola', count: 1 },
      { slotId: 'drink', optionId: 'd-lassi', count: 1 },
    ]);
    expect(r.upchargePerUnitPaisa).toBe(58000);
    expect(r.components).toHaveLength(4);
    expect(r.components[0]).toEqual({
      slotId: 'karahi',
      optionId: 'k-mutton',
      variantId: 'v-mk',
      count: 1,
    });
  });

  it('allows the same option several times via count, no upcharge for free choices', () => {
    const r = validateDealSelection(slots, [
      { slotId: 'karahi', optionId: 'k-chicken', count: 1 },
      { slotId: 'naan', optionId: 'n-plain', count: 4 },
      { slotId: 'drink', optionId: 'd-sprite', count: 2 },
    ]);
    expect(r.upchargePerUnitPaisa).toBe(0);
  });

  it('multiplies upcharges by count', () => {
    const r = validateDealSelection(slots, [
      { slotId: 'karahi', optionId: 'k-chicken', count: 1 },
      { slotId: 'naan', optionId: 'n-plain', count: 4 },
      { slotId: 'drink', optionId: 'd-lassi', count: 2 },
    ]);
    expect(r.upchargePerUnitPaisa).toBe(16000);
  });

  it('requires exactly qty per slot (too few, too many, missing slot)', () => {
    const base = [
      { slotId: 'karahi', optionId: 'k-chicken', count: 1 },
      { slotId: 'naan', optionId: 'n-plain', count: 4 },
    ];
    expect(
      code(() =>
        validateDealSelection(slots, [...base, { slotId: 'drink', optionId: 'd-cola', count: 1 }]),
      ),
    ).toBe('DEAL_SLOT_COUNT');
    expect(
      code(() =>
        validateDealSelection(slots, [...base, { slotId: 'drink', optionId: 'd-cola', count: 3 }]),
      ),
    ).toBe('DEAL_SLOT_COUNT');
    expect(code(() => validateDealSelection(slots, base))).toBe('DEAL_SLOT_COUNT');
    expect(code(() => validateDealSelection(slots, []))).toBe('DEAL_SLOT_COUNT');
  });

  it('rejects an option from another slot, an unknown slot, duplicates and bad counts', () => {
    const ok = [
      { slotId: 'naan', optionId: 'n-plain', count: 4 },
      { slotId: 'karahi', optionId: 'k-chicken', count: 1 },
    ];
    expect(
      code(() =>
        validateDealSelection(slots, [...ok, { slotId: 'drink', optionId: 'k-mutton', count: 2 }]),
      ),
    ).toBe('DEAL_PICK_UNKNOWN_OPTION');
    expect(
      code(() => validateDealSelection(slots, [{ slotId: 'ghost', optionId: 'x', count: 1 }])),
    ).toBe('DEAL_PICK_UNKNOWN_SLOT');
    expect(
      code(() =>
        validateDealSelection(slots, [
          ...ok,
          { slotId: 'drink', optionId: 'd-cola', count: 1 },
          { slotId: 'drink', optionId: 'd-cola', count: 1 },
        ]),
      ),
    ).toBe('DEAL_PICK_DUPLICATE');
    for (const count of [0, -1, 1.5]) {
      expect(
        code(() =>
          validateDealSelection(slots, [{ slotId: 'karahi', optionId: 'k-chicken', count }]),
        ),
      ).toBe('DEAL_PICK_COUNT_INVALID');
    }
  });

  it("property: any split of qty across a slot's options validates and sums components to qty", () => {
    const slot: DealSlotDef = {
      id: 's',
      name: 'S',
      qty: 6,
      options: [opt('a', 'va', 100), opt('b', 'vb', 200), opt('c', 'vc', 0)],
    };
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 6 }), fc.integer({ min: 0, max: 6 }), (x, y) => {
        fc.pre(x + y <= 6);
        const counts = { a: x, b: y, c: 6 - x - y };
        const picks = (['a', 'b', 'c'] as const)
          .filter((k) => counts[k] > 0)
          .map((k) => ({ slotId: 's', optionId: k, count: counts[k] }));
        const r = validateDealSelection([slot], picks);
        expect(r.components.reduce((n, c) => n + c.count, 0)).toBe(6);
        expect(r.upchargePerUnitPaisa).toBe(counts.a * 100 + counts.b * 200);
      }),
    );
  });
});

describe('defaultDealPicks', () => {
  it('pre-fills default options and single-option (fixed) slots, leaves real choices open', () => {
    expect(defaultDealPicks(slots)).toEqual([
      { slotId: 'karahi', optionId: 'k-chicken', count: 1 },
      { slotId: 'naan', optionId: 'n-plain', count: 4 },
    ]);
  });

  it('a fully fixed deal validates from its defaults alone', () => {
    const fixed: DealSlotDef[] = [
      { id: 'a', name: 'Tikka', qty: 2, options: [opt('a1', 'va')] },
      { id: 'b', name: 'Drink', qty: 1, options: [opt('b1', 'vb', 0, true), opt('b2', 'vc')] },
    ];
    expect(() => validateDealSelection(fixed, defaultDealPicks(fixed))).not.toThrow();
  });
});

describe('validateDealDefinition', () => {
  const good = {
    name: 'Karahi',
    qty: 1,
    options: [
      { variantId: 'v1', isDefault: true },
      { variantId: 'v2', isDefault: false },
    ],
  };

  it('accepts a sensible deal', () => {
    expect(() =>
      validateDealDefinition([
        good,
        { name: 'Naan', qty: 4, options: [{ variantId: 'v3', isDefault: false }] },
      ]),
    ).not.toThrow();
  });

  it('rejects structural problems', () => {
    expect(code(() => validateDealDefinition([]))).toBe('DEAL_NO_SLOTS');
    expect(code(() => validateDealDefinition([{ ...good, qty: 0 }]))).toBe('DEAL_SLOT_QTY');
    expect(code(() => validateDealDefinition([{ ...good, qty: 1.5 }]))).toBe('DEAL_SLOT_QTY');
    expect(code(() => validateDealDefinition([{ ...good, options: [] }]))).toBe(
      'DEAL_SLOT_NO_OPTIONS',
    );
    expect(
      code(() =>
        validateDealDefinition([
          {
            ...good,
            options: [
              { variantId: 'a', isDefault: true },
              { variantId: 'b', isDefault: true },
            ],
          },
        ]),
      ),
    ).toBe('DEAL_MULTIPLE_DEFAULTS');
    expect(
      code(() =>
        validateDealDefinition([
          {
            ...good,
            options: [
              { variantId: 'a', isDefault: false },
              { variantId: 'a', isDefault: false },
            ],
          },
        ]),
      ),
    ).toBe('DEAL_DUPLICATE_VARIANT');
  });
});
