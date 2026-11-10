import { asPaisa, type Paisa } from '../money';

export interface DealOptionDef {
  id: string;
  variantId: string;
  /** Upcharge for a premium choice (can be 0). */
  priceDeltaPaisa: Paisa;
  isDefault: boolean;
}

/** A deal slot: the customer must pick exactly `qty` items from `options` ("choose 1 karahi"). */
export interface DealSlotDef {
  id: string;
  name: string;
  qty: number;
  options: readonly DealOptionDef[];
}

export interface DealPick {
  slotId: string;
  optionId: string;
  /** How many of this option (e.g. 2 × naan). */
  count: number;
}

export type DealErrorCode =
  | 'DEAL_PICK_UNKNOWN_SLOT'
  | 'DEAL_PICK_UNKNOWN_OPTION'
  | 'DEAL_PICK_DUPLICATE'
  | 'DEAL_PICK_COUNT_INVALID'
  | 'DEAL_SLOT_COUNT'
  | 'DEAL_NO_SLOTS'
  | 'DEAL_SLOT_NO_OPTIONS'
  | 'DEAL_SLOT_QTY'
  | 'DEAL_MULTIPLE_DEFAULTS'
  | 'DEAL_DUPLICATE_VARIANT';

export class DealError extends Error {
  constructor(
    readonly code: DealErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface DealSelectionResult {
  /** Sum of option upcharges for ONE deal unit (the deal's base price is on its own price row). */
  upchargePerUnitPaisa: Paisa;
  /** Component lines (display price 0, used for KOT + stock). */
  components: { slotId: string; optionId: string; variantId: string; count: number }[];
}

/** Validates the picks for one deal unit: each slot gets exactly `qty` items from its own options. */
export function validateDealSelection(
  slots: readonly DealSlotDef[],
  picks: readonly DealPick[],
): DealSelectionResult {
  const slotById = new Map(slots.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const perSlot = new Map<string, number>();
  const components: DealSelectionResult['components'] = [];
  let upcharge = 0;

  for (const pick of picks) {
    const slot = slotById.get(pick.slotId);
    if (!slot)
      throw new DealError('DEAL_PICK_UNKNOWN_SLOT', `Slot ${pick.slotId} is not part of this deal`);
    const option = slot.options.find((o) => o.id === pick.optionId);
    if (!option) {
      throw new DealError(
        'DEAL_PICK_UNKNOWN_OPTION',
        `Option ${pick.optionId} is not offered in slot "${slot.name}"`,
      );
    }
    if (!Number.isInteger(pick.count) || pick.count < 1) {
      throw new DealError(
        'DEAL_PICK_COUNT_INVALID',
        `Count for option ${pick.optionId} must be a positive integer`,
      );
    }
    const key = `${pick.slotId}:${pick.optionId}`;
    if (seen.has(key))
      throw new DealError(
        'DEAL_PICK_DUPLICATE',
        `Option ${pick.optionId} listed twice in slot "${slot.name}"`,
      );
    seen.add(key);
    perSlot.set(slot.id, (perSlot.get(slot.id) ?? 0) + pick.count);
    upcharge += option.priceDeltaPaisa * pick.count;
    components.push({
      slotId: slot.id,
      optionId: option.id,
      variantId: option.variantId,
      count: pick.count,
    });
  }

  for (const slot of slots) {
    const n = perSlot.get(slot.id) ?? 0;
    if (n !== slot.qty) {
      throw new DealError(
        'DEAL_SLOT_COUNT',
        `Slot "${slot.name}" needs exactly ${slot.qty} item(s), got ${n}`,
      );
    }
  }
  return { upchargePerUnitPaisa: asPaisa(upcharge), components };
}

/**
 * Picks that can be pre-filled without asking: a slot with a default option gets `qty` of it;
 * a slot with a single option gets `qty` of that (fixed components such as "2 naan").
 * Slots that need a real choice are left out.
 */
export function defaultDealPicks(slots: readonly DealSlotDef[]): DealPick[] {
  const picks: DealPick[] = [];
  for (const slot of slots) {
    const only = slot.options.length === 1 ? slot.options[0] : undefined;
    const chosen = slot.options.find((o) => o.isDefault) ?? only;
    if (chosen) picks.push({ slotId: slot.id, optionId: chosen.id, count: slot.qty });
  }
  return picks;
}

export interface DealDefinitionSlot {
  name: string;
  qty: number;
  options: readonly { variantId: string; isDefault: boolean }[];
}

/** Structural rules for configuring a deal (checked when an admin saves it). */
export function validateDealDefinition(slots: readonly DealDefinitionSlot[]): void {
  if (slots.length === 0) throw new DealError('DEAL_NO_SLOTS', 'A deal needs at least one slot');
  for (const slot of slots) {
    if (!Number.isInteger(slot.qty) || slot.qty < 1) {
      throw new DealError('DEAL_SLOT_QTY', `Slot "${slot.name}": qty must be a positive integer`);
    }
    if (slot.options.length === 0)
      throw new DealError('DEAL_SLOT_NO_OPTIONS', `Slot "${slot.name}" has no options`);
    if (slot.options.filter((o) => o.isDefault).length > 1) {
      throw new DealError(
        'DEAL_MULTIPLE_DEFAULTS',
        `Slot "${slot.name}" has more than one default option`,
      );
    }
    if (new Set(slot.options.map((o) => o.variantId)).size !== slot.options.length) {
      throw new DealError(
        'DEAL_DUPLICATE_VARIANT',
        `Slot "${slot.name}" lists the same item variant twice`,
      );
    }
  }
}
