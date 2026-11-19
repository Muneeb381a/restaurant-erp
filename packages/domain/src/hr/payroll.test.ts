import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  computeSlip,
  DEFAULT_PAYROLL_SETTINGS,
  PayrollError,
  ratio,
  slipTotals,
  tallyDays,
  type DayFacts,
  type DayTally,
  type PayrollSettings,
} from './payroll';

const zero: DayTally = {
  workHalf: 0,
  paidLeaveHalf: 0,
  unpaidLeaveHalf: 0,
  absentHalf: 0,
  offHalf: 0,
  unmarkedHalf: 0,
  notEmployedHalf: 0,
};
const settings = (o: Partial<PayrollSettings> = {}): PayrollSettings => ({
  ...DEFAULT_PAYROLL_SETTINGS,
  ...o,
});
const slip = (o: Partial<Parameters<typeof computeSlip>[0]> = {}) =>
  computeSlip({
    payType: 'MONTHLY',
    ratePaisa: 3_000_000, // Rs 30,000
    monthDays: 31,
    tally: zero,
    workedMinutes: 0,
    lateCount: 0,
    overtimeMinutes: 0,
    shiftMinutes: 720,
    settings: settings(),
    ...o,
  });
const find = (r: ReturnType<typeof slip>, code: string) => r.lines.find((l) => l.code === code);

describe('ratio: exact integer arithmetic with one half-up rounding', () => {
  it('rounds half up and never uses floats', () => {
    expect(ratio([1], [2])).toBe(1); // 0.5 -> 1
    expect(ratio([1], [3])).toBe(0);
    expect(ratio([2], [3])).toBe(1);
    expect(ratio([3_000_000, 5], [2, 30])).toBe(250_000);
    expect(ratio([10, 10], [])).toBe(100);
  });
  it('survives products beyond 2^53', () => {
    const n = 1_000_000_000_000n * 100_000n * 20_000n;
    const d = 30n * 720n * 10_000n;
    expect(ratio([1_000_000_000_000, 100_000, 20_000], [30, 720, 10_000])).toBe(
      Number((n * 2n + d) / (2n * d)),
    );
  });
  it('refuses negatives, fractions and a zero divisor', () => {
    expect(() => ratio([-1], [2])).toThrow(PayrollError);
    expect(() => ratio([1.5], [2])).toThrow(PayrollError);
    expect(() => ratio([1], [0])).toThrow(PayrollError);
  });
});

describe('tallyDays', () => {
  const d = (o: Partial<DayFacts>): DayFacts => ({
    status: null,
    calendarOff: false,
    employed: true,
    ...o,
  });
  it('counts each kind of day in half-days', () => {
    const t = tallyDays([
      d({ status: 'PRESENT' }),
      d({ status: 'HALF_DAY' }), // worked half, absent half
      d({ status: 'HALF_DAY', leave: { paid: true, half: true } }), // worked half, paid-leave half
      d({ status: 'HALF_DAY', leave: { paid: false, half: true } }),
      d({ status: 'LEAVE', leave: { paid: true, half: false } }),
      d({ status: 'LEAVE', leave: { paid: false, half: false } }),
      d({ status: 'ABSENT' }),
      d({ status: 'WEEKLY_OFF' }),
      d({ status: null, calendarOff: true }),
      d({ status: null }),
      d({ employed: false }),
    ]);
    expect(t).toEqual({
      workHalf: 2 + 1 + 1 + 1,
      paidLeaveHalf: 1 + 2,
      unpaidLeaveHalf: 1 + 2,
      absentHalf: 1 + 2,
      offHalf: 4,
      unmarkedHalf: 2,
      notEmployedHalf: 2,
    });
  });
  it('a LEAVE day with no leave information is treated as paid, never docked by guesswork', () => {
    expect(tallyDays([d({ status: 'LEAVE' })]).paidLeaveHalf).toBe(2);
  });
  it('every day adds up to exactly two half-days across the buckets (property)', () => {
    const statuses = [
      'PRESENT',
      'ABSENT',
      'HALF_DAY',
      'LEAVE',
      'WEEKLY_OFF',
      'HOLIDAY',
      null,
    ] as const;
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            status: fc.constantFrom(...statuses),
            off: fc.boolean(),
            employed: fc.boolean(),
            paid: fc.boolean(),
            hasLeave: fc.boolean(),
          }),
          { maxLength: 62 },
        ),
        (rows) => {
          const days = rows.map((r) =>
            d({
              status: r.status,
              calendarOff: r.off,
              employed: r.employed,
              leave: r.hasLeave ? { paid: r.paid, half: true } : null,
            }),
          );
          const t = tallyDays(days);
          const total = Object.values(t).reduce((a, b) => a + b, 0);
          expect(total).toBe(days.length * 2);
        },
      ),
    );
  });
});

