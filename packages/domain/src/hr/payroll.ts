import type { AttendanceStatus } from './attendance';

/**
 * Payroll arithmetic. Everything is integer paisa; fractions of a paisa are rounded HALF-UP exactly once,
 * at the end of each line. Days are counted in HALF-DAY units (a day = 2). No legal rate is built in: the
 * overtime multiplier, the month divisor and the late rule are SETTINGS the owner types
 * (docs/OPEN-QUESTIONS.md #46), and overtime is off until it is switched on.
 */

export class PayrollError extends Error {
  constructor(
    message: string,
    readonly code: 'PAYROLL_BAD_INPUT',
  ) {
    super(message);
  }
}

/** round-half-up of (a × b × … ) / (d × e × …) with exact integer (BigInt) intermediates. Non-negative only. */
export function ratio(numerators: readonly number[], denominators: readonly number[] = []): number {
  let num = 1n;
  for (const n of numerators) {
    if (!Number.isInteger(n) || n < 0)
      throw new PayrollError('amounts are whole non-negative numbers', 'PAYROLL_BAD_INPUT');
    num *= BigInt(n);
  }
  let den = 1n;
  for (const d of denominators) {
    if (!Number.isInteger(d) || d <= 0)
      throw new PayrollError('divisor must be a positive whole number', 'PAYROLL_BAD_INPUT');
    den *= BigInt(d);
  }
  const q = (num * 2n + den) / (2n * den); // half-up
  if (q > BigInt(Number.MAX_SAFE_INTEGER))
    throw new PayrollError('amount too large', 'PAYROLL_BAD_INPUT');
  return Number(q);
}

// ───────────────────────────── counting the days ─────────────────────────────

export interface DayFacts {
  /** null = nothing marked for this day */
  status: AttendanceStatus | null;
  /** set when the day belongs to an approved leave: is that leave paid, and was it only half a day? */
  leave?: { paid: boolean; half: boolean } | null;
  /** the calendar says nobody works (weekly day off or public holiday) */
  calendarOff: boolean;
  /** was the person employed on this day? */
  employed: boolean;
}

export interface DayTally {
  /** half-days actually worked */
  workHalf: number;
  paidLeaveHalf: number;
  unpaidLeaveHalf: number;
  absentHalf: number;
  /** weekly offs and holidays */
  offHalf: number;
  /** working days nobody marked: payroll cannot be approved while any are left */
  unmarkedHalf: number;
  /** days of the period before they joined or after they left */
  notEmployedHalf: number;
}

export function tallyDays(days: readonly DayFacts[]): DayTally {
  const t: DayTally = {
    workHalf: 0,
    paidLeaveHalf: 0,
    unpaidLeaveHalf: 0,
    absentHalf: 0,
    offHalf: 0,
    unmarkedHalf: 0,
    notEmployedHalf: 0,
  };
  for (const d of days) {
    if (!d.employed) {
      t.notEmployedHalf += 2;
      continue;
    }
    switch (d.status) {
      case 'PRESENT':
        t.workHalf += 2;
        break;
      case 'HALF_DAY':
        t.workHalf += 1;
        if (d.leave) {
          if (d.leave.paid) t.paidLeaveHalf += 1;
          else t.unpaidLeaveHalf += 1;
        } else t.absentHalf += 1;
        break;
      case 'LEAVE':
        if (d.leave?.paid === false) t.unpaidLeaveHalf += 2;
        else t.paidLeaveHalf += 2; // leave with no type information is treated as paid: never dock by guesswork
        break;
      case 'ABSENT':
        t.absentHalf += 2;
        break;
      case 'WEEKLY_OFF':
      case 'HOLIDAY':
        t.offHalf += 2;
        break;
      default:
        if (d.calendarOff) t.offHalf += 2;
        else t.unmarkedHalf += 2;
    }
  }
  return t;
}

// ───────────────────────────── one payslip ─────────────────────────────

export interface PayrollSettings {
  /** what a month's salary is divided by to get a day: the real number of days in the month, or a flat 30 */
  divisor: 'CALENDAR' | 'THIRTY';
  overtimeEnabled: boolean;
  /** ×10000: 20000 = double pay. A placeholder until the accountant confirms the legal rate. */
  overtimeMultiplierBps: number;
  /** every N late arrivals cost one day's pay; 0 = lateness never costs pay */
  latesPerDeductionDay: number;
  /** daily-wage staff: are weekly offs and holidays paid? */
  dailyPaidOffDays: boolean;
  /** used to value an overtime minute when the person has no usual hours set */
  defaultShiftMinutes: number;
}

export const DEFAULT_PAYROLL_SETTINGS: PayrollSettings = {
  divisor: 'THIRTY',
  overtimeEnabled: false,
  overtimeMultiplierBps: 10_000,
  latesPerDeductionDay: 0,
  dailyPaidOffDays: false,
  defaultShiftMinutes: 480,
};

export interface SlipLine {
  kind: 'EARNING' | 'DEDUCTION';
  code: string;
  label: string;
  amountPaisa: number;
  /** a plain-words explanation of how the amount came about, shown on the payslip */
  detail?: string;
}

export interface SlipInput {
  payType: 'MONTHLY' | 'DAILY' | 'HOURLY';
  /** per month, per day or per hour, in paisa */
  ratePaisa: number;
  /** days in the calendar month of the period (monthly pay only) */
  monthDays: number;
  tally: DayTally;
  workedMinutes: number;
  lateCount: number;
  overtimeMinutes: number;
  /** their usual shift in minutes, or null when none is set */
  shiftMinutes: number | null;
  settings: PayrollSettings;
}

