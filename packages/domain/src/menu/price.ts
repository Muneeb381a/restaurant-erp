import type { Paisa } from '../money';

/** ISO calendar date `YYYY-MM-DD` — always a *business* date, never a timestamp. */
export type IsoDate = string;

export interface PriceRow {
  variantId: string;
  priceListId: string;
  pricePaisa: Paisa;
  effectiveFrom: IsoDate;
  /** Inclusive; null = open-ended. */
  effectiveTo: IsoDate | null;
}

export type PriceErrorCode = 'PRICE_MISSING' | 'PRICE_AMBIGUOUS' | 'PRICE_INVALID_DATE';

/** Same philosophy as tax rules: never guess. No price / two prices is a hard error. */
export class PriceError extends Error {
  constructor(
    readonly code: PriceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function assertIsoDate(date: string): void {
  if (!ISO_DATE.test(date))
    throw new PriceError('PRICE_INVALID_DATE', `Not a YYYY-MM-DD date: ${date}`);
}

/**
 * The price in force for (variant, price list) on a business date, or null if none
 * (the item is then simply not sold on that channel). Two matching rows → PRICE_AMBIGUOUS.
 * ISO dates compare correctly as strings.
 */
export function findPrice(
  rows: readonly PriceRow[],
  variantId: string,
  priceListId: string,
  businessDate: IsoDate,
): Paisa | null {
  assertIsoDate(businessDate);
  const active = rows.filter(
    (r) =>
      r.variantId === variantId &&
      r.priceListId === priceListId &&
      r.effectiveFrom <= businessDate &&
      (r.effectiveTo === null || r.effectiveTo >= businessDate),
  );
  if (active.length > 1) {
    throw new PriceError(
      'PRICE_AMBIGUOUS',
      `${active.length} prices overlap for variant ${variantId} on ${businessDate}`,
    );
  }
  return active[0]?.pricePaisa ?? null;
}

/** Like `findPrice` but a missing price is an error — use when an order line is being priced. */
export function resolvePrice(
  rows: readonly PriceRow[],
  variantId: string,
  priceListId: string,
  businessDate: IsoDate,
): Paisa {
  const price = findPrice(rows, variantId, priceListId, businessDate);
  if (price === null) {
    throw new PriceError(
      'PRICE_MISSING',
      `No price for variant ${variantId} in price list ${priceListId} on ${businessDate}`,
    );
  }
  return price;
}

/** The calendar day before an ISO date (used to close the previous price period). */
export function dayBefore(date: IsoDate): IsoDate {
  assertIsoDate(date);
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
