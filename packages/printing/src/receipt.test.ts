import { describe, expect, it } from 'vitest';
import { describe as describeBytes } from './escpos';
import { money, renderReceipt, type ReceiptDoc } from './receipt';

const base: ReceiptDoc = {
  restaurant: 'Desi Dera',
  address: 'Main Boulevard, Gulberg, Lahore',
  phone: '042-1234567',
  billNo: 12,
  orderNo: 7,
  orderType: 'DINE_IN',
  tableCode: 'T1',
  waiter: 'Ali',
  cashier: 'Sara',
  dateTime: '01/08/2026 19:42',
  lines: [
    { qty: 3, name: 'Chicken Tikka (Leg)', amountPaisa: 108000 },
    { qty: 1, name: 'Chicken Karahi (Full)', amountPaisa: 240000, modifiers: ['Extra hot'] },
    { qty: 1, name: 'Mutton Chops', weightG: 750, amountPaisa: 360000 },
  ],
  subtotalPaisa: 708000,
  discountPaisa: 70800,
  serviceChargePaisa: 31860,
  taxPaisa: 0,
  roundOffPaisa: -60,
  totalPaisa: 669000,
  payments: [{ method: 'Cash', amountPaisa: 669000, tenderedPaisa: 700000, changePaisa: 31000 }],
};
const text = (d: ReceiptDoc, mm: 58 | 80 = 80): string => describeBytes(renderReceipt(d, mm));

describe('money()', () => {
  it.each([
    [0, '0'],
    [5, '0.05'],
    [100, '1'],
    [125050, '1,250.50'],
    [123456789, '1,234,567.89'],
    [-4680, '-46.80'],
    [-100, '-1'],
  ])('%i → %s', (paisa, expected) => expect(money(paisa)).toBe(expected));
});

describe('receipt (80 mm)', () => {
  it('prints header, bill/table/staff, lines, totals, payment and change', () => {
    expect(text(base)).toMatchInlineSnapshot(`
      "<INIT><ALIGN:center><BOLD:1><SIZE:2x2>Desi Dera
      <SIZE:1x1><BOLD:0>Main Boulevard, Gulberg, Lahore
      Tel: 042-1234567
      <ALIGN:left>------------------------------------------------
      Bill #12                        01/08/2026 19:42
      Table T1                                Order #7
      Waiter: Ali                        Cashier: Sara
      ------------------------------------------------
      3 x Chicken Tikka (Leg)                    1,080
      1 x Chicken Karahi (Full)                  2,400
          + Extra hot
      750 g Mutton Chops                         3,600
      ------------------------------------------------
      Subtotal                                   7,080
      Discount                                    -708
      Service charge                            318.60
      Round off                                  -0.60
      <BOLD:1><SIZE:1x2>TOTAL                                   Rs 6,690
      <SIZE:1x1><BOLD:0>------------------------------------------------
      Cash                                       7,000
        Change                                     310
      ------------------------------------------------
      <ALIGN:center>Thank you! Visit again

      <FEED:3><CUT>"
    `);
  });

  it('shows the drawer kick right after init when there was cash; DUPLICATE marks copies', () => {
    expect(text({ ...base, openDrawer: true })).toContain('<INIT><DRAWER>');
    expect(text(base)).not.toContain('<DRAWER>');
    expect(text({ ...base, duplicate: 2 })).toContain('*** DUPLICATE #2 ***');
    expect(text({ ...base, duplicate: 0 })).not.toContain('DUPLICATE');
    expect(text(base)).not.toContain('DUPLICATE');
  });

  it('hides zero discount/service/tax/round-off rows, shows tax when present, and tips', () => {
    const plain = text({
      ...base,
      discountPaisa: 0,
      serviceChargePaisa: 0,
      roundOffPaisa: 0,
      totalPaisa: 708000,
    });
    for (const label of ['Discount', 'Service charge', 'Tax', 'Round off'])
      expect(plain).not.toContain(label);
    expect(text({ ...base, taxPaisa: 16000 })).toContain('Tax');
    expect(text({ ...base, tipPaisa: 5000 })).toMatch(/Tip +50/);
    expect(text({ ...base, roundOffPaisa: 40 })).toMatch(/Round off +0\.40/);
  });

  it('takeaway/delivery say so; optional header and staff lines are skipped when absent', () => {
    const out = text({
      ...base,
      orderType: 'TAKEAWAY',
      tableCode: null,
      address: null,
      phone: null,
      waiter: null,
      cashier: null,
    });
    expect(out).toContain('Takeaway');
    expect(out).not.toContain('Tel:');
    expect(out).not.toContain('Waiter');
    expect(out).not.toContain('Cashier');
    expect(text({ ...base, orderType: 'DELIVERY', tableCode: null })).toContain('Delivery');
    expect(text({ ...base, waiter: null })).toContain('Cashier: Sara');
    expect(text({ ...base, cashier: null })).toContain('Waiter: Ali');
  });

  it('split payments list every tender; card shows its amount (no change)', () => {
    const out = text({
      ...base,
      payments: [
        { method: 'Card', amountPaisa: 400000, changePaisa: 0 },
        { method: 'Cash', amountPaisa: 269000, tenderedPaisa: 300000, changePaisa: 31000 },
      ],
    });
    expect(out).toMatch(/Card +4,000/);
    expect(out).toMatch(/Cash +3,000/);
    expect(out).toMatch(/Change +310/);
  });

  it('wraps long item names and keeps the amount on the last line', () => {
    const out = text({
      ...base,
      lines: [
        {
          qty: 2,
          name: 'Chicken Malai Boti Special Platter With Extra Chutney And Salad',
          amountPaisa: 456000,
        },
      ],
    });
    expect(out).toMatch(/Chutney And Salad +4,560\n/);
  });

  it('fits 58 mm paper (32 columns) and never sends non-ASCII', () => {
    const lines = text(base, 58)
      .split('\n')
      .map((l) => l.replace(/<[^>]+>/g, ''));
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(32);
    expect(renderReceipt({ ...base, restaurant: 'دیسی ڈیرہ' }).some((b) => b > 0x7f)).toBe(false);
  });
});

