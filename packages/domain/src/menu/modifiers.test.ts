import { describe, expect, it } from 'vitest';
import { asPaisa } from '../money';
import { ModifierError, validateModifierSelection, type ModifierGroupDef } from './modifiers';

const m = (id: string, delta = 0, isActive = true) => ({
  id,
  priceDeltaPaisa: asPaisa(delta),
  isActive,
});

const spice: ModifierGroupDef = {
  id: 'spice',
  minSelect: 1,
  maxSelect: 1,
  modifiers: [m('mild'), m('hot'), m('extra-hot', 0), m('retired', 0, false)],
};
const extras: ModifierGroupDef = {
  id: 'extras',
  minSelect: 0,
  maxSelect: 2,
  modifiers: [m('raita', 5000), m('salad', 3000), m('chutney', 1000)],
};

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as ModifierError).code;
  }
  return undefined;
}

describe('validateModifierSelection', () => {
  it('accepts a valid selection and sums the price deltas', () => {
    const r = validateModifierSelection([spice, extras], ['hot', 'raita', 'salad']);
    expect(r.deltaPerUnitPaisa).toBe(8000);
    expect(r.selected.map((s) => s.modifierId)).toEqual(['hot', 'raita', 'salad']);
    expect(r.selected[1]).toEqual({
      modifierId: 'raita',
      groupId: 'extras',
      priceDeltaPaisa: 5000,
    });
  });

  it('allows an empty selection when no group has a minimum', () => {
    expect(validateModifierSelection([extras], []).deltaPerUnitPaisa).toBe(0);
    expect(validateModifierSelection([], []).selected).toEqual([]);
  });

  it('enforces the group minimum', () => {
    expect(code(() => validateModifierSelection([spice], []))).toBe('MODIFIER_GROUP_MIN');
    expect(code(() => validateModifierSelection([spice, extras], ['raita']))).toBe(
      'MODIFIER_GROUP_MIN',
    );
  });

  it('enforces the group maximum', () => {
    expect(code(() => validateModifierSelection([spice], ['mild', 'hot']))).toBe(
      'MODIFIER_GROUP_MAX',
    );
    expect(
      code(() => validateModifierSelection([spice, extras], ['mild', 'raita', 'salad', 'chutney'])),
    ).toBe('MODIFIER_GROUP_MAX');
  });

  it('accepts exactly min and exactly max', () => {
    expect(() => validateModifierSelection([spice, extras], ['mild'])).not.toThrow();
    expect(() =>
      validateModifierSelection([spice, extras], ['mild', 'raita', 'salad']),
    ).not.toThrow();
  });

  it('rejects modifiers that are not attached to the item', () => {
    expect(code(() => validateModifierSelection([spice], ['mild', 'raita']))).toBe(
      'MODIFIER_UNKNOWN',
    );
    expect(code(() => validateModifierSelection([spice], ['nope']))).toBe('MODIFIER_UNKNOWN');
  });

  it('rejects inactive and duplicated modifiers', () => {
    expect(code(() => validateModifierSelection([spice], ['retired']))).toBe('MODIFIER_INACTIVE');
    expect(code(() => validateModifierSelection([spice, extras], ['mild', 'raita', 'raita']))).toBe(
      'MODIFIER_DUPLICATE',
    );
  });

  it('reports which group failed', () => {
    try {
      validateModifierSelection([spice], []);
    } catch (e) {
      expect((e as ModifierError).groupId).toBe('spice');
    }
  });

  it('supports negative deltas (discounted option)', () => {
    const g: ModifierGroupDef = {
      id: 'g',
      minSelect: 0,
      maxSelect: 1,
      modifiers: [m('boneless', 20000), m('no-raita', -1000)],
    };
    expect(validateModifierSelection([g], ['no-raita']).deltaPerUnitPaisa).toBe(-1000);
  });
});