export interface SlipResult {
  lines: SlipLine[];
  warnings: ('UNMARKED_DAYS' | 'NO_WORKED_TIME' | 'OVERTIME_NEEDS_RATE')[];
}

const half = (n: number): string => (n % 2 === 0 ? String(n / 2) : `${Math.floor(n / 2)}.5`);

/** The computed lines of one payslip (basic pay, overtime, absence). Allowances and manual lines are added by the caller. */
export function computeSlip(i: SlipInput): SlipResult {
  const s = i.settings;
  const t = i.tally;
  const lines: SlipLine[] = [];
  const warnings: SlipResult['warnings'] = [];
  const shift = i.shiftMinutes && i.shiftMinutes > 0 ? i.shiftMinutes : s.defaultShiftMinutes;
  if (t.unmarkedHalf > 0) warnings.push('UNMARKED_DAYS');
  const otOn = s.overtimeEnabled && i.overtimeMinutes > 0;

  if (i.payType === 'MONTHLY') {
    const div = s.divisor === 'THIRTY' ? 30 : i.monthDays;
    lines.push({
      kind: 'EARNING',
      code: 'BASIC',
      label: 'Monthly salary',
      amountPaisa: i.ratePaisa,
    });
    // unmarked days are valued as unpaid in a draft so nobody is overpaid; approval is blocked while any remain
    const unpaid = t.absentHalf + t.unpaidLeaveHalf + t.unmarkedHalf;
    const cap = (n: number): number => Math.min(n, i.ratePaisa);
    if (unpaid > 0)
      lines.push({
        kind: 'DEDUCTION',
        code: 'ABSENCE',
        label: 'Absence and unpaid leave',
        amountPaisa: cap(ratio([i.ratePaisa, unpaid], [2, div])),
        detail: `${half(unpaid)} day(s) at salary / ${div}`,
      });
    if (t.notEmployedHalf > 0)
      lines.push({
        kind: 'DEDUCTION',
        code: 'NOT_EMPLOYED',
        label: 'Days before joining / after leaving',
        amountPaisa: cap(ratio([i.ratePaisa, t.notEmployedHalf], [2, div])),
        detail: `${half(t.notEmployedHalf)} day(s) at salary / ${div}`,
      });
    if (s.latesPerDeductionDay > 0) {
      const lateDays = Math.floor(i.lateCount / s.latesPerDeductionDay);
      if (lateDays > 0)
        lines.push({
          kind: 'DEDUCTION',
          code: 'LATE',
          label: 'Late arrivals',
          amountPaisa: cap(ratio([i.ratePaisa, lateDays * 2], [2, div])),
          detail: `${i.lateCount} late = ${lateDays} day(s)`,
        });
    }
    if (otOn)
      lines.push({
        kind: 'EARNING',
        code: 'OVERTIME',
        label: 'Overtime',
        amountPaisa: ratio(
          [i.ratePaisa, i.overtimeMinutes, s.overtimeMultiplierBps],
          [div, shift, 10_000],
        ),
        detail: `${i.overtimeMinutes} min at ${s.overtimeMultiplierBps / 10_000}x`,
      });
  } else if (i.payType === 'DAILY') {
    const payable = t.workHalf + t.paidLeaveHalf + (s.dailyPaidOffDays ? t.offHalf : 0);
    lines.push({
      kind: 'EARNING',
      code: 'BASIC',
      label: 'Daily wages',
      amountPaisa: ratio([i.ratePaisa, payable], [2]),
      detail: `${half(payable)} paid day(s) at the daily rate`,
    });
    if (otOn)
      lines.push({
        kind: 'EARNING',
        code: 'OVERTIME',
        label: 'Overtime',
        amountPaisa: ratio(
          [i.ratePaisa, i.overtimeMinutes, s.overtimeMultiplierBps],
          [shift, 10_000],
        ),
        detail: `${i.overtimeMinutes} min at ${s.overtimeMultiplierBps / 10_000}x`,
      });
  } else {
    if (i.workedMinutes === 0 && t.workHalf > 0) warnings.push('NO_WORKED_TIME');
    lines.push({
      kind: 'EARNING',
      code: 'BASIC',
      label: 'Hourly pay',
      amountPaisa: ratio([i.ratePaisa, i.workedMinutes], [60]),
      detail: `${Math.floor(i.workedMinutes / 60)} h ${i.workedMinutes % 60} min`,
    });
    // the overtime minutes were already paid once inside the worked time: only the extra part is added
    if (otOn && s.overtimeMultiplierBps > 10_000)
      lines.push({
        kind: 'EARNING',
        code: 'OVERTIME',
        label: 'Overtime (extra)',
        amountPaisa: ratio(
          [i.ratePaisa, i.overtimeMinutes, s.overtimeMultiplierBps - 10_000],
          [60, 10_000],
        ),
        detail: `${i.overtimeMinutes} min at ${s.overtimeMultiplierBps / 10_000}x`,
      });
  }
  return { lines, warnings };
}

export interface SlipTotals {
  grossPaisa: number;
  deductionsPaisa: number;
  netPaisa: number;
}

/** Totals of any set of lines (computed, allowances and manual ones together). Net may be negative: the caller must refuse to approve that. */
export function slipTotals(lines: readonly Pick<SlipLine, 'kind' | 'amountPaisa'>[]): SlipTotals {
  let gross = 0;
  let ded = 0;
  for (const l of lines) {
    if (!Number.isInteger(l.amountPaisa) || l.amountPaisa < 0)
      throw new PayrollError('line amounts are whole non-negative paisa', 'PAYROLL_BAD_INPUT');
    if (l.kind === 'EARNING') gross += l.amountPaisa;
    else ded += l.amountPaisa;
  }
  return { grossPaisa: gross, deductionsPaisa: ded, netPaisa: gross - ded };
}
