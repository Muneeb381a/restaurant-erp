import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addDays,
  autoStatus,
  daysBetween,
  dayOfWeek,
  HrError,
  lateMinutes,
  monthDays,
  normalizeShift,
  overtimeMinutes,
  shiftMinutes,
  summarizeMonth,
  workedMinutes,
  type DayRecord,
} from './attendance';

const h = (hh: number, mm = 0): number => hh * 60 + mm;
const day = { startMin: h(10), endMin: h(22) };
const night = { startMin: h(20), endMin: h(4) }; // 8 pm to 4 am next day

describe('the calendar', () => {
  it('knows the weekday of a date and adds days across month ends and leap years', () => {
    expect(dayOfWeek('2026-11-19')).toBe(4); // Thursday
    expect(dayOfWeek('2026-11-22')).toBe(0); // Sunday
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('lists the days of a month and counts a range', () => {
    expect(monthDays('2026-02')).toHaveLength(28);
    expect(monthDays('2028-02')).toHaveLength(29);
    expect(monthDays('2026-11')[29]).toBe('2026-11-30');
    expect(daysBetween('2026-11-01', '2026-11-01')).toBe(1);
    expect(daysBetween('2026-11-28', '2026-12-02')).toBe(5);
    expect(() => daysBetween('2026-11-05', '2026-11-04')).toThrow(HrError);
  });
  it('refuses dates and months that do not exist', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '26-01-01', '2026-1-1', '', 'tomorrow'])
      expect(() => dayOfWeek(bad)).toThrow(HrError);
    expect(() => monthDays('2026-00')).toThrow(HrError);
    expect(() => monthDays('2026-1')).toThrow(HrError);
  });
  it('a holiday beats the weekly day off; either makes the day non-working', () => {
    const holidays = new Set(['2026-11-20']);
    expect(autoStatus('2026-11-20', [5], holidays)).toBe('HOLIDAY'); // Friday and a holiday
    expect(autoStatus('2026-11-27', [5], holidays)).toBe('WEEKLY_OFF'); // a plain Friday
    expect(autoStatus('2026-11-26', [5], holidays)).toBeNull(); // Thursday
    expect(autoStatus('2026-11-26', [], holidays)).toBeNull();
  });
});

describe('a working day', () => {
  it('a shift that ends at or before its start runs into the next day', () => {
    expect(normalizeShift(night)).toEqual({ startMin: h(20), endMin: h(28) });
    expect(shiftMinutes(night)).toBe(h(8));
    expect(shiftMinutes(day)).toBe(h(12));
    expect(() => normalizeShift({ startMin: -1, endMin: 10 })).toThrow(HrError);
    expect(() => normalizeShift({ startMin: 0, endMin: 1440 })).toThrow(HrError);
    expect(() => normalizeShift({ startMin: 1.5, endMin: 10 })).toThrow(HrError);
  });

  it('late minutes: none inside the grace period, the whole delay once past it, never negative', () => {
    expect(lateMinutes(day, h(9, 40), 10)).toBe(0); // early
    expect(lateMinutes(day, h(10), 10)).toBe(0); // on time
    expect(lateMinutes(day, h(10, 10), 10)).toBe(0); // exactly at the grace limit
    expect(lateMinutes(day, h(10, 11), 10)).toBe(11); // one minute past it: all 11 count
    expect(lateMinutes(day, h(10, 30))).toBe(30); // no grace
    expect(lateMinutes(night, h(20, 45), 15)).toBe(45);
    expect(() => lateMinutes(day, 10.5)).toThrow(HrError);
    expect(() => lateMinutes(day, h(11), -1)).toThrow(HrError);
  });

  it('overtime: only after the end, and only once past the threshold', () => {
    expect(overtimeMinutes(day, h(21, 30))).toBe(0);
    expect(overtimeMinutes(day, h(22))).toBe(0);
    expect(overtimeMinutes(day, h(22, 20), 30)).toBe(0); // under the threshold
    expect(overtimeMinutes(day, h(22, 31), 30)).toBe(31);
    expect(overtimeMinutes(day, h(23))).toBe(60);
    // a night shift is measured against its end the next morning (minutes past midnight of the work date)
    expect(overtimeMinutes(night, h(28, 45))).toBe(45);
    expect(overtimeMinutes(night, h(27))).toBe(0);
    expect(() => overtimeMinutes(day, h(23), -5)).toThrow(HrError);
  });

  it('worked minutes: whole minutes between two instants; a clock-out before the clock-in is refused', () => {
    const t = Date.parse('2026-11-19T05:00:00Z');
    expect(workedMinutes(t, t)).toBe(0);
    expect(workedMinutes(t, t + 8 * 3_600_000 + 29_999)).toBe(480);
    expect(workedMinutes(t, t + 59_999)).toBe(0);
    expect(() => workedMinutes(t, t - 1)).toThrow(HrError);
  });
});

