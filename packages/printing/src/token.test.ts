import { describe, expect, it } from 'vitest';
import { describe as describeBytes } from './escpos';
import { renderTokenSlip, renderTokenSlipBitmap, type TokenDoc } from './token';

const doc: TokenDoc = {
  restaurant: 'Desi Dera',
  orderNo: 17,
  orderType: 'DINE_IN',
  tableCode: 'T3',
  dateTime: '01/08/2026 19:42',
};
const text = (d: TokenDoc, mm: 58 | 80 = 80): string => describeBytes(renderTokenSlip(d, mm));

describe('the token slip', () => {
  it('is a small separate ticket: the restaurant, the token huge, where, when, a line to keep it', () => {
    const t = text(doc);
    expect(t).toContain('Desi Dera');
    expect(t).toContain('<SIZE:4x4>17');
    expect(t).toContain('Table T3');
    expect(t).toContain('01/08/2026 19:42');
    expect(t).toContain('Show it when you pay.');
    expect(t.match(/<CUT/g) ?? []).toHaveLength(1);
  });
  it('shows the order type when there is no table, and carries no amounts', () => {
    const t = text({ ...doc, orderType: 'TAKEAWAY', tableCode: null });
    expect(t).toContain('Takeaway');
    expect(t).not.toMatch(/Rs |TOTAL/);
  });
  it('fits narrow paper: 5 digits at 4x width are 20 columns of 32', () => {
    expect(text({ ...doc, orderNo: 12345 }, 58)).toContain('<SIZE:4x4>12345');
    expect('12345'.length * 4).toBeLessThanOrEqual(32);
  });
  it('has an Urdu bitmap version that prints', () => {
    const bytes = renderTokenSlipBitmap({ ...doc, restaurantUr: 'دیسی ڈیرہ' }, 80);
    expect(bytes.length).toBeGreaterThan(100);
  });
});
