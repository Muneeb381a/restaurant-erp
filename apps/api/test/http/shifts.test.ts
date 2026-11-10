import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
let shiftId: string;
const M: Record<string, string> = {};
const api = (tok: string) => t.as(tok);
const run = () => processPrintJobs(t.ctx, new TcpTransport());
const audit = (action: string) =>
  t.kdb.selectFrom('audit_log').selectAll().where('action', '=', action).orderBy('id').execute();
let keySeq = 0;
const key = () => `shift-key-${Date.now()}-${++keySeq}`;

async function sale(tenders: (total: number) => object[], tok = cashier): Promise<Json> {
  const o = (await api(captain).post('/orders', { type: 'TAKEAWAY' })).body;
  await api(captain).post(`/orders/${o.id}/items`, { itemId: item.id, variantId: item.variantId });
  await api(captain).post(`/orders/${o.id}/send`, {});
  const bill = (await api(cashier).post(`/orders/${o.id}/bill`)).body;
  const res = await api(tok)
    .post(`/bills/${bill.id}/settle`, { tenders: tenders(bill.totalPaisa) })
    .set('Idempotency-Key', key());
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}
/** Walks an order away cleanly: void its sent lines, then cancel it. */
async function abandon(orderId: string): Promise<void> {
  const o = (await api(manager).get(`/orders/${orderId}`)).body as Json;
  for (const line of o.items.filter((l: Json) => l.status !== 'VOID'))
    await api(manager).post(`/orders/${orderId}/items/${line.id}/void`, { reason: 'cleanup' });
  const fresh = (await api(manager).get(`/orders/${orderId}`)).body as Json;
  const res = await api(manager)
    .post(`/orders/${orderId}/cancel`, { reason: 'cleanup' })
    .set('If-Match', String(fresh.version));
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
}
const cashTender = (total: number) => [
  { methodId: M.CASH, amountPaisa: total, tenderedPaisa: total + 50000 },
];
const cardTender = (total: number) => [
  { methodId: M.CARD, amountPaisa: total, reference: 'RRN-1' },
];
const move = (body: object, k = key(), tok = cashier) =>
  api(tok).post('/cash-movements', body).set('Idempotency-Key', k);
const report = async (tok = manager, id = shiftId): Promise<Json> =>
  (await api(tok).get(`/shifts/${id}/report`)).body;

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

  for (const [code, cls, extra] of [
    ['CASH', 'CASH_OTHER', { opens_drawer: true }],
    ['CARD', 'DIGITAL', { needs_reference: true }],
  ] as const) {
    M[code] = (
      await api(owner).post('/payment-methods', { code, name: code, tender_class: cls, ...extra })
    ).body.id;
  }
  await api(cashier).post('/business-days/open', {});
  const sh = await api(cashier).post('/shifts/open', { openingFloatPaisa: 500000 });
  expect(sh.status, JSON.stringify(sh.body)).toBe(201);
  shiftId = sh.body.id;
}, 240_000);

afterAll(async () => {
  await receiptSim.unplug();
  await t.stop();
});

describe('cash movements', () => {
  it('paid-out, cash-in and drops change the expected cash; reasons are mandatory; replays are safe', async () => {
    await sale(cashTender); // +100000 cash sale
    await sale(cardTender); // card: not in the drawer
    expect((await report()).expectedCashPaisa).toBe(600000);

    const noReason = await move({ kind: 'PAID_OUT', amountPaisa: 5000 });
    expect(noReason.status).toBe(400);

    const k = key();
    const out = await move({ kind: 'PAID_OUT', amountPaisa: 5000, reason: 'Ice' }, k);
    expect(out.status, JSON.stringify(out.body)).toBe(201);
    const again = await move({ kind: 'PAID_OUT', amountPaisa: 5000, reason: 'Ice' }, k);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(
      (await move({ kind: 'CASH_IN', amountPaisa: 20000, reason: 'Float top-up' })).status,
    ).toBe(201);
    expect((await move({ kind: 'DROP', amountPaisa: 100000, reason: 'To safe' })).status).toBe(201);
    // 500000 + 100000 − 5000 + 20000 − 100000
    expect((await report()).expectedCashPaisa).toBe(515000);
    expect((await report()).cash).toMatchObject({
      paidOutPaisa: 5000,
      cashInPaisa: 20000,
      dropsPaisa: 100000,
    });
    expect((await audit('CASH_PAID_OUT')).length).toBe(1);
  });

  it('refuses to take out more than the drawer holds, and needs the right permission and a key', async () => {
    const over = await move({ kind: 'PAID_OUT', amountPaisa: 99_000_000, reason: 'Too much' });
    expect(over.status).toBe(400);
    expect(over.body.reason).toBe('DRAWER_INSUFFICIENT_CASH');
    expect(
      (await move({ kind: 'PAID_OUT', amountPaisa: 100, reason: 'Nope' }, key(), captain)).status,
    ).toBe(403);
    const noKey = await api(cashier).post('/cash-movements', {
      kind: 'PAID_OUT',
      amountPaisa: 100,
      reason: 'Nope',
    });
    expect(noKey.status).toBe(400);
    expect((await move({ kind: 'CASH_IN', amountPaisa: 0, reason: 'Zero' })).status).toBe(400);
  });

  it('no-sale opens the drawer: recorded, audited and printed as a drawer pulse', async () => {
    await run();
    const before = receiptSim.jobs.length;
    const res = await api(cashier)
      .post('/drawer/open', { reason: 'Change for a customer' })
      .set('Idempotency-Key', key());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await run();
    expect(receiptSim.jobs.length).toBe(before + 1);
    expect(receiptSim.jobs.at(-1)!.includes(Buffer.from([0x1b, 0x70]))).toBe(true);
    expect((await report()).cash.noSaleCount).toBe(1);
    expect((await audit('DRAWER_NO_SALE')).length).toBe(1);
  });
});

