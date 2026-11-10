import { MockFiscalProvider, type FiscalProvider } from '@erp/fiscal-adapters';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processFiscalJobs } from '../../src/modules/fiscal/fiscal.service';
import { processPrintJobs, TcpTransport } from '../../src/modules/printing/print.service';
import { startApp, type TestApp } from './app-harness';
import { SimPrinter } from './sim-printer';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let t: TestApp;
let owner: string;
let manager: string;
let cashier: string;
let captain: string;
let item: { id: string; variantId: string };
let receiptSim: SimPrinter;
const M: Record<string, string> = {};
const api = (tok: string) => t.as(tok);
const run = () => processPrintJobs(t.ctx, new TcpTransport());
let keySeq = 0;
const key = () => `fiscal-key-${Date.now()}-${++keySeq}`;

/** A provider whose behaviour the test controls; `pass` runs one worker pass against it. */
let provider: MockFiscalProvider = new MockFiscalProvider();
const resolve = (code: string): FiscalProvider | undefined =>
  code === 'MOCK' ? provider : undefined;
const pass = () => processFiscalJobs(t.ctx, resolve);
const jobsOf = () => t.kdb.selectFrom('fiscal_jobs').selectAll().orderBy('created_at').execute();

async function sale(): Promise<Json> {
  const o = (await api(captain).post('/orders', { type: 'TAKEAWAY' })).body;
  await api(captain).post(`/orders/${o.id}/items`, { itemId: item.id, variantId: item.variantId });
  await api(captain).post(`/orders/${o.id}/send`, {});
  const bill = (await api(cashier).post(`/orders/${o.id}/bill`)).body;
  const res = await api(cashier)
    .post(`/bills/${bill.id}/settle`, {
      tenders: [{ methodId: M.CASH, amountPaisa: bill.totalPaisa, tenderedPaisa: bill.totalPaisa }],
    })
    .set('Idempotency-Key', key());
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.bill;
}
const billRow = (id: string) =>
  t.kdb.selectFrom('bills').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const setting = (k: string, v: unknown, tok = owner) =>
  api(tok).put(`/settings/${k}`, { value: v });

beforeAll(async () => {
  t = await startApp();
  owner = (await t.login('OWNER')).token;
  manager = (await t.login('MANAGER')).token;
  cashier = (await t.login('CASHIER')).token;
  captain = (await t.login('CAPTAIN')).token;
  const lists: { id: string }[] = [];
  for (const code of ['DINE_IN', 'TAKEAWAY', 'DELIVERY'])
    lists.push((await api(owner).post('/price-lists', { code, name: code })).body);
  const station = (await api(owner).post('/stations', { code: 'BBQ', name: 'BBQ' })).body.id;
  const res = await api(owner).post('/items', {
    kind: 'STANDARD',
    name: 'Tikka',
    stationId: station,
  });
  for (const l of lists)
    await api(owner).put(`/variants/${res.body.variants[0].id}/prices/${l.id}`, {
      pricePaisa: 100000,
    });
  item = { id: res.body.id, variantId: res.body.variants[0].id };
  const kot = await SimPrinter.start();
  const kp = (
    await api(owner).post('/printers', {
      name: 'kot',
      kind: 'KOT',
      conn_type: 'NETWORK',
      host: '127.0.0.1',
      port: kot.port,
    })
  ).body.id;
  await api(owner).put(`/stations/${station}/printers`, { printerIds: [kp] });
  receiptSim = await SimPrinter.start();
  await api(owner).post('/printers', {
    name: 'counter',
    kind: 'RECEIPT',
    conn_type: 'NETWORK',
    host: '127.0.0.1',
    port: receiptSim.port,
  });
  for (const [code, cls, extra] of [['CASH', 'CASH_OTHER', { opens_drawer: true }]] as const)
    M[code] = (
      await api(owner).post('/payment-methods', { code, name: code, tender_class: cls, ...extra })
    ).body.id;
  await api(cashier).post('/business-days/open', {});
  await api(cashier).post('/shifts/open', { openingFloatPaisa: 500000 });
  await api(manager).post('/shifts/open', { openingFloatPaisa: 5_000_000 });
}, 240_000);

afterAll(async () => {
  await receiptSim.unplug();
  await t.stop();
});

