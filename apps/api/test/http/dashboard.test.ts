import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from './app-harness';
import { SimPrinter } from './sim-printer';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let t: TestApp;
let owner: string;
let manager: string;
let cashier: string;
let captain: string;
let accountant: string;
let tikka: { id: string; variantId: string };
let cashId = '';
const api = (tok: string) => t.as(tok);
let keySeq = 0;
const key = () => `dash-key-${Date.now()}-${++keySeq}`;
let today = '';
const day = (n: number): string =>
  new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  t = await startApp();
  owner = (await t.login('OWNER')).token;
  manager = (await t.login('MANAGER')).token;
  cashier = (await t.login('CASHIER')).token;
  captain = (await t.login('CAPTAIN')).token;
  accountant = (await t.login('ACCOUNTANT')).token;
  const lists: { id: string }[] = [];
  for (const code of ['DINE_IN', 'TAKEAWAY', 'DELIVERY'])
    lists.push((await api(owner).post('/price-lists', { code, name: code })).body);
  const station = (await api(owner).post('/stations', { code: 'BBQ', name: 'BBQ' })).body.id;
  const res = await api(owner).post('/items', {
    kind: 'STANDARD',
    name: 'Tikka',
    stationId: station,
  });
  tikka = { id: res.body.id, variantId: res.body.variants[0].id };
  for (const l of lists)
    await api(owner).put(`/variants/${tikka.variantId}/prices/${l.id}`, { pricePaisa: 100000 });
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
  cashId = (
    await api(owner).post('/payment-methods', {
      code: 'CASH',
      name: 'Cash',
      tender_class: 'CASH_OTHER',
      opens_drawer: true,
    })
  ).body.id;
  today = (await api(cashier).post('/business-days/open', {})).body.businessDate;
  await api(cashier).post('/shifts/open', { openingFloatPaisa: 500000 });
}, 240_000);

afterAll(async () => {
  await t.stop();
});

async function sell(qty: number): Promise<Json> {
  const o = (await api(captain).post('/orders', { type: 'TAKEAWAY' })).body;
  await api(captain).post(`/orders/${o.id}/items`, {
    itemId: tikka.id,
    variantId: tikka.variantId,
    qty,
  });
  await api(captain).post(`/orders/${o.id}/send`, {});
  const bill = (await api(cashier).post(`/orders/${o.id}/bill`)).body;
  return { order: o, bill };
}
const settle = (bill: Json, amount = bill.totalPaisa) =>
  api(cashier)
    .post(`/bills/${bill.id}/settle`, {
      tenders: [{ methodId: cashId, amountPaisa: amount, tenderedPaisa: amount }],
    })
    .set('Idempotency-Key', key());
const get = (tok: string, from = today, to = today) =>
  api(tok).get(`/reports/dashboard?from=${from}&to=${to}`);