describe('monthly salary', () => {
  it('a full month with nothing wrong pays exactly the salary', () => {
    const r = slip({ tally: { ...zero, workHalf: 52, offHalf: 10 } });
    expect(r.lines).toEqual([
      { kind: 'EARNING', code: 'BASIC', label: 'Monthly salary', amountPaisa: 3_000_000 },
    ]);
    expect(r.warnings).toEqual([]);
  });
  it('absence costs salary / divisor per day (flat 30 by default)', () => {
    const r = slip({ tally: { ...zero, absentHalf: 4 } }); // 2 days
    expect(find(r, 'ABSENCE')!.amountPaisa).toBe(200_000);
    expect(slipTotals(r.lines).netPaisa).toBe(2_800_000);
  });
  it('the divisor can be the real month length', () => {
    const r = slip({
      tally: { ...zero, absentHalf: 2 },
      settings: settings({ divisor: 'CALENDAR' }),
    });
    expect(find(r, 'ABSENCE')!.amountPaisa).toBe(Math.round(3_000_000 / 31));
  });
  it('a half-day absence costs half a day; unpaid leave costs like absence; paid leave costs nothing', () => {
    expect(find(slip({ tally: { ...zero, absentHalf: 1 } }), 'ABSENCE')!.amountPaisa).toBe(50_000);
    expect(find(slip({ tally: { ...zero, unpaidLeaveHalf: 2 } }), 'ABSENCE')!.amountPaisa).toBe(
      100_000,
    );
    expect(find(slip({ tally: { ...zero, paidLeaveHalf: 6 } }), 'ABSENCE')).toBeUndefined();
  });
  it('unmarked days are docked in the draft and raise a warning', () => {
    const r = slip({ tally: { ...zero, unmarkedHalf: 2 } });
    expect(r.warnings).toEqual(['UNMARKED_DAYS']);
    expect(find(r, 'ABSENCE')!.amountPaisa).toBe(100_000);
  });
  it('joined mid-month: the days before joining are not paid', () => {
    const r = slip({ tally: { ...zero, notEmployedHalf: 20 } }); // 10 days
    expect(find(r, 'NOT_EMPLOYED')!.amountPaisa).toBe(1_000_000);
  });
  it('a deduction never exceeds the salary', () => {
    const r = slip({ tally: { ...zero, absentHalf: 200 } });
    expect(find(r, 'ABSENCE')!.amountPaisa).toBe(3_000_000);
    expect(slipTotals(r.lines).netPaisa).toBe(0);
  });
  it('lateness only costs pay when the owner switched the rule on', () => {
    expect(find(slip({ lateCount: 7 }), 'LATE')).toBeUndefined();
    const r = slip({ lateCount: 7, settings: settings({ latesPerDeductionDay: 3 }) }); // 2 days
    expect(find(r, 'LATE')!.amountPaisa).toBe(200_000);
  });
  it('overtime is off by default; when on it is paid at the multiplier of the hourly equivalent', () => {
    expect(find(slip({ overtimeMinutes: 120 }), 'OVERTIME')).toBeUndefined();
    const r = slip({
      overtimeMinutes: 120,
      settings: settings({ overtimeEnabled: true, overtimeMultiplierBps: 20_000 }),
    });
    expect(find(r, 'OVERTIME')!.amountPaisa).toBe(
      ratio([3_000_000, 120, 20_000], [30, 720, 10_000]),
    );
    expect(find(r, 'OVERTIME')!.amountPaisa).toBe(33_333);
  });
  it('a person with no usual hours uses the default shift length for overtime', () => {
    const r = slip({
      overtimeMinutes: 60,
      shiftMinutes: null,
      settings: settings({ overtimeEnabled: true }),
    });
    expect(find(r, 'OVERTIME')!.amountPaisa).toBe(ratio([3_000_000, 60], [30, 480]));
  });
});

