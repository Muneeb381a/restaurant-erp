import { addDays, autoStatus, daysBetween, HrError } from './attendance';

/** The longest single request: a year. Guards against a typo in the year making a 3000-day leave. */
export const MAX_LEAVE_DAYS = 366;

/**
 * The days a leave actually uses: every day from `from` to `to` that is a working day for this person.
 * Their weekly day off and public holidays inside the range are not counted (nobody takes leave on a
 * day off). Counted in HALF-DAY units (a full day = 2) so no fractions are needed anywhere.
 */
export function leaveDates(input: {
  from: string;
  to: string;
  weeklyOff: readonly number[];
  holidays: ReadonlySet<string>;
}): string[] {
  const n = daysBetween(input.from, input.to);
  if (n > MAX_LEAVE_DAYS) throw new HrError('a leave cannot be longer than a year', 'HR_BAD_RANGE');
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = addDays(input.from, i);
    if (autoStatus(d, input.weeklyOff, input.holidays) === null) out.push(d);
  }
  return out;
}

/** Half-day units used by a request: 2 per working day, or 1 for a half-day request (one day only). */
export function leaveHalfDays(input: {
  from: string;
  to: string;
  weeklyOff: readonly number[];
  holidays: ReadonlySet<string>;
  half?: boolean;
}): number {
  const dates = leaveDates(input);
  if (input.half) {
    if (input.from !== input.to)
      throw new HrError('a half-day leave is for a single day', 'HR_BAD_RANGE');
    return dates.length === 1 ? 1 : 0;
  }
  return dates.length * 2;
}

export interface LeaveBalance {
  /** the yearly entitlement in half-days; null = no limit is tracked for this kind of leave */
  allowance: number | null;
  /** manual grants (+) and corrections (−) in half-days, for example an opening balance */
  adjustments: number;
  used: number;
  pending: number;
  /** allowance + adjustments - used; null when there is no limit. May be negative only if allowed. */
  remaining: number | null;
  /** remaining after the requests still waiting for a decision */
  remainingAfterPending: number | null;
}

export function leaveBalance(input: {
  allowance: number | null;
  adjustments?: number;
  used: number;
  pending?: number;
}): LeaveBalance {
  for (const n of [input.allowance ?? 0, input.used, input.pending ?? 0])
    if (!Number.isInteger(n) || n < 0)
      throw new HrError('leave figures are whole half-days', 'HR_BAD_RANGE');
  const adjustments = input.adjustments ?? 0;
  if (!Number.isInteger(adjustments))
    throw new HrError('leave figures are whole half-days', 'HR_BAD_RANGE');
  const pending = input.pending ?? 0;
  const remaining = input.allowance === null ? null : input.allowance + adjustments - input.used;
  return {
    allowance: input.allowance,
    adjustments,
    used: input.used,
    pending,
    remaining,
    remainingAfterPending: remaining === null ? null : remaining - pending,
  };
}

/** Do two date ranges (inclusive) share a day? */
export const rangesOverlap = (
  a: { from: string; to: string },
  b: { from: string; to: string },
): boolean => a.from <= b.to && b.from <= a.to;

/** Half-day units as text: 5 -> "2.5", 4 -> "2". For display only. */
export const formatLeaveDays = (halfDays: number): string =>
  halfDays % 2 === 0 ? String(halfDays / 2) : `${Math.floor(halfDays / 2)}.5`;
