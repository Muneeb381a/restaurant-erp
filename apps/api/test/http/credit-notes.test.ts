import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
let tikka: { id: string; variantId: string };
let naan: { id: string; variantId: string };
let receiptSim: SimPrinter;
let managerShift: string;
const M: Record<string, string> = {};
const api = (tok: string) => t.as(tok);
const run = () => processPrintJobs(t.ctx, new TcpTransport());
const audit = (action: string) =>
  t.kdb.selectFrom('audit_log').selectAll().where('action', '=', action).orderBy('id').execute();
let keySeq = 0;
const key = () => `cn-key-${Date.now()}-${++keySeq}`;

type Item = { id: string; variantId: string };
async function mkItem(name: string, price: number, station: string): Promise<Item> {
  const res = await api(owner).post('/items', { kind: 'STANDARD', name, stationId: station });
  for (const l of (await api(owner).get('/price-lists')).body.items as { id: string }[])
    await api(owner).put(`/variants/${res.body.variants[0].id}/prices/${l.id}`, {
      pricePaisa: price,
    });
  return { id: res.body.id, variantId: res.body.variants[0].id };
}
/** Orders, bills and settles; returns the bill view. Default: 2 × tikka (Rs 2,000) + 1 × naan (Rs 200), cash. */
async function paidBill(
  lines: [Item, number][] = [
    [tikka, 2],
    [naan, 1],
  ],
  tenders?: (total: number) => object[],
): Promise<Json> {
  const o = (await api(captain).post('/orders', { type: 'TAKEAWAY' })).body;
  for (const [item, qty] of lines)
    await api(captain).post(`/orders/${o.id}/items`, {
      itemId: item.id,
      variantId: item.variantId,
      qty,
    });
  await api(captain).post(`/orders/${o.id}/send`, {});
  const bill = (await api(cashier).post(`/orders/${o.id}/bill`)).body;
  const res = await api(cashier)
    .post(`/bills/${bill.id}/settle`, {
      tenders: tenders
        ? tenders(bill.totalPaisa)
        : [{ methodId: M.CASH, amountPaisa: bill.totalPaisa, tenderedPaisa: bill.totalPaisa }],
    })
    .set('Idempotency-Key', key());
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.bill;
}
const credit = (billId: string, body: object, tok = manager, k = key()) =>
  api(tok).post(`/bills/${billId}/credit-notes`, body).set('Idempotency-Key', k);
const preview = (billId: string, body: object) =>
  api(manager).post(`/bills/${billId}/credit-notes?dryRun=true`, body);
const refundable = async (billId: string): Promise<Json> =>
  (await api(manager).get(`/bills/${billId}/refundable`)).body;
const shiftReport = async (): Promise<Json> =>
  (await api(manager).get(`/shifts/${managerShift}/report`)).body;
const cashBody = (extra: object) => ({
  methodId: M.CASH,
  reason: 'Guest returned the dish',
  ...extra,
});

beforeAll(async () => {
  t = await startApp();
  owner = (await t.login('OWNER')).token;
  manager = (await t.login('MANAGER')).token;
  cashier = (await t.login('CASHIER')).token;
  captain = (await t.login('CAPTAIN')).token;

  for (const code of ['DINE_IN', 'TAKEAWAY', 'DELIVERY'])
    await api(owner).post('/price-lists', { code, name: code });
  const station = (await api(owner).post('/stations', { code: 'BBQ', name: 'BBQ' })).body.id;
  tikka = await mkItem('Tikka', 100000, station);
  naan = await mkItem('Naan', 20000, station);
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

  for (const [code, cls, extra] of [
    ['CASH', 'CASH_OTHER', { opens_drawer: true }],
    ['CARD', 'DIGITAL', { needs_reference: true }],
    ['KHATA', 'CASH_OTHER', {}],
  ] as const)
    M[code] = (
      await api(owner).post('/payment-methods', { code, name: code, tender_class: cls, ...extra })
    ).body.id;

  await api(cashier).post('/business-days/open', {});
  expect((await api(cashier).post('/shifts/open', { openingFloatPaisa: 100000 })).status).toBe(201);
  const sh = await api(manager).post('/shifts/open', { openingFloatPaisa: 5_000_000 });
  expect(sh.status, JSON.stringify(sh.body)).toBe(201);
  managerShift = sh.body.id;
}, 240_000);

afterAll(async () => {
  await receiptSim.unplug();
  await t.stop();
});

