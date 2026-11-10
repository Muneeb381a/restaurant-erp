import { allocateProRata } from '../allocate';
import { asPaisa, mulDivHalfUp, type Paisa } from '../money';

export type LineKind = 'STANDARD' | 'WEIGHT' | 'DEAL';

export type LineErrorCode =
  | 'LINE_QTY_INVALID'
  | 'LINE_WEIGHT_REQUIRED'
  | 'LINE_WEIGHT_NOT_ALLOWED'
  | 'LINE_WEIGHT_INVALID'
  | 'LINE_NEGATIVE_TOTAL';

export class LineError extends Error {
  constructor(
    readonly code: LineErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const MAX_LINE_QTY = 1000;
export const MAX_WEIGHT_G = 1_000_000; // 1 tonne: anything above is a typo

export interface LineInput {
  kind: LineKind;
  /** Price per unit (STANDARD/DEAL) or per kg (WEIGHT) — the snapshot taken from the price list. */
  unitPricePaisa: Paisa;
  /** Whole units. Must be 1 for WEIGHT lines (the quantity is the weight). */
  qty: number;
  /** Grams, WEIGHT lines only. */
  weightG?: number | undefined;
  /** Sum of the selected modifiers' deltas for ONE unit (from validateModifierSelection). */
  modifiersDeltaPerUnitPaisa?: Paisa | undefined;
  /** Sum of the chosen deal options' upcharges for ONE deal (from validateDealSelection). */
  dealUpchargePerUnitPaisa?: Paisa | undefined;
}

export interface PricedLine {
  /** Authoritative line amount, before bill-level discount and tax. */
  lineTotalPaisa: Paisa;
  /** Modifier total for the whole line (delta × qty; once for a weight line). */
  modifiersTotalPaisa: Paisa;
  /** What one unit costs including modifiers/upcharge (for a WEIGHT line: the weighed price). */
  unitTotalPaisa: Paisa;
}

/**
 * Prices one order line with integer math only.
 *  - STANDARD: (unit + modifiers) × qty
 *  - DEAL:     (deal price + option upcharges + modifiers) × qty
 *  - WEIGHT:   round_half_up(price_per_kg × grams / 1000) + modifiers
 * A line can never be negative (a discount modifier cannot push it below zero).
 */
export function priceLine(input: LineInput): PricedLine {
  const { kind, unitPricePaisa, qty, weightG } = input;
  const modDelta = input.modifiersDeltaPerUnitPaisa ?? 0;
  const upcharge = input.dealUpchargePerUnitPaisa ?? 0;

  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_LINE_QTY) {
    throw new LineError(
      'LINE_QTY_INVALID',
      `qty must be a whole number from 1 to ${MAX_LINE_QTY}, got ${qty}`,
    );
  }

  if (kind === 'WEIGHT') {
    if (weightG === undefined)
      throw new LineError('LINE_WEIGHT_REQUIRED', 'A WEIGHT line needs weightG');
    if (!Number.isInteger(weightG) || weightG < 1 || weightG > MAX_WEIGHT_G) {
      throw new LineError(
        'LINE_WEIGHT_INVALID',
        `weightG must be a whole number of grams from 1 to ${MAX_WEIGHT_G}`,
      );
    }
    if (qty !== 1)
      throw new LineError(
        'LINE_QTY_INVALID',
        'A WEIGHT line has qty 1; the quantity is its weight',
      );
    const weighed = mulDivHalfUp(unitPricePaisa, weightG, 1000);
    return finish(weighed + modDelta, modDelta, weighed);
  }

  if (weightG !== undefined) {
    throw new LineError('LINE_WEIGHT_NOT_ALLOWED', `${kind} lines do not take a weight`);
  }
  const unitTotal = unitPricePaisa + (kind === 'DEAL' ? upcharge : 0) + modDelta;
  return finish(unitTotal * qty, modDelta * qty, unitTotal);
}

function finish(total: number, modifiersTotal: number, unitTotal: number): PricedLine {
  if (total < 0)
    throw new LineError('LINE_NEGATIVE_TOTAL', 'Modifiers cannot make a line negative');
  return {
    lineTotalPaisa: asPaisa(total),
    modifiersTotalPaisa: asPaisa(modifiersTotal),
    unitTotalPaisa: asPaisa(unitTotal),
  };
}

export interface DealComponent {
  /** Caller's key for the component line (e.g. order_item id). */
  key: string;
  /** The component's own list price (used only as the allocation weight). */
  listPricePaisa: Paisa;
  /** How many of it this deal contains. */
  count: number;
}

/**
 * Deal price allocation (ARCHITECTURE §5 rule 4): the deal's line total is spread over its
 * component lines pro-rata to their list prices so reports and tax-by-category work; leftover
 * paisa go to the last component. The parts always add up to the line total.
 */
export function allocateDealLine(
  lineTotalPaisa: Paisa,
  components: readonly DealComponent[],
): { key: string; allocatedPaisa: Paisa }[] {
  const weights = components.map((c) => c.listPricePaisa * c.count);
  const parts = allocateProRata(lineTotalPaisa, weights);
  return components.map((c, i) => ({ key: c.key, allocatedPaisa: parts[i] as Paisa }));
}

/** Σ of live (non-void) top-level lines. Deal component lines carry price 0 and are not summed. */
export function orderSubtotal(
  lines: readonly {
    lineTotalPaisa: Paisa;
    status: string;
    parentLineId?: string | null | undefined;
  }[],
): Paisa {
  return asPaisa(
    lines
      .filter((l) => l.status !== 'VOID' && !l.parentLineId)
      .reduce((acc, l) => acc + l.lineTotalPaisa, 0),
  );
}
