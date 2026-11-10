import { describe, expect, it } from 'vitest';
import {
  FiscalError,
  MockFiscalProvider,
  validateFiscalInvoice,
  type FiscalInvoice,
} from './index';

const doc = (over: Partial<FiscalInvoice> = {}): FiscalInvoice => ({
  kind: 'INVOICE',
  documentNo: 12,
  originalInvoiceNo: null,
  businessDate: '2026-08-01',
  issuedAt: '2026-08-01T14:00:00Z',
  seller: { name: 'Lahore Karahi House', ntn: '1234567-8', strn: null },
  lines: [
    {
      description: 'Tikka',
      qty: 1,
      unitPricePaisa: 100000,
      netPaisa: 100000,
      taxPaisa: 16000,
      taxRateBps: 1600,
    },
  ],
  subtotalPaisa: 100000,
  discountPaisa: 0,
  serviceChargePaisa: 0,
  taxPaisa: 16000,
  totalPaisa: 116000,
  paymentClass: 'CASH_OTHER',
  idempotencyKey: 'MOCK:BILL:abc',
  ...over,
});
const refusal = (fn: () => unknown): FiscalError | undefined => {
  try {
    fn();
  } catch (e) {
    return e as FiscalError;
  }
  return undefined;
};

describe('validateFiscalInvoice', () => {
  it('accepts a consistent document', () => {
    expect(() => validateFiscalInvoice(doc())).not.toThrow();
    expect(() =>
      validateFiscalInvoice(doc({ seller: { name: 'x', ntn: null, strn: '17-00' } })),
    ).not.toThrow();
  });

  it('refuses what an authority would refuse, as a permanent error', () => {
    const cases: Partial<FiscalInvoice>[] = [
      { lines: [] },
      { seller: { name: 'x', ntn: null, strn: null } },
      { taxPaisa: 1 }, // line taxes do not add up
      { totalPaisa: -1 },
      { kind: 'CREDIT_NOTE', originalInvoiceNo: null },
    ];
    for (const c of cases) {
      const e = refusal(() => validateFiscalInvoice(doc(c)));
      expect(e, JSON.stringify(c)).toBeInstanceOf(FiscalError);
      expect(e!.retryable).toBe(false);
    }
    expect(() =>
      validateFiscalInvoice(doc({ kind: 'CREDIT_NOTE', originalInvoiceNo: 'MOCK-INV-000001' })),
    ).not.toThrow();
  });
});

describe('MockFiscalProvider', () => {
  it('numbers invoices and credit notes and builds a QR payload', async () => {
    const p = new MockFiscalProvider();
    const a = await p.submit(doc({ idempotencyKey: 'k1' }));
    const b = await p.submit(doc({ idempotencyKey: 'k2' }));
    const c = await p.submit(
      doc({ kind: 'CREDIT_NOTE', originalInvoiceNo: a.invoiceNo, idempotencyKey: 'k3' }),
    );
    expect([a.invoiceNo, b.invoiceNo]).toEqual(['MOCK-INV-000001', 'MOCK-INV-000002']);
    expect(c.invoiceNo).toBe('MOCK-CN-000003');
    expect(a.qr).toBe('MOCK|1234567-8|12|116000|16000');
    expect(p.submissions).toHaveLength(3);
  });

  it('is idempotent by key: the same document never gets two invoice numbers', async () => {
    const p = new MockFiscalProvider();
    const first = await p.submit(doc());
    const again = await p.submit(doc());
    expect(again).toBe(first);
    expect(p.submissions).toHaveLength(1);
  });

  it('can simulate an outage (retryable) and a rejection (permanent)', async () => {
    const p = new MockFiscalProvider({ failFirst: 2 });
    for (let i = 0; i < 2; i++) {
      const e = await p.submit(doc()).catch((x: FiscalError) => x);
      expect(e).toBeInstanceOf(FiscalError);
      expect((e as FiscalError).retryable).toBe(true);
    }
    expect((await p.submit(doc())).invoiceNo).toMatch(/^MOCK-INV-/);
    p.setFailures(1);
    expect(
      await p.submit(doc({ idempotencyKey: 'other' })).catch((x: FiscalError) => x.retryable),
    ).toBe(true);

    const rejecting = new MockFiscalProvider({ rejectAll: true });
    expect(await rejecting.submit(doc()).catch((x: FiscalError) => x.retryable)).toBe(false);
  });

  it('refuses invalid documents without numbering them, and honours a custom prefix', async () => {
    const p = new MockFiscalProvider({ prefix: 'X' });
    expect(await p.submit(doc({ lines: [] })).catch((x: FiscalError) => x.retryable)).toBe(false);
    expect((await p.submit(doc())).invoiceNo).toBe('X-000001');
  });
});
