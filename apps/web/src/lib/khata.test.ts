import { describe, expect, it } from 'vitest';
import { creditUse, daysSince, debtAge, reminderText } from './khata';

describe('daysSince', () => {
  const now = new Date(2026, 10, 13, 15, 0); // 13 Nov, afternoon
  it('counts calendar days, so late last night is "1 day", not "today"', () => {
    expect(daysSince(new Date(2026, 10, 13, 9, 0).toISOString(), now)).toBe(0);
    expect(daysSince(new Date(2026, 10, 12, 23, 59).toISOString(), now)).toBe(1);
    expect(daysSince(new Date(2026, 9, 14, 8, 0).toISOString(), now)).toBe(30);
  });
  it('has no answer without a date and never goes negative', () => {
    expect(daysSince(null, now)).toBeNull();
    expect(daysSince('not a date', now)).toBeNull();
    expect(daysSince(new Date(2026, 10, 20).toISOString(), now)).toBe(0);
  });
});

describe('debtAge', () => {
  it('fresh up to a month, late up to two, then overdue', () => {
    expect(debtAge(null)).toBe('none');
    expect(debtAge(0)).toBe('fresh');
    expect(debtAge(30)).toBe('fresh');
    expect(debtAge(31)).toBe('late');
    expect(debtAge(60)).toBe('late');
    expect(debtAge(61)).toBe('overdue');
  });
});

describe('creditUse', () => {
  it('is clear with nothing owed', () => {
    expect(creditUse(0, 100_000)).toEqual({ pct: 0, state: 'clear' });
    expect(creditUse(-5, 100_000).state).toBe('clear');
  });
  it('warns at 90% and flags anything above the limit', () => {
    expect(creditUse(50_000, 100_000)).toEqual({ pct: 50, state: 'ok' });
    expect(creditUse(89_999, 100_000).state).toBe('ok');
    expect(creditUse(90_000, 100_000).state).toBe('near');
    expect(creditUse(100_000, 100_000).state).toBe('near');
    expect(creditUse(100_001, 100_000)).toEqual({ pct: 100, state: 'over' });
  });
  it('treats owing with no credit at all as over', () => {
    expect(creditUse(1, 0)).toEqual({ pct: 100, state: 'over' });
  });
});

describe('reminderText', () => {
  const input = {
    customer: 'Haji Rashid',
    restaurant: 'Lahore Karahi House',
    balancePaisa: 125_050,
  };
  it('names the customer, the restaurant and the exact amount', () => {
    const en = reminderText(input, 'en');
    expect(en).toContain('Haji Rashid');
    expect(en).toContain('Lahore Karahi House');
    expect(en).toContain('Rs 1,250.50');
  });
  it('can be written in Urdu with the same amount', () => {
    const ur = reminderText(input, 'ur');
    expect(ur).toContain('بقایا');
    expect(ur).toContain('Rs 1,250.50');
    expect(ur).toContain('Haji Rashid');
  });
});
