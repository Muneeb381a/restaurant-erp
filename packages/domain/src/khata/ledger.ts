import { asPaisa, type Paisa } from '../money';

export type KhataKind = 'CHARGE' | 'PAYMENT' | 'ADJUST_UP' | 'ADJUST_DOWN' | 'REFUND';

export class KhataError extends Error {
  constructor(
    readonly code: 'KHATA_AMOUNT_INVALID' | 'KHATA_LIMIT_EXCEEDED' | 'KHATA_OVERPAYMENT',
    message: string,
    readonly extra: { balancePaisa?: number; limitPaisa?: number } = {},
  ) {
    super(message);
    this.name = 'KhataError';
  }
}

const positive = (n: number): void => {
  if (!Number.isSafeInteger(n) || n <= 0)
    throw new KhataError('KHATA_AMOUNT_INVALID', 'The amount must be a whole number above zero');
};

/** + raises what the customer owes, − lowers it (mirrors the generated column `delta_paisa`). */
export function khataDelta(kind: KhataKind, amountPaisa: number): Paisa {
  positive(amountPaisa);
  return asPaisa(kind === 'CHARGE' || kind === 'ADJUST_UP' ? amountPaisa : -amountPaisa);
}

export function khataBalance(entries: { kind: KhataKind; amountPaisa: number }[]): Paisa {
  return asPaisa(entries.reduce((n, e) => n + khataDelta(e.kind, e.amountPaisa), 0));
}

/** How much more the customer may still take on credit (never negative). */
export function availableCredit(balancePaisa: number, limitPaisa: number): Paisa {
  return asPaisa(Math.max(0, limitPaisa - balancePaisa));
}

/** A credit sale may not push the balance above the limit. */
export function assertCanCharge(
  balancePaisa: number,
  limitPaisa: number,
  amountPaisa: number,
): void {
  positive(amountPaisa);
  if (balancePaisa + amountPaisa > limitPaisa)
    throw new KhataError('KHATA_LIMIT_EXCEEDED', 'This would exceed the customer’s credit limit', {
      balancePaisa,
      limitPaisa,
    });
}

/** A payment cannot be larger than what is owed (advance deposits are not supported yet). */
export function assertCanReceivePayment(balancePaisa: number, amountPaisa: number): void {
  positive(amountPaisa);
  if (amountPaisa > balancePaisa)
    throw new KhataError('KHATA_OVERPAYMENT', 'The payment is more than the customer owes', {
      balancePaisa,
    });
}