afterEach(async () => {
  await t.kdb
    .deleteFrom('settings')
    .where('key', 'in', ['billing.round_to_rupee', 'billing.service_charge_bps'])
    .execute();
});

describe('refunding part of a bill', () => {
  it('previews without writing, then returns one tikka in cash: drawer, slip, audit and bill view agree', async () => {
    const bill = await paidBill(); // 220000
    const lines = (await refundable(bill.id)).lines as Json[];
    const tikkaLine = lines.find((l) => l.description.includes('Tikka'))!;
    expect(tikkaLine).toMatchObject({ qty: 2, refundedQty: 0, remainingQty: 2 });

    const dry = await preview(bill.id, cashBody({ lines: [{ billLineId: tikkaLine.id, qty: 1 }] }));
    expect(dry.status, JSON.stringify(dry.body)).toBe(200);
    expect(dry.body).toMatchObject({ dryRun: true, totalPaisa: 100000, completesBill: false });
    expect((await refundable(bill.id)).creditNotes).toHaveLength(0); // nothing written

    const before = await shiftReport();
    await run();
    const jobsBefore = receiptSim.jobs.length;
    const res = await credit(bill.id, cashBody({ lines: [{ billLineId: tikkaLine.id, qty: 1 }] }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ cnNo: 1, totalPaisa: 100000, dryRun: false, replayed: false });

    const view = (await api(cashier).get(`/bills/${bill.id}`)).body;
    expect(view.refundedPaisa).toBe(100000);
    expect(view.creditNotes).toHaveLength(1);
    expect(view.status).toBe('SETTLED'); // the bill itself is history and unchanged
    expect(view.totalPaisa).toBe(220000);

    const after = await shiftReport();
    expect(after.expectedCashPaisa).toBe(before.expectedCashPaisa - 100000); // cash left the drawer
    expect(after.refunds).toEqual({ count: 1, totalPaisa: 100000 });
    expect(after.cash.refundsCashPaisa).toBe(100000);

    const log = (await audit('CREDIT_NOTE')).at(-1)!;
    expect(log.reason).toBe('Guest returned the dish');

    await run();
    expect(receiptSim.jobs.length).toBe(jobsBefore + 1);
    const slip = receiptSim.tickets().at(-1)!;
    expect(slip).toContain('CREDIT NOTE');
    expect(slip).toContain(`Against bill #${bill.billNo}`);
    expect(slip).toMatch(/TOTAL REFUND\s+1,000/);
    expect(receiptSim.jobs.at(-1)!.includes(Buffer.from([0x1b, 0x70]))).toBe(true); // cash refund opens the drawer
  });

  it('the rest can be returned with all:true; afterwards nothing is left, and too much is refused', async () => {
    const bill = await paidBill();
    const first = await credit(
      bill.id,
      cashBody({ lines: [{ billLineId: (await refundable(bill.id)).lines[0].id, qty: 1 }] }),
    );
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const lines = (await refundable(bill.id)).lines as Json[];
    const over = await credit(bill.id, cashBody({ lines: [{ billLineId: lines[0].id, qty: 2 }] }));
    expect(over.status).toBe(400);
    expect(over.body.reason).toBe('REFUND_QTY_EXCEEDS');

    const rest = await credit(bill.id, cashBody({ all: true }));
    expect(rest.status, JSON.stringify(rest.body)).toBe(201);
    expect(rest.body.completesBill).toBe(true);
    const view = (await api(manager).get(`/bills/${bill.id}`)).body;
    expect(view.refundedPaisa).toBe(view.totalPaisa); // exactly the bill, never more
    const again = await credit(bill.id, cashBody({ all: true }));
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('NOTHING_TO_REFUND');
  });

  it('discount, service charge and round-off are shared fairly and the parts add up to the bill', async () => {
    await api(owner).put('/settings/billing.service_charge_bps', { value: 500 });
    await api(owner).put('/settings/billing.round_to_rupee', { value: true });
    const o = (await api(captain).post('/orders', { type: 'TAKEAWAY' })).body;
    for (const [item, qty] of [
      [tikka, 1],
      [naan, 3],
    ] as [Item, number][])
      await api(captain).post(`/orders/${o.id}/items`, {
        itemId: item.id,
        variantId: item.variantId,
        qty,
      });
    await api(captain).post(`/orders/${o.id}/send`, {});
    let bill = (await api(cashier).post(`/orders/${o.id}/bill`)).body;
    bill = (
      await api(manager).post(`/bills/${bill.id}/discount`, {
        percentBps: 1000,
        reason: 'Regular guest',
      })
    ).body;
    const paid = await api(cashier)
      .post(`/bills/${bill.id}/settle`, {
        tenders: [
          { methodId: M.CASH, amountPaisa: bill.totalPaisa, tenderedPaisa: bill.totalPaisa },
        ],
      })
      .set('Idempotency-Key', key());
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);

    const ls = (await refundable(bill.id)).lines as Json[];
    const naanLine = ls.find((l) => l.description.includes('Naan'))!;
    const one = await credit(bill.id, cashBody({ lines: [{ billLineId: naanLine.id, qty: 1 }] }));
    expect(one.status, JSON.stringify(one.body)).toBe(201);
    // the guest paid less than the menu price for that naan (10% off, 5% service on the rest)
    expect(one.body.totalPaisa).toBeLessThan(20000 * 1.05);
    expect(one.body.totalPaisa).toBeGreaterThan(0);
    const rest = await credit(bill.id, cashBody({ all: true }));
    expect(rest.status, JSON.stringify(rest.body)).toBe(201);
    const view = (await api(manager).get(`/bills/${bill.id}`)).body;
    expect(view.refundedPaisa).toBe(bill.totalPaisa);
  });
});