describe('GET /reports/dashboard', () => {
  it('is empty and zero-filled before any sale', async () => {
    const r = await get(owner, day(-2), today);
    expect(r.status).toBe(200);
    expect(r.body.range.days).toBe(3);
    expect(r.body.daily).toHaveLength(3);
    expect(r.body.hourly).toHaveLength(24);
    expect(r.body.current).toMatchObject({
      bills: 0,
      netSalesPaisa: 0,
      netProfitPaisa: 0,
      avgBillPaisa: 0,
      foodCostBps: null,
    });
  });

  it('adds up sales, discount, payments, expenses and profit', async () => {
    const a = await sell(2); // Rs 2,000
    expect((await settle(a.bill)).status).toBe(201);
    const b = await sell(1); // Rs 1,000, 10 % discount = Rs 900
    const disc = await api(manager).post(`/bills/${b.bill.id}/discount`, {
      percentBps: 1000,
      reason: 'Regular guest',
    });
    expect(disc.status, JSON.stringify(disc.body)).toBe(200);
    expect((await settle(disc.body)).status).toBe(201);
    const exp = await api(owner)
      .post('/expenses', { category: 'GAS', amountPaisa: 50000, paidFrom: 'OWNER_CASH' })
      .set('Idempotency-Key', key());
    expect(exp.status, JSON.stringify(exp.body)).toBe(201);

    const r = await get(owner);
    expect(r.status).toBe(200);
    const c = r.body.current;
    expect(c.bills).toBe(2);
    expect(c.grossSalesPaisa).toBe(300000);
    expect(c.discountPaisa).toBe(10000);
    expect(c.netSalesPaisa).toBe(290000);
    expect(c.avgBillPaisa).toBe(145000);
    expect(c.expensesPaisa).toBe(50000);
    expect(c.netProfitPaisa).toBe(290000 - c.costOfFoodPaisa - 50000);
    expect(c.uncostedLines).toBe(2); // no recipe: the dashboard says profit is overstated
    expect(r.body.payments).toEqual([
      expect.objectContaining({ code: 'CASH', amountPaisa: 290000, isCash: true, shareBps: 10000 }),
    ]);
    expect(r.body.expensesByCategory).toEqual([{ category: 'GAS', totalPaisa: 50000 }]);
    expect(r.body.orderTypes).toEqual([
      expect.objectContaining({ type: 'TAKEAWAY', bills: 2, salesPaisa: 290000 }),
    ]);
    expect(r.body.topItems[0]).toMatchObject({ name: 'Tikka', qty: 3, revenuePaisa: 300000 });
    expect(r.body.controls).toMatchObject({ discountBills: 1, discountPaisa: 10000 });
    expect(r.body.daily.at(-1)).toMatchObject({
      salesPaisa: 290000,
      bills: 2,
      expensesPaisa: 50000,
    });
    expect(r.body.hourly.reduce((n: number, h: Json) => n + h.salesPaisa, 0)).toBe(290000);
  });

  it('reports the previous period of the same length for comparison', async () => {
    const x = await sell(1);
    expect((await settle(x.bill)).status).toBe(201);
    const r = await get(owner, today, today);
    expect(r.body.previousRange.to).toBe(day(-1));
    expect(r.body.previous.bills).toBe(0);
    expect(r.body.current.bills).toBe(3);
  });

  it('times the kitchen: wait, cook and total, ignoring forgotten tickets', async () => {
    const kots = await t.kdb.selectFrom('kots').select('id').orderBy('kot_no').execute();
    expect(kots.length).toBeGreaterThanOrEqual(3);
    const base = Date.now() - 3 * 3_600_000;
    const at = (min: number): Date => new Date(base + min * 60_000);
    // two normal tickets: waited 4 min, cooked 10 min
    for (const k of kots.slice(0, 2))
      await t.kdb
        .updateTable('kots')
        .set({ created_at: at(0), started_at: at(4), ready_at: at(14), status: 'READY' })
        .where('id', '=', k.id)
        .execute();
    // one ticket marked ready five hours later: a forgotten tap, left out of the times
    await t.kdb
      .updateTable('kots')
      .set({ created_at: at(0), started_at: at(1), ready_at: at(300), status: 'READY' })
      .where('id', '=', kots[2]!.id)
      .execute();
    const r = await get(owner);
    expect(r.status).toBe(200);
    const k = r.body.kitchen;
    expect(k).toMatchObject({
      ticketsSent: kots.length,
      timedTickets: 2,
      ignoredTickets: 1,
      avgWaitSec: 240,
      avgCookSec: 600,
      avgTotalSec: 840,
      medianTotalSec: 840,
      within15MinBps: 10000,
      over25MinBps: 0,
    });
    expect(k.untimedTickets).toBe(kots.length - 3);
    expect(k.stations).toEqual([
      expect.objectContaining({ station: 'BBQ', tickets: 2, avgTotalSec: 840 }),
    ]);
    expect(k.hours.reduce((n: number, h: Json) => n + h.tickets, 0)).toBe(2);
  });

  it('writes the day as a short message the owner can forward', async () => {
    const r = await api(owner).get(`/reports/day-summary?date=${today}`);
    expect(r.status).toBe(200);
    expect(r.body.date).toBe(today);
    expect(r.body.text).toContain('*Sales* Rs ');
    expect(r.body.text).toContain('Paid by: Cash Rs ');
    expect(r.body.text).toContain('Best sellers: Tikka');
    expect(r.body.text).toContain('Kitchen: typical');
    // the figures in the message are the dashboard's, not recomputed
    const d = (await get(owner)).body.current;
    expect(r.body.text).toContain(
      `*Net profit: Rs ${(d.netProfitPaisa / 100).toLocaleString('en-US')}`,
    );
    const ur = await api(owner).get(`/reports/day-summary?date=${today}&lang=ur`);
    expect(ur.body.text).toContain('خالص منافع');
    // an empty day says so
    const empty = await api(owner).get(`/reports/day-summary?date=${day(-3)}`);
    expect(empty.body.text).toContain('No sales today.');
    expect((await api(owner).get('/reports/day-summary')).status).toBe(400);
    expect((await api(captain).get(`/reports/day-summary?date=${today}`)).status).toBe(403);
  });

  it('lists the most ordered dishes for the "Popular" row', async () => {
    const r = await api(captain).get('/menu/popular');
    expect(r.status).toBe(200);
    expect(r.body.items[0]).toMatchObject({ itemId: tikka.id });
    expect(r.body.items[0].qty).toBeGreaterThanOrEqual(3);
    expect((await api(captain).get('/menu/popular?days=0')).status).toBe(400);
    expect((await api(captain).get('/menu/popular?limit=3')).body.items.length).toBeLessThanOrEqual(
      3,
    );
  });

  it('says what is still missing before selling, for the owner only', async () => {
    const r = await api(owner).get('/setup/status');
    expect(r.status).toBe(200);
    const step = (k: string): Json => r.body.steps.find((s: Json) => s.key === k);
    expect(step('menu')).toMatchObject({ done: true });
    expect(step('printers')).toMatchObject({ done: true, count: 1 });
    expect(step('payments')).toMatchObject({ done: true });
    expect(step('day')).toMatchObject({ done: true });
    expect(step('tables')).toMatchObject({ done: false, count: 0 }); // none were added here
    expect(step('restaurant').done).toBe(false); // no address or phone yet
    expect(step('qrMenu')).toMatchObject({ done: false, optional: true });
    expect(r.body.ready).toBe(false);
    expect(r.body.requiredDone).toBeLessThan(r.body.requiredTotal);
    // filling in the missing parts makes it ready
    await api(owner).patch('/branch', { address: 'Main Boulevard', phone: '0300 0000000' });
    const area = (await api(owner).post('/areas', { name: 'Hall' })).body;
    await api(owner).post('/tables', { area_id: area.id, code: 'T1', seats: 4 });
    const after = await api(owner).get('/setup/status');
    expect(after.body.ready).toBe(true);
    expect((await api(cashier).get('/setup/status')).status).toBe(403);
  });

  it('rejects bad ranges and is for people who may see financial reports', async () => {
    expect((await get(owner, today, day(-1))).status).toBe(400);
    expect((await get(owner, day(-400), today)).status).toBe(400);
    expect((await api(owner).get('/reports/dashboard')).status).toBe(400);
    expect((await get(captain)).status).toBe(403);
    expect((await get(cashier)).status).toBe(403);
    expect((await get(accountant)).status).toBe(200);
    expect((await get(manager)).status).toBe(200);
    expect(
      (await request(t.app).get(`/api/v1/reports/dashboard?from=${today}&to=${today}`)).status,
    ).toBe(401);
  });
});