describe('off by default', () => {
  it('nothing is queued while fiscal reporting is off', async () => {
    const bill = await sale();
    expect((await billRow(bill.id)).fiscal_status).toBe('NOT_REQUIRED');
    expect(await jobsOf()).toHaveLength(0);
    expect(bill.fiscalStatus).toBe('NOT_REQUIRED');
  });

  it('needs tax.manage to choose a provider, and does nothing unless tax itself is on', async () => {
    expect((await setting('fiscal.provider', 'MOCK', manager)).status).toBe(403);
    expect((await setting('fiscal.provider', 'PRA')).status).toBe(400); // no real driver exists yet
    expect((await setting('fiscal.provider', 'MOCK')).status).toBe(200);
    await sale(); // tax is still off
    expect(await jobsOf()).toHaveLength(0);
  });
});

describe('with tax on and a provider', () => {
  beforeAll(async () => {
    await api(owner).patch('/branch', {
      tax_authority: 'PRA',
      ntn: '1234567-8',
      strn: '17-00-0000-001-37',
    });
    const cat = (
      await t.kdb
        .selectFrom('tax_categories')
        .select('id')
        .where('code', '=', 'RESTAURANT_SERVICE')
        .executeTakeFirstOrThrow()
    ).id;
    for (const [paymentClass, rateBps] of [
      ['CASH_OTHER', 1600],
      ['DIGITAL', 800],
    ] as const)
      await api(owner).post('/tax/rules', {
        authority: 'PRA',
        categoryId: cat,
        paymentClass,
        rateBps,
        effectiveFrom: '2026-01-01',
        verifiedBy: 'A. Khan, CA',
      });
    expect((await setting('tax.enabled', true)).status).toBe(200);
  });

  it('a sale queues the bill, prints "pending", and reporting fills in the fiscal number and QR', async () => {
    await run();
    const before = receiptSim.jobs.length;
    const bill = await sale();
    expect(bill.fiscalStatus).toBe('PENDING');
    await run();
    expect(receiptSim.jobs.length).toBe(before + 1);
    expect(receiptSim.tickets().at(-1)).toContain('Fiscal invoice: pending');

    const r = await pass();
    expect(r).toMatchObject({ submitted: 1, retrying: 0, rejected: 0 });
    const row = await billRow(bill.id);
    expect(row).toMatchObject({ fiscal_status: 'SUBMITTED', fiscal_invoice_no: 'MOCK-INV-000001' });
    expect(row.fiscal_qr).toContain('MOCK|1234567-8');
    expect(provider.submissions[0]).toMatchObject({
      kind: 'INVOICE',
      documentNo: bill.billNo,
      taxPaisa: 16000,
      totalPaisa: 116000,
      paymentClass: 'CASH_OTHER',
    });

    // a reprint now carries the number and the QR code
    await api(cashier).post(`/bills/${bill.id}/reprint`, {
      reason: 'Customer wants the fiscal copy',
    });
    await run();
    const copy = receiptSim.tickets().at(-1)!;
    expect(copy).toContain('Fiscal invoice: MOCK-INV-000001');
    expect(copy).toContain('<QR:MOCK|1234567-8');
  });

  it('an outage backs off and retries; the sale was never affected', async () => {
    provider = new MockFiscalProvider({ failFirst: 2, prefix: 'RETRY' });
    const bill = await sale(); // the cashier saw no error
    const first = await pass();
    expect(first).toMatchObject({ submitted: 0, retrying: 1 });
    let job = (await jobsOf()).at(-1)!;
    expect(job).toMatchObject({ status: 'FAILED', permanent: false, attempts: 1 });
    expect(job.last_error).toContain('unreachable');
    expect((await billRow(bill.id)).fiscal_status).toBe('PENDING'); // still queued, not failed

    expect(await pass()).toMatchObject({ submitted: 0, retrying: 0 }); // not due yet: backing off
    t.clock.advance(31_000);
    expect(await pass()).toMatchObject({ retrying: 1 });
    t.clock.advance(61_000);
    expect(await pass()).toMatchObject({ submitted: 1 });
    job = (await jobsOf()).at(-1)!;
    expect(job).toMatchObject({ status: 'DONE', attempts: 3 });
    expect((await billRow(bill.id)).fiscal_invoice_no).toBe('RETRY-000001');
  });

  it('a refused document is parked, shown to the owner, and can be retried once fixed (audited)', async () => {
    provider = new MockFiscalProvider({ rejectAll: true });
    const bill = await sale();
    expect(await pass()).toMatchObject({ rejected: 1 });
    expect((await billRow(bill.id)).fiscal_status).toBe('FAILED');
    expect(await pass()).toMatchObject({ rejected: 0, retrying: 0 }); // parked: not picked again

    const summary = (await api(manager).get('/fiscal/summary')).body;
    expect(summary.rejected).toBe(1);
    const parked = (await api(manager).get('/fiscal/jobs?status=rejected')).body.items as Json[];
    expect(parked).toHaveLength(1);
    expect(parked[0].lastError).toContain('rejected');
    expect((await api(captain).get('/fiscal/summary')).status).toBe(403);
    expect((await api(manager).post(`/fiscal/jobs/${parked[0].id}/retry`)).status).toBe(403); // needs tax.manage

    provider = new MockFiscalProvider({ prefix: 'FIXED' });
    expect((await api(owner).post(`/fiscal/jobs/${parked[0].id}/retry`)).status).toBe(200);
    expect(await pass()).toMatchObject({ submitted: 1 });
    expect((await billRow(bill.id)).fiscal_invoice_no).toBe('FIXED-000001');
    const log = await t.kdb
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'FISCAL_RETRY')
      .execute();
    expect(log).toHaveLength(1);
    expect((await api(owner).post(`/fiscal/jobs/${parked[0].id}/retry`)).status).toBe(409); // already reported
  });

  it('a credit note waits for its original invoice, then is reported against it', async () => {
    provider = new MockFiscalProvider({ failFirst: 1, prefix: 'DOC' });
    const bill = await sale();
    const line = (await api(manager).get(`/bills/${bill.id}/refundable`)).body.lines[0];
    const cn = await api(manager)
      .post(`/bills/${bill.id}/credit-notes`, {
        lines: [{ billLineId: line.id, qty: 1 }],
        reason: 'Wrong dish',
        methodId: M.CASH,
      })
      .set('Idempotency-Key', key());
    expect(cn.status, JSON.stringify(cn.body)).toBe(201);

    // bill job fails once (outage); the credit note job is deferred because the bill has no fiscal number yet
    expect(await pass()).toMatchObject({ retrying: 1, deferred: 1, submitted: 0 });
    // both are due after the wait; the bill goes first, so the credit note can reference its number
    t.clock.advance(31_000);
    expect(await pass()).toMatchObject({ submitted: 2, deferred: 0 });
    const note = await t.kdb
      .selectFrom('credit_notes')
      .selectAll()
      .where('id', '=', cn.body.id)
      .executeTakeFirstOrThrow();
    expect(note).toMatchObject({ fiscal_status: 'SUBMITTED' });
    expect(note.fiscal_invoice_no).toMatch(/^DOC-/);
    const sent = provider.submissions.at(-1)!;
    expect(sent).toMatchObject({ kind: 'CREDIT_NOTE', taxPaisa: 16000, totalPaisa: 116000 });
    expect(sent.originalInvoiceNo).toBe((await billRow(bill.id)).fiscal_invoice_no);
  });

  it('the day reconciliation says whether everything sold was reported', async () => {
    provider = new MockFiscalProvider();
    const open = await sale(); // not reported yet
    const day = (await api(manager).get('/business-days/current')).body.day;
    const before = (await api(owner).get(`/fiscal/reconciliation?businessDate=${day.businessDate}`))
      .body;
    expect(before.balanced).toBe(false);
    expect(before.unreported.map((b: Json) => b.billNo)).toContain(open.billNo);

    await pass();
    const after = (await api(owner).get(`/fiscal/reconciliation?businessDate=${day.businessDate}`))
      .body;
    expect(after.balanced).toBe(true);
    expect(after.taxReportedPaisa).toBe(after.taxSoldPaisa);
    expect(after.creditNotes.SUBMITTED.count).toBeGreaterThanOrEqual(1);
    expect((await api(owner).get('/fiscal/reconciliation?businessDate=2020-01-01')).status).toBe(
      404,
    );
  });

  it('a reported job is immutable, and jobs cannot be deleted', async () => {
    const done = (await jobsOf()).find((j) => j.status === 'DONE')!;
    await expect(
      t.kdb
        .updateTable('fiscal_jobs')
        .set({ last_error: 'edited' })
        .where('id', '=', done.id)
        .execute(),
    ).rejects.toBeTruthy();
    await expect(
      t.kdb.deleteFrom('fiscal_jobs').where('id', '=', done.id).execute(),
    ).rejects.toBeTruthy();
  });

  it('switching tax off stops new documents from being queued', async () => {
    const before = (await jobsOf()).length;
    await setting('tax.enabled', false);
    await sale();
    expect(await jobsOf()).toHaveLength(before);
  });
});