describe('rules', () => {
  it('needs bill.refund, a reason, a settled bill, an open shift and exactly one of all/lines', async () => {
    const bill = await paidBill();
    expect((await credit(bill.id, cashBody({ all: true }), cashier)).status).toBe(403);
    expect(
      (await api(manager).post(`/bills/${bill.id}/credit-notes`, cashBody({ all: true }))).status,
    ).toBe(400); // no key
    expect((await credit(bill.id, { methodId: M.CASH, all: true })).status).toBe(400); // no reason
    expect((await credit(bill.id, cashBody({}))).status).toBe(400);
    expect((await credit(bill.id, cashBody({ all: true, lines: [] }))).status).toBe(400);
    expect(
      (
        await credit(
          bill.id,
          cashBody({ lines: [{ billLineId: '00000000-0000-4000-8000-000000000000', qty: 1 }] }),
        )
      ).body.reason,
    ).toBe('REFUND_UNKNOWN_LINE');

    // the owner has no open shift: the money cannot come out of anybody's drawer
    const noShift = await credit(bill.id, cashBody({ all: true }), owner);
    expect(noShift.status).toBe(409);
    expect(noShift.body.code).toBe('SHIFT_NOT_OPEN');

    // an unpaid (pre-billed) bill cannot be credited
    const o = (await api(captain).post('/orders', { type: 'TAKEAWAY' })).body;
    await api(captain).post(`/orders/${o.id}/items`, {
      itemId: naan.id,
      variantId: naan.variantId,
    });
    await api(captain).post(`/orders/${o.id}/send`, {});
    const unpaid = (await api(cashier).post(`/orders/${o.id}/bill`)).body;
    expect((await credit(unpaid.id, cashBody({ all: true }))).body.code).toBe('BILL_NOT_PAYABLE');
  });

  it('a card refund needs a reference and does not touch the drawer', async () => {
    const bill = await paidBill([[naan, 1]], (total) => [
      { methodId: M.CARD, amountPaisa: total, reference: 'RRN-1' },
    ]);
    const before = await shiftReport();
    expect(
      (await credit(bill.id, { methodId: M.CARD, reason: 'Wrong dish', all: true })).status,
    ).toBe(400);
    const ok = await credit(bill.id, {
      methodId: M.CARD,
      reason: 'Wrong dish',
      all: true,
      reference: 'RRN-REFUND-1',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const after = await shiftReport();
    expect(after.expectedCashPaisa).toBe(before.expectedCashPaisa);
    expect(after.refunds.totalPaisa).toBe(before.refunds.totalPaisa + 20000);
    expect(after.cash.refundsCashPaisa).toBe(before.cash.refundsCashPaisa);
  });

  it('is idempotent: the same key replays, and a key cannot be reused for another bill', async () => {
    const a = await paidBill([[naan, 2]]);
    const b = await paidBill([[naan, 1]]);
    const k = key();
    const first = await credit(a.id, cashBody({ all: true }), manager, k);
    const again = await credit(a.id, cashBody({ all: true }), manager, k);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, cnNo: first.body.cnNo, totalPaisa: 40000 });
    expect((await refundable(a.id)).creditNotes).toHaveLength(1);
    expect((await credit(b.id, cashBody({ all: true }), manager, k)).status).toBe(409);
  });

  it('two simultaneous returns of the same item: exactly one goes through', async () => {
    const bill = await paidBill([[naan, 1]]);
    const results = await Promise.all([
      credit(bill.id, cashBody({ all: true })),
      credit(bill.id, cashBody({ all: true })),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const view = (await api(manager).get(`/bills/${bill.id}`)).body;
    expect(view.refundedPaisa).toBe(20000);
  });

  it('another branch cannot see or credit the bill', async () => {
    const bill = await paidBill([[naan, 1]]);
    const other = t.as((await t.login('MANAGER2')).token, t.otherBranchId);
    expect((await other.get(`/bills/${bill.id}/refundable`)).status).toBe(404);
    expect(
      (await other.post(`/bills/${bill.id}/credit-notes?dryRun=true`, cashBody({ all: true })))
        .status,
    ).toBe(404);
  });
});

describe('refund to khata', () => {
  it('lowers the customer’s balance, up to what the bill charged to khata', async () => {
    const acct = (
      await api(manager).post('/khata/accounts', {
        name: 'Haji',
        phone: '0300-0000001',
        creditLimitPaisa: 1_000_000,
      })
    ).body.id;
    // Rs 2,200 bill: Rs 1,000 cash + Rs 1,200 khata
    const bill = await paidBill(
      [
        [tikka, 2],
        [naan, 1],
      ],
      (total) => [
        { methodId: M.CASH, amountPaisa: 100000, tenderedPaisa: 100000 },
        { methodId: M.KHATA, amountPaisa: total - 100000, khataAccountId: acct },
      ],
    );
    expect((await api(manager).get(`/khata/accounts/${acct}`)).body.balancePaisa).toBe(120000);

    const refundAll = await credit(bill.id, {
      methodId: M.KHATA,
      reason: 'Wrong order',
      all: true,
    });
    expect(refundAll.status).toBe(409);
    expect(refundAll.body).toMatchObject({ code: 'KHATA_REFUND_EXCEEDS', maxPaisa: 120000 });

    const lines = (await refundable(bill.id)).lines as Json[];
    const naanLine = lines.find((l) => l.description.includes('Naan'))!;
    const ok = await credit(bill.id, {
      methodId: M.KHATA,
      reason: 'Naan was cold',
      lines: [{ billLineId: naanLine.id, qty: 1 }],
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const ledger = (await api(manager).get(`/khata/accounts/${acct}`)).body;
    expect(ledger.balancePaisa).toBe(100000);
    expect(ledger.entries[0]).toMatchObject({ kind: 'REFUND', amountPaisa: 20000 });
    expect((await audit('KHATA_REFUND')).length).toBe(1);

    // a bill that never touched khata cannot be refunded to it
    const plain = await paidBill([[naan, 1]]);
    const no = await credit(plain.id, { methodId: M.KHATA, reason: 'x y z', all: true });
    expect(no.status).toBe(409);
    expect(no.body.code).toBe('KHATA_NOT_ON_BILL');
  });
});

describe('look-up and reports', () => {
  it('finds a bill by number, and the day report nets the refunds', async () => {
    const bill = await paidBill([[naan, 1]]);
    const found = (await api(cashier).get(`/bills?billNo=${bill.billNo}`)).body.items as Json[];
    expect(found.map((b) => b.id)).toContain(bill.id);
    // the list also says how it was paid and whether anything was returned
    const row = found.find((b) => b.id === bill.id)!;
    expect(row.methods.length).toBeGreaterThan(0);
    expect(typeof row.refunded).toBe('boolean');
    expect(row).toHaveProperty('orderNo');
    expect((await api(captain).get('/bills')).status).toBe(403);

    const day = (await api(manager).get('/business-days/current')).body.day;
    const rep = (await api(owner).get(`/business-days/${day.id}/report`)).body;
    expect(rep.refunds.count).toBeGreaterThan(0);
    expect(rep.netAfterRefundsPaisa).toBe(rep.sales.totalPaisa - rep.refunds.totalPaisa);
  });
});

describe('the bills list by the day the guest was billed', () => {
  it('finds a bill by its own date even when the business day is older; filters by status and token', async () => {
    const bill = await paidBill([[naan, 1]]);
    const get = async (qs: string): Promise<Json[]> =>
      (await api(cashier).get(`/bills?${qs}`)).body.items as Json[];
    const ids = async (qs: string): Promise<string[]> => (await get(qs)).map((b) => b.id);
    const row = (await get(`billNo=${bill.billNo}`))[0]!;
    expect(row.billedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(row).toHaveProperty('createdAt');
    const next = new Date(`${row.billedOn}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const after = next.toISOString().slice(0, 10);
    // the bill's own date: inside a window that covers it, outside one that does not
    expect(await ids(`from=${row.billedOn}&to=${row.billedOn}`)).toContain(bill.id);
    expect(await ids(`from=${after}`)).not.toContain(bill.id);
    expect(await ids(`to=2000-01-02`)).not.toContain(bill.id);
    // status filter and token search
    expect(await ids(`status=SETTLED&billNo=${bill.billNo}`)).toContain(bill.id);
    expect(await ids(`status=PRE_BILLED&billNo=${bill.billNo}`)).not.toContain(bill.id);
    expect(await ids(`search=${row.orderNo}`)).toContain(bill.id);
    expect((await api(cashier).get('/bills?from=nope')).status).toBe(400);
  });
});

describe('the daily sales report', () => {
  it('lists every bill of the day with totals that match the bills, and downloads as a PDF', async () => {
    const bill = await paidBill([[naan, 2]]);
    const row = ((await api(cashier).get(`/bills?billNo=${bill.billNo}`)).body.items as Json[])[0]!;
    const rep = (await api(cashier).get(`/reports/daily-sales?date=${row.billedOn}`)).body;
    expect(rep.date).toBe(row.billedOn);
    const mine = rep.bills.find((b: Json) => b.billNo === bill.billNo);
    expect(mine).toMatchObject({ status: 'SETTLED', totalPaisa: bill.totalPaisa });
    expect(mine.methods.toLowerCase()).toContain('cash');
    // the headline equals the sum of the paid bills listed, and the parts equal the whole
    const paid = rep.bills.filter((b: Json) => b.status === 'SETTLED');
    const sum = (xs: Json[], k: string): number => xs.reduce((n, x) => n + x[k], 0);
    expect(rep.sales.paidBills).toBe(paid.length);
    expect(rep.sales.collectedPaisa).toBe(sum(paid, 'totalPaisa'));
    expect(sum(rep.sales.byMethod, 'amountPaisa')).toBe(rep.sales.collectedPaisa);
    expect(sum(rep.sales.byType, 'amountPaisa')).toBe(rep.sales.collectedPaisa);
    expect(sum(rep.sales.byHour, 'amountPaisa')).toBe(rep.sales.collectedPaisa);
    expect(rep.sales.netAfterRefundsPaisa).toBe(rep.sales.collectedPaisa - rep.sales.refundsPaisa);

    const pdf = await api(cashier)
      .get(`/reports/daily-sales.pdf?date=${row.billedOn}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    if (process.env.SAVE_PDF)
      (await import('node:fs')).writeFileSync(process.env.SAVE_PDF, pdf.body as Buffer);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.headers['content-disposition']).toContain(`daily-sales-${row.billedOn}.pdf`);
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect((pdf.body as Buffer).length).toBeGreaterThan(2000);

    // a day with no bills still gives a valid, empty report
    const empty = (await api(cashier).get('/reports/daily-sales?date=2000-01-01')).body;
    expect(empty.bills).toEqual([]);
    expect(empty.sales.collectedPaisa).toBe(0);
    // only people who may view reports; a bad date is refused
    expect((await api(captain).get(`/reports/daily-sales?date=${row.billedOn}`)).status).toBe(403);
    expect((await api(cashier).get('/reports/daily-sales.pdf?date=yesterday')).status).toBe(400);
  });
});

describe('cash refunds are limited to what the drawer holds', () => {
  it('refuses a cash refund bigger than the cash in the refunding cashier’s drawer', async () => {
    const bill = await paidBill([[tikka, 2]]); // Rs 2,000
    const report = await shiftReport();
    // take almost everything out of the drawer
    const drop = report.expectedCashPaisa - 50000;
    expect(
      (
        await api(manager)
          .post('/cash-movements', { kind: 'DROP', amountPaisa: drop, reason: 'To safe' })
          .set('Idempotency-Key', key())
      ).status,
    ).toBe(201);
    const res = await credit(bill.id, cashBody({ all: true }));
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('DRAWER_INSUFFICIENT_CASH');
    // a card refund of the same amount is not limited by the drawer
    const card = await credit(bill.id, {
      methodId: M.CARD,
      reason: 'Refund to card',
      all: true,
      reference: 'RRN-9',
    });
    expect(card.status, JSON.stringify(card.body)).toBe(201);
  });
});
