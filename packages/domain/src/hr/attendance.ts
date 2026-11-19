/**
 * Attendance rules, as pure functions (no database, no clock, no time zone): the API turns timestamps into
 * "minutes after midnight of the work date" in the branch's time zone, and these functions do the arithmetic.
 * Everything is whole minutes and whole days; half days are counted in HALF-day units so there is no float.
 */

export const ATTENDANCE_STATUSES = [
  'PRESENT',
  'ABSENT',
  'HALF_DAY',
  'LEAVE',
  'WEEKLY_OFF',
  'HOLIDAY',
] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export class HrError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'HrError';
  }
}

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY_MS = 86_400_000;

function parseDate(date: string): number {
  if (!ISO_DATE.test(date)) throw new HrError(`not a date: ${date}`, 'HR_BAD_DATE');
  const ms = Date.parse(`${date}T00:00:00Z`);
  // 2026-02-30 parses to March 2: reject it
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== date)
    throw new HrError(`not a real date: ${date}`, 'HR_BAD_DATE');
  return ms;
}

/** 0 = Sunday … 6 = Saturday, of a calendar date (no time zone involved). */
export const dayOfWeek = (date: string): number => new Date(parseDate(date)).getUTCDay();

export const addDays = (date: string, n: number): string =>
  new Date(parseDate(date) + n * DAY_MS).toISOString().slice(0, 10);

/** Every date of a month ("2026-11") in order. */
export function monthDays(month: string): string[] {
  if (!MONTH.test(month)) throw new HrError(`not a month: ${month}`, 'HR_BAD_MONTH');
  const out: string[] = [];
  for (let d = `${month}-01`; d.startsWith(month); d = addDays(d, 1)) out.push(d);
  return out;
}

/** Whole days from `from` to `to`, inclusive. */
export function daysBetween(from: string, to: string): number {
  const n = Math.round((parseDate(to) - parseDate(from)) / DAY_MS) + 1;
  if (n < 1) throw new HrError('the end is before the start', 'HR_BAD_RANGE');
  return n;
}

// ───────────────────────────── a working day ─────────────────────────────

/** Working hours in minutes after midnight of the work date; an end at or before the start means the next day. */
export interface ShiftTimes {
  startMin: number;
  endMin: number;
}

const inDay = (m: number): boolean => Number.isInteger(m) && m >= 0 && m < 1440;

export function normalizeShift(s: ShiftTimes): ShiftTimes {
  if (!inDay(s.startMin) || !inDay(s.endMin))
    throw new HrError('shift times must be whole minutes within a day', 'HR_BAD_SHIFT');
  return { startMin: s.startMin, endMin: s.endMin <= s.startMin ? s.endMin + 1440 : s.endMin };
}

export const shiftMinutes = (s: ShiftTimes): number => {
  const n = normalizeShift(s);
  return n.endMin - n.startMin;
};

/** Minutes late: how far past the start (and past the grace period) the person arrived; never negative. */
export function lateMinutes(shift: ShiftTimes, arrivalMin: number, graceMin = 0): number {
  const { startMin } = normalizeShift(shift);
  if (!Number.isInteger(arrivalMin) || graceMin < 0)
    throw new HrError('bad arrival', 'HR_BAD_TIME');
  return Math.max(0, arrivalMin - startMin - graceMin) === 0 ? 0 : arrivalMin - startMin;
}

/** Minutes of overtime: how long after the end they stayed, counted only once past `afterMin` (a threshold). */
export function overtimeMinutes(shift: ShiftTimes, departureMin: number, afterMin = 0): number {
  const { endMin } = normalizeShift(shift);
  if (!Number.isInteger(departureMin) || afterMin < 0)
    throw new HrError('bad departure', 'HR_BAD_TIME');
  const over = departureMin - endMin;
  return over > afterMin ? over : 0;
}

/** Whole minutes between a clock-in and a clock-out (milliseconds since the epoch). */
export function workedMinutes(inMs: number, outMs: number): number {
  if (outMs < inMs) throw new HrError('clock-out is before clock-in', 'HR_BAD_TIME');
  return Math.floor((outMs - inMs) / 60_000);
}

// ───────────────────────────── the calendar ─────────────────────────────

/** A day nobody is expected to work: a public holiday, or the person's weekly day off. null = a working day. */
export function autoStatus(
  date: string,
  weeklyOff: readonly number[],
  holidays: ReadonlySet<string>,
): 'HOLIDAY' | 'WEEKLY_OFF' | null {
  if (holidays.has(date)) return 'HOLIDAY';
  return weeklyOff.includes(dayOfWeek(date)) ? 'WEEKLY_OFF' : null;
}

export interface DayRecord {
  date: string;
  status: AttendanceStatus;
  lateMinutes?: number | null | undefined;
  overtimeMinutes?: number | null | undefined;
  workedMinutes?: number | null | undefined;
}

export interface MonthSummary {
  /** counted days by status */
  present: number;
  halfDays: number;
  absent: number;
  leave: number;
  weeklyOff: number;
  holidays: number;
  /** working days with nothing marked yet (the manager still has to fill them in) */
  unmarked: number;
  /** present days plus half days, in HALF days (so 3 present + 1 half day = 7); no fractions anywhere */
  attendedHalfDays: number;
  lateCount: number;
  lateMinutes: number;
  overtimeMinutes: number;
  workedMinutes: number;
}

/**
 * The month of one person. `from` / `to` limit it to the days they were employed (joined mid-month, left
 * before the end): days outside are not counted at all. A day with no record falls back to the calendar
 * (weekly off / holiday) and otherwise counts as unmarked.
 */
export function summarizeMonth(input: {
  month: string;
  records: readonly DayRecord[];
  weeklyOff: readonly number[];
  holidays: ReadonlySet<string>;
  from?: string | undefined;
  to?: string | undefined;
}): MonthSummary {
  const byDate = new Map(input.records.map((r) => [r.date, r]));
  const s: MonthSummary = {
    present: 0,
    halfDays: 0,
    absent: 0,
    leave: 0,
    weeklyOff: 0,
    holidays: 0,
    unmarked: 0,
    attendedHalfDays: 0,
    lateCount: 0,
    lateMinutes: 0,
    overtimeMinutes: 0,
    workedMinutes: 0,
  };
  for (const date of monthDays(input.month)) {
    if ((input.from && date < input.from) || (input.to && date > input.to)) continue;
    const rec = byDate.get(date);
    const status = rec?.status ?? autoStatus(date, input.weeklyOff, input.holidays) ?? null;
    switch (status) {
      case 'PRESENT':
        s.present++;
        s.attendedHalfDays += 2;
        break;
      case 'HALF_DAY':
        s.halfDays++;
        s.attendedHalfDays += 1;
        break;
      case 'ABSENT':
        s.absent++;
        break;
      case 'LEAVE':
        s.leave++;
        break;
      case 'WEEKLY_OFF':
        s.weeklyOff++;
        break;
      case 'HOLIDAY':
        s.holidays++;
        break;
      default:
        s.unmarked++;
    }
    if (rec) {
      if ((rec.lateMinutes ?? 0) > 0) {
        s.lateCount++;
        s.lateMinutes += rec.lateMinutes!;
      }
      s.overtimeMinutes += rec.overtimeMinutes ?? 0;
      s.workedMinutes += rec.workedMinutes ?? 0;
    }
  }
  return s;
}
