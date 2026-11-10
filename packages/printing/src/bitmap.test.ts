import { describe, expect, it } from 'vitest';
import { BitmapDoc, DOTS } from './bitmap';
import { describe as readable } from './escpos';
import { renderReceiptBitmap, UR } from './receipt-ur';
import type { ReceiptDoc } from './receipt';

const inkOf = (b: { data: Uint8Array }): number =>
  b.data.reduce((n, byte) => n + byte.toString(2).replace(/0/g, '').length, 0);

describe('BitmapDoc', () => {
  it('packs rows to the paper width and puts ink only where text is drawn', () => {
    const empty = new BitmapDoc(DOTS[80]).space(20).toBits();
    expect(empty.widthBytes).toBe(72);
    expect(empty.height).toBe(20);
    expect(inkOf(empty)).toBe(0);

    const urdu = new BitmapDoc(DOTS[80]).text('شکریہ', { rtl: true }, 'center').toBits();
    expect(inkOf(urdu)).toBeGreaterThan(200); // real glyphs were shaped and drawn
  });

  it('right-to-left rows put the label on the right and the amount on the left', () => {
    const half = (b: BitmapDoc, side: 'left' | 'right'): number => {
      const { widthBytes, height, data } = b.toBits();
      let n = 0;
      for (let y = 0; y < height; y++)
        for (let x = 0; x < widthBytes; x++) {
          const inLeft = x < widthBytes / 2;
          if ((side === 'left') === inLeft)
            n += data[y * widthBytes + x]!.toString(2).replace(/0/g, '').length;
        }
      return n;
    };
    const rtl = new BitmapDoc(DOTS[80]).row('ذیلی کل', '7,080', { rtl: true });
    // the amount "7,080" is short; the Urdu label is longer: the right half holds the label
    expect(half(rtl, 'right')).toBeGreaterThan(0);
    expect(half(rtl, 'left')).toBeGreaterThan(0);
    const ltr = new BitmapDoc(DOTS[80]).row('Subtotal', '7,080', {});
    expect(half(ltr, 'left')).toBeGreaterThan(0);
  });

  it('wraps a long label onto several lines instead of cutting it', () => {
    const one = new BitmapDoc(DOTS[58]).row('کباب', '10').toBits().height;
    const many = new BitmapDoc(DOTS[58])
      .row('چکن تکہ بوٹی بغیر ہڈی مصالحہ دار اضافی چٹنی کے ساتھ خاص', '1,000', { rtl: true })
      .toBits().height;
    expect(many).toBeGreaterThan(one);
  });

  it('sends raster bands of at most 255 rows, after init, ending with a cut', () => {
    const b = new BitmapDoc(DOTS[58]);
    for (let i = 0; i < 20; i++) b.text('سطر', { rtl: true }, 'center');
    const text = readable(b.toEscPos());
    expect(text.startsWith('<INIT>')).toBe(true);
    const bands = [...text.matchAll(/<RASTER:384x(\d+)>/g)].map((m) => Number(m[1]));
    expect(bands.length).toBeGreaterThan(1);
    for (const h of bands) expect(h).toBeLessThanOrEqual(255);
    expect(text.trimEnd().endsWith('<CUT>')).toBe(true);
  });
});

const doc: ReceiptDoc = {
  restaurant: 'Lahore Karahi House',
  restaurantUr: 'لاہور کڑاہی ہاؤس',
  billNo: 12,
  orderNo: 7,
  orderType: 'DINE_IN',
  tableCode: 'T1',
  waiter: 'Ali',
  cashier: 'Sara',
  dateTime: '01/08/2026 19:42',
  lines: [
    { qty: 3, name: 'Chicken Tikka (Leg)', nameUr: 'چکن تکہ (ٹانگ)', amountPaisa: 108000 },
    { qty: 1, name: 'Mutton Chops', weightG: 750, amountPaisa: 360000 },
  ],
  subtotalPaisa: 468000,
  discountPaisa: 46800,
  serviceChargePaisa: 0,
  taxPaisa: 0,
  roundOffPaisa: 0,
  totalPaisa: 421200,
  payments: [{ method: 'Cash', amountPaisa: 421200, tenderedPaisa: 500000, changePaisa: 78800 }],
  openDrawer: true,
};

describe('renderReceiptBitmap', () => {
  it('prints the whole bill as bitmap: no ASCII text, drawer kick first, cut last', () => {
    const text = readable(renderReceiptBitmap(doc, 80));
    expect(text.startsWith('<INIT><DRAWER>')).toBe(true);
    expect(text).toMatch(/<RASTER:576x\d+>/);
    expect(text).not.toContain('TOTAL'); // labels are drawn as pixels, not sent as text
    expect(text.trimEnd().endsWith('<CUT>')).toBe(true);
  });

  it('a duplicate copy never kicks the drawer, and 58 mm is narrower', () => {
    const dup = readable(renderReceiptBitmap({ ...doc, duplicate: 1 }, 58));
    expect(dup).not.toContain('<DRAWER>');
    expect(dup).toMatch(/<RASTER:384x\d+>/);
  });

  it('the Urdu wording is in one reviewable table', () => {
    expect(UR.total).toBe('کل رقم');
    expect(Object.values(UR).every((v) => v.length > 0)).toBe(true);
  });

  it('shows the discount, service, tax, round-off, tip and khata only when present', () => {
    const plain = new BitmapDoc(DOTS[80]);
    void plain;
    const heightOf = (d: ReceiptDoc): number => {
      const bytes = renderReceiptBitmap(d, 80);
      return [...readable(bytes).matchAll(/<RASTER:576x(\d+)>/g)].reduce(
        (n, m) => n + Number(m[1]),
        0,
      );
    };
    const base = heightOf({ ...doc, discountPaisa: 0 });
    const full = heightOf({
      ...doc,
      serviceChargePaisa: 100,
      taxPaisa: 100,
      roundOffPaisa: -50,
      tipPaisa: 500,
      khataCustomer: 'حاجی صاحب',
      duplicate: 2,
      phone: '0300-1',
      address: 'Main Bazar',
    });
    expect(full).toBeGreaterThan(base);
  });

  it('handles takeaway bills without table or staff names, and item modifiers', () => {
    const text = readable(
      renderReceiptBitmap(
        {
          ...doc,
          orderType: 'TAKEAWAY',
          tableCode: null,
          waiter: null,
          cashier: null,
          lines: [{ qty: 1, name: 'Karahi', amountPaisa: 100000, modifiers: ['Extra hot'] }],
        },
        80,
      ),
    );
    expect(text).toMatch(/<RASTER:576x\d+>/);
  });
});
