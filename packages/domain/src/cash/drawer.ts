import { asPaisa, type Paisa } from '../money';

export type CashMovementKind = 'PAID_OUT' | 'CASH_IN' | 'DROP' | 'NO_SALE_OPEN';

export class DrawerError extends Error {
  constructor(
    readonly code: 'DRAWER_AMOUNT_INVALID' | 'DRAWER_INSUFFICIENT_CASH',
    message: string,
  ) {
    super(message);
    this.name = 'DrawerError';
  }
}

export interface DrawerFlows {
  openingFloatPaisa: number;
  /** Σ of the amounts applied to bills by cash tenders (change already handed back). */
  cashSalesPaisa: number;
  cashInPaisa: number;
  /** Cash received from customers against their khata balance. */
  khataCashPaisa: number;
  paidOutPaisa: number;
  /** Cash taken out of the drawer to the safe. */
  dropsPaisa: number;
}

const whole = (n: number, what: string): void => {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new DrawerError('DRAWER_AMOUNT_INVALID', `${what} must be a non-negative integer`);
};

/**
 * Cash that should be in the drawer: float + cash sales + cash in + khata cash − paid out − drops.
 * Tips are deliberately not part of it (OPEN-QUESTIONS #30: whether tips pass through the drawer).
 */
export function expectedCash(f: DrawerFlows): Paisa {
  whole(f.openingFloatPaisa, 'opening float');
  whole(f.cashSalesPaisa, 'cash sales');
  whole(f.cashInPaisa, 'cash in');
  whole(f.khataCashPaisa, 'khata cash');
  whole(f.paidOutPaisa, 'paid out');
  whole(f.dropsPaisa, 'drops');
  return asPaisa(
    f.openingFloatPaisa +
      f.cashSalesPaisa +
      f.cashInPaisa +
      f.khataCashPaisa -
      f.paidOutPaisa -
      f.dropsPaisa,
  );
}

/** counted − expected: negative = short, positive = over. */
export function cashVariance(countedPaisa: number, expectedPaisa: number): Paisa {
  whole(countedPaisa, 'counted cash');
  if (!Number.isSafeInteger(expectedPaisa))
    throw new DrawerError('DRAWER_AMOUNT_INVALID', 'expected cash must be an integer');
  return asPaisa(countedPaisa - expectedPaisa);
}

/**
 * Money leaving the drawer (paid out / drop) must be positive and cannot exceed what the drawer
 * should hold — a paid-out of cash that was never there would hide a shortage.
 */
export function assertCanTakeOut(amountPaisa: number, currentExpectedPaisa: number): void {
  if (!Number.isSafeInteger(amountPaisa) || amountPaisa <= 0)
    throw new DrawerError('DRAWER_AMOUNT_INVALID', 'The amount must be greater than zero');
  if (amountPaisa > currentExpectedPaisa)
    throw new DrawerError('DRAWER_INSUFFICIENT_CASH', 'There is not that much cash in the drawer');
}
