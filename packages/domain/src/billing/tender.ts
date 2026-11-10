import { asPaisa, type Paisa } from '../money';

export type TenderClass = 'CASH_OTHER' | 'DIGITAL';

export interface TenderInput {
  methodId: string;
  tenderClass: TenderClass;
  /** The drawer-opening cash method: only cash can be over-tendered and give change. */
  isCash: boolean;
  /** Needs a card RRN / wallet transaction id. */
  needsReference: boolean;
  /** Amount applied to the bill. */
  amountPaisa: Paisa;
  /** Cash handed over (cash only); defaults to the amount. */
  tenderedPaisa?: Paisa | undefined;
  tipPaisa?: Paisa | undefined;
  reference?: string | null | undefined;
}

export type TenderErrorCode =
  | 'TENDER_SUM_MISMATCH'
  | 'TENDER_AMOUNT_INVALID'
  | 'TENDER_TENDERED_TOO_LOW'
  | 'TENDER_CHANGE_NOT_ALLOWED'
  | 'TENDER_REFERENCE_REQUIRED'
  | 'TENDER_TIP_INVALID';

export class TenderError extends Error {
  constructor(
    readonly code: TenderErrorCode,
    message: string,
    readonly extra?: Record<string, number>,
  ) {
    super(message);
  }
}

export interface AppliedTender {
  methodId: string;
  amountPaisa: Paisa;
  tenderedPaisa: Paisa | null;
  changePaisa: Paisa;
  tipPaisa: Paisa;
  reference: string | null;
  tenderClass: TenderClass;
  isCash: boolean;
}

export interface TenderResult {
  applied: AppliedTender[];
  /** Cash to hand back to the customer. */
  changeDuePaisa: Paisa;
  /** Class recorded on the bill (see `taxClassOf`). */
  taxClass: TenderClass;
}

/**
 * Class of the whole bill from its tenders. Policy `HIGHEST_RATE_IF_ANY_NON_DIGITAL`
 * (ARCHITECTURE §6): all digital → DIGITAL, anything else → CASH_OTHER. It is only recorded
 * today; the tax engine (M5) will use it to pick the rate.
 */
export function taxClassOf(tenders: readonly { tenderClass: TenderClass }[]): TenderClass {
  return tenders.length > 0 && tenders.every((t) => t.tenderClass === 'DIGITAL')
    ? 'DIGITAL'
    : 'CASH_OTHER';
}

/**
 * Validates the tenders of ONE settlement against the bill total:
 *  - the amounts applied add up to the total exactly (no under- or over-payment);
 *  - only cash may be tendered above its amount (that difference is the change);
 *  - cards/wallets are exact and need their reference when the method says so;
 *  - tips are never negative and are NOT part of the bill total.
 * A zero-value bill needs no tenders.
 */
export function validateTenders(totalPaisa: Paisa, tenders: readonly TenderInput[]): TenderResult {
  const applied: AppliedTender[] = [];
  let sum = 0;
  let change = 0;

  for (const t of tenders) {
    if (!Number.isSafeInteger(t.amountPaisa) || t.amountPaisa <= 0) {
      throw new TenderError(
        'TENDER_AMOUNT_INVALID',
        'Each tender must be a positive whole number of paisa',
      );
    }
    const tip = t.tipPaisa ?? 0;
    if (!Number.isSafeInteger(tip) || tip < 0)
      throw new TenderError('TENDER_TIP_INVALID', 'A tip cannot be negative');

    let tendered: Paisa | null = null;
    let changePaisa = 0;
    if (t.isCash) {
      tendered = t.tenderedPaisa ?? t.amountPaisa;
      if (!Number.isSafeInteger(tendered) || tendered < t.amountPaisa) {
        throw new TenderError(
          'TENDER_TENDERED_TOO_LOW',
          'The cash handed over is less than the amount applied',
          { amountPaisa: t.amountPaisa },
        );
      }
      changePaisa = tendered - t.amountPaisa;
    } else if (t.tenderedPaisa !== undefined && t.tenderedPaisa !== t.amountPaisa) {
      throw new TenderError(
        'TENDER_CHANGE_NOT_ALLOWED',
        'Only cash can be tendered above the amount; cards and wallets are exact',
      );
    }
    const reference = t.reference?.trim() || null;
    if (t.needsReference && !reference) {
      throw new TenderError(
        'TENDER_REFERENCE_REQUIRED',
        'This payment method needs a reference (card RRN / transaction id)',
      );
    }

    sum += t.amountPaisa;
    change += changePaisa;
    applied.push({
      methodId: t.methodId,
      amountPaisa: t.amountPaisa,
      tenderedPaisa: tendered === null ? null : asPaisa(tendered),
      changePaisa: asPaisa(changePaisa),
      tipPaisa: asPaisa(tip),
      reference,
      tenderClass: t.tenderClass,
      isCash: t.isCash,
    });
  }

  if (sum !== totalPaisa) {
    throw new TenderError(
      'TENDER_SUM_MISMATCH',
      sum < totalPaisa
        ? 'The payments do not cover the bill total'
        : 'The payments are more than the bill total',
      { totalPaisa, paidPaisa: sum },
    );
  }
  return { applied, changeDuePaisa: asPaisa(change), taxClass: taxClassOf(tenders) };
}
