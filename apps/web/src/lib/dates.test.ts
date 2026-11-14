import { describe, expect, it } from 'vitest';
import { localDate } from './dates';

describe('localDate', () => {
  it('uses the local calendar day, not the UTC one', () => {
    // 00:30 on the 15th on this device, whatever its time zone is
    expect(localDate(new Date(2026, 10, 15, 0, 30))).toBe('2026-11-15');
    expect(localDate(new Date(2026, 0, 1, 23, 59))).toBe('2026-01-01');
  });

  it('pads month and day', () => {
    expect(localDate(new Date(2026, 2, 5, 12))).toBe('2026-03-05');
  });
});
