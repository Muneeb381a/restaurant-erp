import { describe, expect, it } from 'vitest';
import { rangeFor } from './DashboardPage';

describe('dashboard ranges follow the business day', () => {
  it('"today" is the day given, even when the clock has passed midnight', () => {
    // the open business day is the 14th; at 1 a.m. the clock already says the 15th
    const businessDay = new Date('2026-11-14T00:00:00');
    expect(rangeFor('today', businessDay)).toEqual({ from: '2026-11-14', to: '2026-11-14' });
    expect(rangeFor('yesterday', businessDay)).toEqual({ from: '2026-11-13', to: '2026-11-13' });
    expect(rangeFor('7d', businessDay)).toEqual({ from: '2026-11-08', to: '2026-11-14' });
  });

  it('this month and last month are counted from that day', () => {
    const d = new Date('2026-12-01T00:00:00');
    expect(rangeFor('month', d)).toEqual({ from: '2026-12-01', to: '2026-12-01' });
    expect(rangeFor('lastMonth', d)).toEqual({ from: '2026-11-01', to: '2026-11-30' });
  });
});
