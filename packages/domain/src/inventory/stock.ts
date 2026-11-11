import { asPaisa, type Paisa } from '../money';

/**
 * Stock and recipe-cost maths, all in integers so nothing drifts:
 *  - quantities are MILLI-units of the base unit (1 g, 1 ml or 1 pc = 1000),
 *  - purchase-to-base factors are scaled by 1e4 (numeric(14,4)),
 *  - costs per base unit are MICRO-paisa (paisa × 1e6), because 1 g of gosht can cost 0.18 paisa/mg-scale fractions.
 * Rounding is half-up everywhere (CLAUDE.md rule 1).
 */

export class StockError extends Error {
  constructor(
    readonly code: 'STOCK_INVALID_INPUT' | 'STOCK_DECIMAL_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'StockError';
  }
}

const big = (n: number): bigint => BigInt(n);
const need = (cond: boolean, msg: string): void => {
  if (!cond) throw new StockError('STOCK_INVALID_INPUT', msg);
};
/** Half-up division of non-negative BigInts. */
const divRound = (num: bigint, den: bigint): bigint => (2n * num + den) / (2n * den);

/** "12.5" -> 12500 (scale 3). Rejects more decimals than the scale, signs and junk. */
export function parseScaled(text: string, scale: number): number {
  const m = /^(\d{1,12})(?:\.(\d+))?$/.exec(text.trim());
  if (!m || (m[2] ?? '').length > scale)
    throw new StockError(
      'STOCK_DECIMAL_INVALID',
      `"${text}" is not a number with at most ${scale} decimals`,
    );
  return Number(m[1]) * 10 ** scale + Number((m[2] ?? '').padEnd(scale, '0'));
}
export const formatScaled = (value: number, scale: number): string => {
  const neg = value < 0;
  const abs = Math.abs(value);
  const whole = Math.floor(abs / 10 ** scale);
  const frac = String(abs % 10 ** scale)
    .padStart(scale, '0')
    .replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
};

/** A quantity in the purchase unit (milli) -> base units (milli), e.g. 2.5 kg × 1000 g/kg = 2500 g. */
export function purchaseToBaseMilli(qtyPurchaseMilli: number, purchaseToBase1e4: number): number {
  need(
    Number.isSafeInteger(qtyPurchaseMilli) && qtyPurchaseMilli > 0,
    'quantity must be above zero',
  );
  need(
    Number.isSafeInteger(purchaseToBase1e4) && purchaseToBase1e4 > 0,
    'conversion factor must be above zero',
  );
  return Number(divRound(big(qtyPurchaseMilli) * big(purchaseToBase1e4), 10_000n));
}

/**
 * Cost of one USABLE base unit (micro-paisa) from a price per purchase unit: bones and fat are paid for
 * but not served, so the usable cost is price ÷ factor ÷ yield.
 */
export function unitCostMicro(
  unitCostPaisaPerPurchase: number,
  purchaseToBase1e4: number,
  yieldBps: number,
): number {
  need(
    Number.isSafeInteger(unitCostPaisaPerPurchase) && unitCostPaisaPerPurchase >= 0,
    'unit cost must be a whole paisa amount',
  );
  need(
    Number.isSafeInteger(purchaseToBase1e4) && purchaseToBase1e4 > 0,
    'conversion factor must be above zero',
  );
  need(
    Number.isSafeInteger(yieldBps) && yieldBps >= 1 && yieldBps <= 10_000,
    'yield must be 1..10000 bps',
  );
  // paisa × 1e6 (micro) × 1e4 (factor scale) × 1e4 (bps scale) / factor / yield
  return Number(
    divRound(
      big(unitCostPaisaPerPurchase) * 1_000_000n * 10_000n * 10_000n,
      big(purchaseToBase1e4) * big(yieldBps),
    ),
  );
}

/** Weighted-average cost after receiving stock. With nothing (or negative) on hand the new cost applies. */
export function weightedAverageMicro(input: {
  onHandMilli: number;
  avgMicro: number;
  addedMilli: number;
  addedCostMicro: number;
}): number {
  need(input.addedMilli > 0, 'received quantity must be above zero');
  if (input.onHandMilli <= 0) return input.addedCostMicro;
  const value =
    big(input.onHandMilli) * big(input.avgMicro) +
    big(input.addedMilli) * big(input.addedCostMicro);
  return Number(divRound(value, big(input.onHandMilli + input.addedMilli)));
}

/** Cost in paisa of `qtyMilli` base units at `costMicro` micro-paisa each. */
export function lineCostPaisa(qtyMilli: number, costMicro: number): Paisa {
  need(Number.isSafeInteger(qtyMilli) && qtyMilli >= 0, 'quantity must be a non-negative integer');
  need(Number.isSafeInteger(costMicro) && costMicro >= 0, 'cost must be a non-negative integer');
  // qty (milli) × cost (micro-paisa) / 1e3 / 1e6
  return asPaisa(Number(divRound(big(qtyMilli) * big(costMicro), 1_000_000_000n)));
}

export interface RecipeLine {
  ingredientId: string;
  /** Base units per ONE sold unit (per 1000 g for weight items), in milli. */
  qtyMilli: number;
}
export interface Consumption {
  ingredientId: string;
  qtyMilli: number;
}

/**
 * What selling `soldQty` of a variant uses. For a normal item `soldQty` is the piece count; for a
 * weight item the recipe is per 1000 g, so pass the weight in grams as `weightG` and `soldQty` 1.
 */
export function recipeConsumption(
  lines: readonly RecipeLine[],
  sold: { qtyMilli: number; weightG?: number | null },
): Consumption[] {
  need(
    Number.isSafeInteger(sold.qtyMilli) && sold.qtyMilli > 0,
    'sold quantity must be above zero',
  );
  return lines.map((l) => {
    const perUnit = sold.weightG
      ? divRound(big(l.qtyMilli) * big(sold.weightG), 1000n)
      : big(l.qtyMilli);
    const total = divRound(perUnit * big(sold.qtyMilli), 1000n);
    return { ingredientId: l.ingredientId, qtyMilli: Number(total) };
  });
}

/** Food cost %, in basis points of sales (0 when nothing was sold). */
export function foodCostBps(costPaisa: number, salesPaisa: number): number {
  if (salesPaisa <= 0) return 0;
  return Number(divRound(big(costPaisa) * 10_000n, big(salesPaisa)));
}

/** Stock below the reorder level (strictly) needs buying; no level means no alert. */
export const needsReorder = (onHandMilli: number, reorderLevelMilli: number | null): boolean =>
  reorderLevelMilli !== null && onHandMilli < reorderLevelMilli;
