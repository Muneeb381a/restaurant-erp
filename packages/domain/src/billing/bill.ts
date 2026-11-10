import { asPaisa, mulDivHalfUp, type Paisa } from '../money';

export type Discount = { kind: 'PERCENT_BPS'; bps: number } | { kind: 'AMOUNT'; paisa: Paisa };

export type BillErrorCode =
  'DISCOUNT_INVALID' | 'DISCOUNT_EXCEEDS_SUBTOTAL' | 'SERVICE_CHARGE_INVALID' | 'TAX_INVALID';

export class BillError extends Error {
  constructor(
    readonly code: BillErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface BillInput {
  /** Σ of the live order lines (server-computed, never client-supplied). */
  subtotalPaisa: Paisa;
  discount?: Discount | null | undefined;
  /** Service charge in basis points of (subtotal − discount); 0 = none. */
  serviceChargeBps?: number | undefined;
  /**
   * Tax, supplied by the tax engine (M5). Until that exists the caller passes 0 — the bill
   * arithmetic (`total = taxable + tax + roundOff`) is already the final one.
   */
  taxPaisa?: Paisa | undefined;
  /** Round the total to the nearest rupee (setting `billing.round_to_rupee`). */
  roundToRupee: boolean;
}

export interface BillTotals {
  subtotalPaisa: Paisa;
  discountPaisa: Paisa;
  serviceChargePaisa: Paisa;
  /** subtotal − discount + service charge (matches the `bill_taxable_math` DB constraint). */
  taxablePaisa: Paisa;
  taxPaisa: Paisa;
  /** total − (taxable + tax); negative when rounding down. */
  roundOffPaisa: Paisa;
  totalPaisa: Paisa;
}

/** Rounds to the nearest rupee, halves up. Returns the rounded total and the difference. */
export function roundToRupee(totalPaisa: Paisa): { totalPaisa: Paisa; roundOffPaisa: Paisa } {
  const rounded = asPaisa(mulDivHalfUp(totalPaisa, 1, 100) * 100);
  return { totalPaisa: rounded, roundOffPaisa: asPaisa(rounded - totalPaisa) };
}

export function discountAmount(subtotalPaisa: Paisa, discount: Discount | null | undefined): Paisa {
  if (!discount) return asPaisa(0);
  if (discount.kind === 'PERCENT_BPS') {
    if (!Number.isInteger(discount.bps) || discount.bps < 0 || discount.bps > 10_000) {
      throw new BillError('DISCOUNT_INVALID', 'A percentage discount must be between 0 and 100 %');
    }
    return mulDivHalfUp(subtotalPaisa, discount.bps, 10_000);
  }
  if (!Number.isSafeInteger(discount.paisa) || discount.paisa < 0) {
    throw new BillError('DISCOUNT_INVALID', 'A discount amount cannot be negative');
  }
  if (discount.paisa > subtotalPaisa) {
    throw new BillError(
      'DISCOUNT_EXCEEDS_SUBTOTAL',
      'The discount cannot be more than the bill subtotal',
    );
  }
  return discount.paisa;
}

/**
 * The bill arithmetic, in the order ARCHITECTURE §6 specifies:
 * discount first, then service charge on what remains, then tax, then round-off.
 */
export function computeBill(input: BillInput): BillTotals {
  const bps = input.serviceChargeBps ?? 0;
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new BillError('SERVICE_CHARGE_INVALID', 'Service charge must be between 0 and 100 %');
  }
  const tax = input.taxPaisa ?? asPaisa(0);
  if (!Number.isSafeInteger(tax) || tax < 0)
    throw new BillError('TAX_INVALID', 'Tax cannot be negative');

  const discountPaisa = discountAmount(input.subtotalPaisa, input.discount);
  const afterDiscount = input.subtotalPaisa - discountPaisa;
  const serviceChargePaisa = mulDivHalfUp(afterDiscount, bps, 10_000);
  const taxablePaisa = asPaisa(afterDiscount + serviceChargePaisa);
  const before = asPaisa(taxablePaisa + tax);
  const { totalPaisa, roundOffPaisa } = input.roundToRupee
    ? roundToRupee(before)
    : { totalPaisa: before, roundOffPaisa: asPaisa(0) };
  return {
    subtotalPaisa: input.subtotalPaisa,
    discountPaisa,
    serviceChargePaisa,
    taxablePaisa,
    taxPaisa: tax,
    roundOffPaisa,
    totalPaisa,
  };
}

/** A discount expressed in basis points of the subtotal, rounded UP so limits can't be dodged. */
export function discountBps(discountPaisa: Paisa, subtotalPaisa: Paisa): number {
  if (subtotalPaisa === 0) return 0;
  return Math.ceil((discountPaisa * 10_000) / subtotalPaisa);
}

/** True when the discount is above the user's own limit and an approver is needed. */
export function discountNeedsApproval(
  discountPaisa: Paisa,
  subtotalPaisa: Paisa,
  userLimitBps: number,
): boolean {
  return discountBps(discountPaisa, subtotalPaisa) > userLimitBps;
}
