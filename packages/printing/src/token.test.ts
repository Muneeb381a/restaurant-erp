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
    expect(t).toContain(' TAKEAWAY ');
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

describe('the token slip for takeaway and delivery', () => {
  it('has the banner and the customer name and phone, but not the address', () => {
    const t = text({
      ...doc,
      orderType: 'DELIVERY',
      tableCode: null,
      customer: { name: 'Ali Raza', phone: '0300-1234567', address: 'House 12' },
    });
    expect(t).toContain(' DELIVERY ');
    expect(t).toContain('Name: Ali Raza');
    expect(t).toContain('Phone: 0300-1234567');
    expect(t).not.toContain('House 12');
  });
});

describe('the token slip for an online order', () => {
  it('names the platform and its order number in text and bitmap', () => {
    const online = {
      ...doc,
      orderType: 'TAKEAWAY' as const,
      tableCode: null,
      customer: { name: 'Sara', channel: 'WHATSAPP', ref: '77' },
    };
    expect(text(online)).toContain('[ WHATSAPP ORDER  #77 ]');
    expect(renderTokenSlipBitmap(online, 80).length).toBeGreaterThan(0);
  });
});

describe('source label fallbacks', () => {
  it('keeps an unknown channel as written, and omits the number when there is none', () => {
    expect(text({ ...doc, customer: { channel: 'UBEREATS' } })).toContain('[ UBEREATS ]');
  });
});

describe('dine-in token without a table', () => {
  it('says Dine-in', () => {
    expect(text({ ...doc, orderType: 'DINE_IN', tableCode: null })).toContain('Dine-in');
  });
});