describe('summarizeMonth', () => {
  const holidays = new Set(['2026-11-09']); // a Monday
  const base = { month: '2026-11', weeklyOff: [5], holidays };

  it('counts each kind of day; a record wins over the calendar; unmarked working days stay visible', () => {
    const records: DayRecord[] = [
      { date: '2026-11-02', status: 'PRESENT', workedMinutes: 600, overtimeMinutes: 30 },
      { date: '2026-11-03', status: 'PRESENT', lateMinutes: 25, workedMinutes: 590 },
      { date: '2026-11-04', status: 'HALF_DAY', workedMinutes: 300 },
      { date: '2026-11-05', status: 'ABSENT' },
      { date: '2026-11-06', status: 'LEAVE' }, // a Friday (weekly off) marked as leave: the record wins
    ];
    const s = summarizeMonth({ ...base, records });
    expect(s).toMatchObject({
      present: 2,
      halfDays: 1,
      absent: 1,
      leave: 1,
      attendedHalfDays: 5,
      lateCount: 1,
      lateMinutes: 25,
      overtimeMinutes: 30,
      workedMinutes: 1490,
      holidays: 1, // the 9th, from the calendar
      weeklyOff: 3, // Fridays 13th, 20th, 27th (the 6th became leave)
    });
    expect(s.unmarked).toBe(30 - 2 - 1 - 1 - 1 - 1 - 3);
  });

  it('days without a record fall back to the calendar; someone who works their day off is present', () => {
    const s = summarizeMonth({ ...base, records: [{ date: '2026-11-13', status: 'PRESENT' }] });
    expect(s.present).toBe(1);
    expect(s.weeklyOff).toBe(3); // 6th, 20th, 27th
    expect(s.holidays).toBe(1);
    expect(s.unmarked).toBe(30 - 1 - 3 - 1);
  });

  it('only the days of employment count (joined mid-month, left before the end)', () => {
    const s = summarizeMonth({ ...base, records: [], from: '2026-11-10', to: '2026-11-20' });
    expect(s.holidays).toBe(0); // the 9th is before they joined
    expect(s.weeklyOff).toBe(2); // 13th and 20th
    expect(s.unmarked).toBe(11 - 2);
  });

  it('every day of the employment window is counted exactly once (property check)', () => {
    const statuses = ['PRESENT', 'ABSENT', 'HALF_DAY', 'LEAVE', 'WEEKLY_OFF', 'HOLIDAY'] as const;
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            n: fc.integer({ min: 1, max: 30 }),
            status: fc.constantFrom(...statuses),
            late: fc.integer({ min: 0, max: 200 }),
            ot: fc.integer({ min: 0, max: 300 }),
          }),
          { maxLength: 40 },
        ),
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 1, max: 30 }),
        fc.array(fc.integer({ min: 0, max: 6 }), { maxLength: 3 }),
        (rows, a, b, off) => {
          const from = `2026-11-${String(Math.min(a, b)).padStart(2, '0')}`;
          const to = `2026-11-${String(Math.max(a, b)).padStart(2, '0')}`;
          const records: DayRecord[] = rows.map((r) => ({
            date: `2026-11-${String(r.n).padStart(2, '0')}`,
            status: r.status,
            lateMinutes: r.late,
            overtimeMinutes: r.ot,
          }));
          const s = summarizeMonth({
            month: '2026-11',
            records,
            weeklyOff: off,
            holidays,
            from,
            to,
          });
          const total =
            s.present + s.halfDays + s.absent + s.leave + s.weeklyOff + s.holidays + s.unmarked;
          expect(total).toBe(daysBetween(from, to));
          expect(s.attendedHalfDays).toBe(s.present * 2 + s.halfDays);
          expect(s.lateMinutes).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });
});