describe('khata receipts', () => {
  it('names the customer whose account carries the bill', () => {
    const text = describeBytes(
      renderReceipt({
        restaurant: 'R',
        billNo: 1,
        orderNo: 1,
        orderType: 'TAKEAWAY',
        dateTime: '01/08/2026 19:42',
        lines: [{ qty: 1, name: 'Karahi', amountPaisa: 100000 }],
        subtotalPaisa: 100000,
        discountPaisa: 0,
        serviceChargePaisa: 0,
        taxPaisa: 0,
        roundOffPaisa: 0,
        totalPaisa: 100000,
        payments: [{ method: 'Khata', amountPaisa: 100000, changePaisa: 0 }],
        khataCustomer: 'Haji Sahib',
      }),
    );
    expect(text).toContain('Khata a/c: Haji Sahib');
  });
});

describe('tax on the receipt', () => {
  const taxed: ReceiptDoc = {
    ...base,
    taxPaisa: 16000,
    taxLabel: 'Sales tax 16%',
    ntn: '1234567-8',
    strn: '17-00-0000-001-37',
  };
  it('shows the rate label and the registration numbers only when the bill carries tax', () => {
    const text = describeBytes(renderReceipt(taxed, 80));
    expect(text).toContain('Sales tax 16%');
    expect(text).toContain('NTN: 1234567-8  STRN: 17-00-0000-001-37');
    const untaxed = describeBytes(renderReceipt({ ...taxed, taxPaisa: 0 }, 80));
    expect(untaxed).not.toContain('NTN:');
    expect(describeBytes(renderReceipt({ ...taxed, taxLabel: null, strn: null }, 80))).toMatch(
      /Tax\s+160/,
    );
    expect(describeBytes(renderReceipt({ ...taxed, ntn: null }, 80))).toContain(
      'STRN: 17-00-0000-001-37',
    );
  });
});

describe('fiscal invoice on the receipt', () => {
  it('shows "pending" until reported, then the number and a QR code', () => {
    const pending = describeBytes(renderReceipt({ ...base, fiscalPending: true }, 80));
    expect(pending).toContain('Fiscal invoice: pending');
    expect(pending).not.toContain('<QR');
    const done = describeBytes(
      renderReceipt({ ...base, fiscalNo: 'PRA-123', fiscalQr: 'PRA|123|456' }, 80),
    );
    expect(done).toContain('Fiscal invoice: PRA-123');
    expect(done).toContain('<QR:PRA|123|456>');
    expect(done).toContain('<QR-PRINT>');
    expect(done).not.toContain('pending');
    const noQr = describeBytes(renderReceipt({ ...base, fiscalNo: 'PRA-123' }, 80));
    expect(noQr).toContain('Fiscal invoice: PRA-123');
    expect(noQr).not.toContain('<QR');
  });
});