describe('daily wages', () => {
  const daily = (tally: Partial<DayTally>, s: Partial<PayrollSettings> = {}) =>
    slip({
      payType: 'DAILY',
      ratePaisa: 150_000,
      tally: { ...zero, ...tally },
      settings: settings(s),
    });
  it('pays worked days and half days, plus paid leave; off days only if the owner says so', () => {
    expect(find(daily({ workHalf: 41, paidLeaveHalf: 2, offHalf: 8 }), 'BASIC')!.amountPaisa).toBe(
      150_000 * 21.5,
    );
    expect(
      find(daily({ workHalf: 40, offHalf: 8 }, { dailyPaidOffDays: true }), 'BASIC')!.amountPaisa,
    ).toBe(150_000 * 24);
  });
  it('a half-day of an odd rate rounds half up', () => {
    expect(
      find(
        slip({ payType: 'DAILY', ratePaisa: 100_001, tally: { ...zero, workHalf: 1 } }),
        'BASIC',
      )!.amountPaisa,
    ).toBe(50_001);
  });
  it('overtime at the multiplier of the daily rate per shift minute', () => {
    const r = slip({
      payType: 'DAILY',
      ratePaisa: 150_000,
      overtimeMinutes: 90,
      settings: settings({ overtimeEnabled: true, overtimeMultiplierBps: 15_000 }),
    });
    expect(find(r, 'OVERTIME')!.amountPaisa).toBe(ratio([150_000, 90, 15_000], [720, 10_000]));
  });
});

describe('hourly pay', () => {
  it('pays the worked minutes; overtime adds only the extra over the normal rate', () => {
    const r = slip({
      payType: 'HOURLY',
      ratePaisa: 30_000,
      workedMinutes: 600,
      overtimeMinutes: 60,
      settings: settings({ overtimeEnabled: true, overtimeMultiplierBps: 20_000 }),
    });
    expect(find(r, 'BASIC')!.amountPaisa).toBe(300_000);
    expect(find(r, 'OVERTIME')!.amountPaisa).toBe(30_000); // the extra 1x of one hour
  });
  it('warns when days were worked but no time was recorded', () => {
    expect(
      slip({ payType: 'HOURLY', ratePaisa: 30_000, tally: { ...zero, workHalf: 2 } }).warnings,
    ).toEqual(['NO_WORKED_TIME']);
  });
});

describe('totals', () => {
  it('net = earnings - deductions, and can be negative so the caller can refuse it', () => {
    expect(
      slipTotals([
        { kind: 'EARNING', amountPaisa: 100 },
        { kind: 'EARNING', amountPaisa: 50 },
        { kind: 'DEDUCTION', amountPaisa: 200 },
      ]),
    ).toEqual({ grossPaisa: 150, deductionsPaisa: 200, netPaisa: -50 });
  });
  it('refuses fractional or negative line amounts', () => {
    expect(() => slipTotals([{ kind: 'EARNING', amountPaisa: -1 }])).toThrow(PayrollError);
    expect(() => slipTotals([{ kind: 'EARNING', amountPaisa: 1.5 }])).toThrow(PayrollError);
  });
  it('monthly net never exceeds the salary and every line is whole paisa (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000_000 }),
        fc.integer({ min: 0, max: 80 }),
        fc.integer({ min: 0, max: 80 }),
        fc.integer({ min: 0, max: 80 }),
        fc.integer({ min: 28, max: 31 }),
        (base, absent, unpaid, unmarked, monthDays) => {
          const r = slip({
            ratePaisa: base,
            monthDays,
            tally: { ...zero, absentHalf: absent, unpaidLeaveHalf: unpaid, unmarkedHalf: unmarked },
          });
          expect(slipTotals(r.lines).netPaisa).toBeLessThanOrEqual(base);
          for (const l of r.lines) expect(Number.isInteger(l.amountPaisa)).toBe(true);
        },
      ),
    );
  });
});