describe('closing a shift', () => {
  it('counts blind: the cashier does not see the expected cash while the shift is open', async () => {
    const mine = await report(cashier);
    expect(mine.expectedCashPaisa).toBeNull();
    expect(mine.variancePaisa).toBeNull();
    expect(mine.sales.billCount).toBe(2);
    expect((await report(manager)).expectedCashPaisa).toBe(515000);
    expect((await api(captain).get(`/shifts/${shiftId}/report`)).status).toBe(403);
  });

  it('a variance needs a note; the close is audited and the slip prints', async () => {
    const short = await api(cashier).post(`/shifts/${shiftId}/close`, { countedCashPaisa: 514000 });
    expect(short.status).toBe(400);
    expect(short.body.code).toBe('VARIANCE_NOTE_REQUIRED');
    expect(short.body.variancePaisa).toBe(-1000);

    await run();
    const before = receiptSim.jobs.length;
    const res = await api(cashier).post(`/shifts/${shiftId}/close`, {
      countedCashPaisa: 514000,
      notes: 'Rs 10 note missing',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.report).toMatchObject({
      expectedCashPaisa: 515000,
      countedCashPaisa: 514000,
      variancePaisa: -1000,
      shift: { status: 'CLOSED' },
      sales: { billCount: 2, totalPaisa: 200000 },
    });
    expect(res.body.report.byMethod.map((m: Json) => [m.code, m.amountPaisa])).toEqual([
      ['CARD', 100000],
      ['CASH', 100000],
    ]);
    const log = (await audit('SHIFT_CLOSE'))[0]!;
    expect(log.reason).toBe('Rs 10 note missing');

    await run();
    expect(receiptSim.jobs.length).toBe(before + 1);
    const slip = receiptSim.tickets().at(-1)!;
    expect(slip).toContain('SHIFT CLOSE');
    expect(slip).toMatch(/Expected cash\s+5,150/);
    expect(slip).toMatch(/Variance|SHORT/);
  });

  it('a closed shift takes no more money and cannot be closed twice', async () => {
    expect(
      (
        await api(cashier).post(`/shifts/${shiftId}/close`, {
          countedCashPaisa: 514000,
          notes: 'again',
        })
      ).status,
    ).toBe(409);
    const o = (await api(captain).post('/orders', { type: 'TAKEAWAY' })).body;
    await api(captain).post(`/orders/${o.id}/items`, {
      itemId: item.id,
      variantId: item.variantId,
    });
    await api(captain).post(`/orders/${o.id}/send`, {});
    const bill = (await api(cashier).post(`/orders/${o.id}/bill`)).body;
    const pay = await api(cashier)
      .post(`/bills/${bill.id}/settle`, { tenders: cashTender(bill.totalPaisa) })
      .set('Idempotency-Key', key());
    expect(pay.status).toBe(409);
    expect(pay.body.code).toBe('SHIFT_NOT_OPEN');
    expect((await move({ kind: 'CASH_IN', amountPaisa: 100, reason: 'late' })).status).toBe(409);
    await api(manager).post(`/bills/${bill.id}/void`, { reason: 'cleanup' }); // reopen the order for the day-close tests
    await abandon(o.id);
  });
});

describe('reopening a shift', () => {
  it('needs shift.reopen and a reason, is audited, and the shift can take money again', async () => {
    expect(
      (await api(cashier).post(`/shifts/${shiftId}/reopen`, { reason: 'Forgot a payment' })).status,
    ).toBe(403);
    expect((await api(manager).post(`/shifts/${shiftId}/reopen`, {})).status).toBe(400);
    const res = await api(manager).post(`/shifts/${shiftId}/reopen`, {
      reason: 'Forgot a payment',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.shift.status).toBe('OPEN');
    expect(res.body.countedCashPaisa).toBeNull();
    const log = (await audit('SHIFT_REOPEN'))[0]!;
    expect(log.reason).toBe('Forgot a payment');
    expect(JSON.stringify(log.before)).toContain('514000'); // the old count is kept in the audit trail

    await sale(cashTender); // +100000
    expect((await report()).expectedCashPaisa).toBe(615000);
  });

  it('refuses when the cashier has opened another shift meanwhile', async () => {
    const closed = await api(cashier).post(`/shifts/${shiftId}/close`, {
      countedCashPaisa: 615000,
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect((await api(cashier).post('/shifts/open', { openingFloatPaisa: 1000 })).status).toBe(201);
    const res = await api(manager).post(`/shifts/${shiftId}/reopen`, { reason: 'Second thoughts' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SHIFT_ALREADY_OPEN');
  });

  it('a manager can close somebody else’s shift; a cashier cannot', async () => {
    const mine = (await api(cashier).get('/shifts/current')).body.shift;
    expect(
      (await api(manager).post(`/shifts/${mine.id}/close`, { countedCashPaisa: 1000 })).status,
    ).toBe(200);
  });
});

describe('closing the business day', () => {
  it('is refused while a shift or an order is still open, and lists what is blocking', async () => {
    const sh = await api(cashier).post('/shifts/open', { openingFloatPaisa: 0 });
    expect(sh.status).toBe(201);
    const blockedByShift = await api(manager).post('/business-days/close');
    expect(blockedByShift.status).toBe(409);
    expect(blockedByShift.body.code).toBe('SHIFTS_STILL_OPEN');
    expect(blockedByShift.body.cashiers).toEqual(['CASHIER']);
    await api(cashier).post(`/shifts/${sh.body.id}/close`, { countedCashPaisa: 0 });

    const o = (await api(captain).post('/orders', { type: 'TAKEAWAY' })).body;
    const blockedByOrder = await api(manager).post('/business-days/close');
    expect(blockedByOrder.status).toBe(409);
    expect(blockedByOrder.body.code).toBe('ORDERS_STILL_OPEN');
    expect(blockedByOrder.body.orders.map((x: Json) => x.orderNo)).toContain(o.orderNo);
    await abandon(o.id);
  });

  it('needs day.close; closes, prints the Z-report, and the day can never be reopened', async () => {
    expect((await api(cashier).post('/business-days/close')).status).toBe(403);
    await run();
    const before = receiptSim.jobs.length;
    const res = await api(manager).post('/business-days/close');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const z = res.body.report;
    expect(z.day.status).toBe('CLOSED');
    expect(z.sales).toMatchObject({ billCount: 3, totalPaisa: 300000, subtotalPaisa: 300000 });
    expect(z.byMethod.map((m: Json) => [m.code, m.amountPaisa])).toEqual([
      ['CARD', 100000],
      ['CASH', 200000],
    ]);
    expect(z.byOrderType).toEqual([{ type: 'TAKEAWAY', count: 3, totalPaisa: 300000 }]);
    expect(z.cancelledOrders).toBeGreaterThanOrEqual(1);
    expect(z.voidedBills).toBeGreaterThanOrEqual(1);
    expect(z.shifts.length).toBe(3);
    expect(z.varianceTotalPaisa).toBe(
      z.shifts.reduce((n: number, s: Json) => n + (s.variancePaisa ?? 0), 0),
    );
    expect((await audit('DAY_CLOSE')).length).toBe(1);

    await run();
    expect(receiptSim.jobs.length).toBe(before + 1);
    expect(receiptSim.tickets().at(-1)).toContain('Z-REPORT');

    // nothing can start in a closed day
    expect((await api(captain).post('/orders', { type: 'TAKEAWAY' })).body.code).toBe(
      'DAY_NOT_OPEN',
    );
    expect((await api(cashier).post('/shifts/open', { openingFloatPaisa: 0 })).body.code).toBe(
      'DAY_NOT_OPEN',
    );
    expect((await api(manager).post('/business-days/close')).body.code).toBe('DAY_NOT_OPEN');
  });

  it('the Z-report can be read by finance roles and reprinted with a reason (REPRINT #n)', async () => {
    const days = (await api(manager).get('/business-days')).body.items as Json[];
    expect(days[0].status).toBe('CLOSED');
    const dayId = days[0].id as string;
    expect((await api(cashier).get(`/business-days/${dayId}/report`)).status).toBe(403);
    const rep = await api(manager).get(`/business-days/${dayId}/report`);
    expect(rep.body.sales.totalPaisa).toBe(300000);

    expect((await api(manager).post('/reports/reprint', { dayId, reason: '' })).status).toBe(400);
    expect(
      (await api(cashier).post('/reports/reprint', { dayId, reason: 'copy for the owner' })).status,
    ).toBe(403);
    const res = await api(manager).post('/reports/reprint', {
      dayId,
      reason: 'copy for the owner',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.copy).toBe(1);
    await run();
    expect(receiptSim.tickets().at(-1)).toContain('REPRINT #1');
    expect((await audit('REPORT_REPRINT')).length).toBe(1);

    expect(
      (await api(manager).post('/reports/reprint', { shiftId, reason: 'slip copy' })).status,
    ).toBe(201);
    expect(
      (await api(manager).post('/reports/reprint', { dayId, shiftId, reason: 'both?' })).status,
    ).toBe(400);
  });
});
