import { PayrollError } from './payroll';

/**
 * Money a staff member owes the restaurant: a salary advance, a loan or a fine. It is a LEDGER (what was
 * given or charged, what was recovered, what was written off); the balance is never stored, always
 * added up. Recovery is a deduction line on a payslip. All integer paisa.
 */

export type DueEntryKind = 'DISBURSE' | 'FINE' | 'RECOVERY' | 'WRITE_OFF';

export interface DueEntry {
  kind: DueEntryKind;
  amountPaisa: number;
}

const whole = (n: number): void => {
  if (!Number.isInteger(n) || n < 0)
    throw new PayrollError('amounts are whole non-negative paisa', 'PAYROLL_BAD_INPUT');
};

/** What is still owed: given + fined - recovered - written off. */
export function dueBalance(entries: readonly DueEntry[]): number {
  let b = 0;
  for (const e of entries) {
    whole(e.amountPaisa);
    b += e.kind === 'DISBURSE' || e.kind === 'FINE' ? e.amountPaisa : -e.amountPaisa;
  }
  return b;
}

/**
 * How much to take from the next payslip: the agreed instalment, never more than is owed, and never more than the
 * pay that is left after the other lines (a person is not paid less than nothing to settle a debt). Paused
 * or closed dues recover nothing. A zero instalment means "recover by hand", so also nothing.
 */
export function recoveryAmount(input: {
  balancePaisa: number;
  installmentPaisa: number;
  /** earnings - deductions of the payslip before this recovery; may be negative */
  netBeforePaisa: number;
  paused?: boolean;
  closed?: boolean;
}): number {
  whole(input.installmentPaisa);
  if (input.paused || input.closed || input.balancePaisa <= 0 || input.installmentPaisa === 0)
    return 0;
  return Math.max(0, Math.min(input.installmentPaisa, input.balancePaisa, input.netBeforePaisa));
}

/** Instalments left at the agreed size (the last one may be smaller). */
export function installmentsLeft(balancePaisa: number, installmentPaisa: number): number | null {
  if (installmentPaisa <= 0) return null;
  return Math.max(0, Math.ceil(balancePaisa / installmentPaisa));
}
