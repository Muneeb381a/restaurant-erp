/**
 * Fiscal reporting to the tax authority (PRA / SRB / KPRA / BRA / FBR). The core never talks to an
 * authority directly: it queues a job and a worker calls a `FiscalProvider`. Real authority drivers
 * need the authority's API specification and credentials (OPEN-QUESTIONS #20); until then the
 * `MockFiscalProvider` exercises the whole pipeline (queue, retries, receipt fields, reconciliation).
 */

export interface FiscalLine {
  description: string;
  qty: number;
  unitPricePaisa: number;
  /** Line amount before the bill-level discount and service charge. */
  netPaisa: number;
  taxPaisa: number;
  taxRateBps: number | null;
}

export interface FiscalInvoice {
  kind: 'INVOICE' | 'CREDIT_NOTE';
  /** Our own number: bill_no or cn_no (per business day). */
  documentNo: number;
  /** For a credit note: the fiscal invoice number of the original sale. */
  originalInvoiceNo: string | null;
  businessDate: string;
  issuedAt: string;
  seller: { name: string; ntn: string | null; strn: string | null };
  lines: FiscalLine[];
  subtotalPaisa: number;
  discountPaisa: number;
  serviceChargePaisa: number;
  taxPaisa: number;
  totalPaisa: number;
  paymentClass: 'CASH_OTHER' | 'DIGITAL';
  /** Same key = same document: a provider (or the mock) must never create two invoices for it. */
  idempotencyKey: string;
}

export interface FiscalResult {
  /** The authority's invoice number, printed on the receipt. */
  invoiceNo: string;
  /** Payload for the receipt QR code. */
  qr: string;
  raw: unknown;
}

/** `retryable`: a network/5xx problem (try again later). Otherwise the document itself is refused. */
export class FiscalError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'FiscalError';
  }
}

export interface FiscalProvider {
  readonly code: string;
  submit(doc: FiscalInvoice): Promise<FiscalResult>;
}

/** Catches documents the authority would refuse anyway, before a request is made. */
export function validateFiscalInvoice(doc: FiscalInvoice): void {
  const refuse = (msg: string): never => {
    throw new FiscalError(msg, false);
  };
  if (doc.lines.length === 0) refuse('A fiscal document needs at least one line');
  if (!doc.seller.ntn && !doc.seller.strn) refuse('The seller has no NTN/STRN set');
  const lineTax = doc.lines.reduce((n, l) => n + l.taxPaisa, 0);
  if (lineTax !== doc.taxPaisa)
    refuse(`Line taxes (${lineTax}) do not add up to the document tax (${doc.taxPaisa})`);
  for (const n of [doc.totalPaisa, doc.taxPaisa, doc.subtotalPaisa])
    if (!Number.isSafeInteger(n) || n < 0) refuse('Amounts must be non-negative whole paisa');
  if (doc.kind === 'CREDIT_NOTE' && !doc.originalInvoiceNo)
    refuse('A credit note must reference the original fiscal invoice');
}

export interface MockOptions {
  /** Fail this many submissions with a retryable error first (simulates the internet being down). */
  failFirst?: number;
  /** Refuse every document permanently (simulates a rejected invoice). */
  rejectAll?: boolean;
  prefix?: string;
}

/** Deterministic stand-in for an authority: idempotent by key, numbers its invoices sequentially. */
export class MockFiscalProvider implements FiscalProvider {
  readonly code = 'MOCK';
  readonly submissions: FiscalInvoice[] = [];
  private readonly byKey = new Map<string, FiscalResult>();
  private seq = 0;
  private failures: number;

  constructor(private readonly options: MockOptions = {}) {
    this.failures = options.failFirst ?? 0;
  }

  setFailures(n: number): void {
    this.failures = n;
  }

  async submit(doc: FiscalInvoice): Promise<FiscalResult> {
    if (this.options.rejectAll)
      throw new FiscalError('Mock authority rejected the document', false);
    if (this.failures > 0) {
      this.failures--;
      throw new FiscalError('Mock authority unreachable', true);
    }
    validateFiscalInvoice(doc);
    const prior = this.byKey.get(doc.idempotencyKey);
    if (prior) return prior; // a repeated request returns the same invoice, as a real authority would
    this.submissions.push(doc);
    const prefix = this.options.prefix ?? (doc.kind === 'INVOICE' ? 'MOCK-INV' : 'MOCK-CN');
    const result: FiscalResult = {
      invoiceNo: `${prefix}-${String(++this.seq).padStart(6, '0')}`,
      qr: `MOCK|${doc.seller.ntn ?? doc.seller.strn}|${doc.documentNo}|${doc.totalPaisa}|${doc.taxPaisa}`,
      raw: { accepted: true },
    };
    this.byKey.set(doc.idempotencyKey, result);
    return result;
  }
}
