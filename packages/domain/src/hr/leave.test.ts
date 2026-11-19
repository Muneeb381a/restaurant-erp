import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { HrError } from './attendance';
import {
  formatLeaveDays,
  leaveBalance,
  leaveDates,
  leaveHalfDays,
  MAX_LEAVE_DAYS,
  rangesOverlap,
} from './leave';

const holidays = new Set(['2026-08-14']); // a Friday
const base = { weeklyOff: [0], holidays }; // Sunday off

describe('the days a leave uses', () => {
  it('skips the weekly day off and public holidays inside the range', () => {
    // Thu 13 Aug .. Tue 18 Aug: Thu, (Fri 14 holiday), Sat, (Sun 16 off), Mon, Tue
    expect(leaveDates({ from: '2026-08-13', to: '2026-08-18', ...base })).toEqual([
      '2026-08-13',
      '2026-08-15',
      '2026-08-17',
      '2026-08-18',
    ]);
    expect(leaveHalfDays({ from: '2026-08-13', to: '2026-08-18', ...base })).toBe(8);
  });
  it('a request that lies wholly on a day off uses nothing', () => {
    expect(leaveHalfDays({ from: '2026-08-16', to: '2026-08-16', ...base })).toBe(0);
    expect(leaveHalfDays({ from: '2026-08-14', to: '2026-08-14', ...base })).toBe(0);
  });
  it('a half day is one unit, one day only, and only on a working day', () => {
    expect(leaveHalfDays({ from: '2026-08-17', to: '2026-08-17', ...base, half: true })).toBe(1);
    expect(leaveHalfDays({ from: '2026-08-16', to: '2026-08-16', ...base, half: true })).toBe(0);
    expect(() =>
      leaveHalfDays({ from: '2026-08-17', to: '2026-08-18', ...base, half: true }),
    ).toThrow(HrError);
  });
  it('refuses a range that is backwards, longer than a year or not a date', () => {
    expect(() => leaveDates({ from: '2026-08-18', to: '2026-08-17', ...base })).toThrow(HrError);
    expect(() => leaveDates({ from: '2026-01-01', to: '2027-12-31', ...base })).toThrow(HrError);
    expect(() => leaveDates({ from: 'x', to: '2026-01-02', ...base })).toThrow(HrError);
    expect(MAX_LEAVE_DAYS).toBe(366);
  });
  it('working days + off days = the whole range (property check)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 300 }),
        fc.integer({ min: 0, max: 40 }),
        fc.array(fc.integer({ min: 0, max: 6 }), { maxLength: 7 }),
        (start, len, off) => {
          const day = (n: number): string =>
            new Date(Date.UTC(2026, 0, 1 + n)).toISOString().slice(0, 10);
          const from = day(start);
          const to = day(start + len);
          const hs = new Set([day(start + 1), day(start + 5)]);
          const used = leaveDates({ from, to, weeklyOff: off, holidays: hs });
          expect(used.length).toBeLessThanOrEqual(len + 1);
          expect(new Set(used).size).toBe(used.length);
          for (const d of used) {
            expect(d >= from && d <= to).toBe(true);
            expect(hs.has(d)).toBe(false);
            expect(off.includes(new Date(`${d}T00:00:00Z`).getUTCDay())).toBe(false);
          }
        },
      ),
    );
  });
});

describe('leave balance', () => {
  it('allowance plus adjustments minus what was used; pending is shown separately', () => {
    expect(leaveBalance({ allowance: 28, used: 6, pending: 4 })).toEqual({
      allowance: 28,
      adjustments: 0,
      used: 6,
      pending: 4,
      remaining: 22,
      remainingAfterPending: 18,
    });
    expect(leaveBalance({ allowance: 28, adjustments: 4, used: 2 }).remaining).toBe(30);
    expect(leaveBalance({ allowance: 10, adjustments: -4, used: 2 }).remaining).toBe(4);
  });
  it('no allowance means no limit is tracked', () => {
    const b = leaveBalance({ allowance: null, used: 40, pending: 2 });
    expect(b.remaining).toBeNull();
    expect(b.remainingAfterPending).toBeNull();
  });
  it('can go negative so the caller can refuse or allow it', () => {
    expect(leaveBalance({ allowance: 4, used: 6 }).remaining).toBe(-2);
  });
  it('refuses fractions and negative figures', () => {
    expect(() => leaveBalance({ allowance: 1.5, used: 0 })).toThrow(HrError);
    expect(() => leaveBalance({ allowance: 4, used: -1 })).toThrow(HrError);
    expect(() => leaveBalance({ allowance: 4, used: 0, adjustments: 0.5 })).toThrow(HrError);
  });
});

describe('helpers', () => {
  it('ranges overlap when they share any day, ends included', () => {
    const r = (from: string, to: string) => ({ from, to });
    expect(rangesOverlap(r('2026-08-01', '2026-08-05'), r('2026-08-05', '2026-08-09'))).toBe(true);
    expect(rangesOverlap(r('2026-08-01', '2026-08-04'), r('2026-08-05', '2026-08-09'))).toBe(false);
    expect(rangesOverlap(r('2026-08-03', '2026-08-03'), r('2026-08-01', '2026-08-09'))).toBe(true);
  });
  it('shows half-days as days', () => {
    expect(formatLeaveDays(0)).toBe('0');
    expect(formatLeaveDays(1)).toBe('0.5');
    expect(formatLeaveDays(5)).toBe('2.5');
    expect(formatLeaveDays(8)).toBe('4');
  });
});
