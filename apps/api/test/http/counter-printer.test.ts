import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processPrintJobs, TcpTransport } from '../../src/modules/printing/print.service';
import { startApp, type TestApp } from './app-harness';
import { SimPrinter } from './sim-printer';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/**
 * The restaurant with ONE printer at the counter: it prints the kitchen tickets and the bills. Both a
 * "kitchen" and a "receipt" printer row point at the same physical (simulated) printer.
 */
let t: TestApp;
let owner: string;
let cashier: string;
let captain: string;
let sim: SimPrinter;
let cashId = '';
const S: Record<string, string> = {};
const L: Record<string, string> = {};
const items: Record<string, { id: string; variantId: string }> = {};
const api = (tok: string) => t.as(tok);
const transport = new TcpTransport();
const run = () => processPrintJobs(t.ctx, transport);
let keySeq = 0;
const key = () => `counter-key-${Date.now()}-${++keySeq}`;
const setting = (k: string, v: boolean) => api(owner).put(`/settings/${k}`, { value: v });
const received = (): string[] => sim.tickets();

async function mkItem(name: string, station: string, price: number) {
  const res = await api(owner).post('/items', { kind: 'STANDARD', name, stationId: S[station] });
  for (const l of Object.values(L))
    await api(owner).put(`/variants/${res.body.variants[0].id}/prices/${l}`, { pricePaisa: price });
  items[name] = { id: res.body.id, variantId: res.body.variants[0].id };
}
async function order(type: 'TAKEAWAY' | 'DINE_IN' = 'TAKEAWAY', lines: [string, number][] = []) {
  const o = (await api(captain).post('/orders', { type })).body;
  for (const [name, qty] of lines)
    await api(captain).post(`/orders/${o.id}/items`, {
      itemId: items[name]!.id,
      variantId: items[name]!.variantId,
      qty,
    });
  return o;
}
const send = (id: string, body: object = {}) => api(captain).post(`/orders/${id}/send`, body);

beforeAll(async () => {
  t = await startApp();
  owner = (await t.login('OWNER')).token;
  cashier = (await t.login('CASHIER')).token;
  captain = (await t.login('CAPTAIN')).token;
  for (const code of ['DINE_IN', 'TAKEAWAY', 'DELIVERY'])
    L[code] = (await api(owner).post('/price-lists', { code, name: code })).body.id;
  for (const code of ['BBQ', 'TANDOOR', 'DRINKS'])
    S[code] = (await api(owner).post('/stations', { code, name: code })).body.id;
  sim = await SimPrinter.start();
  const printer = (kind: 'KOT' | 'RECEIPT') =>
    api(owner).post('/printers', {
      name: `Counter ${kind}`,
      kind,
      conn_type: 'NETWORK',
      host: '127.0.0.1',
      port: sim.port,
      paper_mm: 80,
    });
  const kot = (await printer('KOT')).body.id;
  expect((await printer('RECEIPT')).status).toBe(201);
  for (const code of Object.keys(S))
    await api(owner).put(`/stations/${S[code]}/printers`, { printerIds: [kot] });
  await mkItem('Chicken Tikka', 'BBQ', 90000);
  await mkItem('Naan', 'TANDOOR', 5000);
  await mkItem('Cola', 'DRINKS', 10000);
  cashId = (
    await api(owner).post('/payment-methods', {
      code: 'CASH',
      name: 'Cash',
      tender_class: 'CASH_OTHER',
      opens_drawer: true,
    })
  ).body.id;
  await api(cashier).post('/business-days/open', {});
  await api(cashier).post('/shifts/open', { openingFloatPaisa: 500000 });
}, 240_000);
afterAll(async () => {
  await sim.unplug();
  await t.stop();
});

describe('the token', () => {
  it("is the day's order number: 1, 2, 3 ..., printed huge on every kitchen ticket", async () => {
    const a = await order('TAKEAWAY', [['Chicken Tikka', 2]]);
    const b = await order('TAKEAWAY', [['Naan', 4]]);
    expect([a.orderNo, b.orderNo]).toEqual([1, 2]);
    expect((await send(a.id)).status).toBe(201);
    await run();
    const tickets = received();
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toContain('<SIZE:3x3>TOKEN 1');
    expect(tickets[0]).toContain('2 x Chicken Tikka');
  });

  it('finds the order again from the number alone, also after it is paid; an unknown token is a 404', async () => {
    const found = await api(cashier).get('/orders/by-token/2');
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({ token: 2, status: 'OPEN', type: 'TAKEAWAY', bill: null });
    expect((await api(cashier).get('/orders/by-token/99')).status).toBe(404);
    expect((await api(cashier).get('/orders/by-token/abc')).status).toBe(400);
  });
});

describe('without the switch: one slip per station (as before)', () => {
  it('a mixed order prints three tickets, each with the token', async () => {
    sim.jobs.length = 0;
    const o = await order('TAKEAWAY', [
      ['Chicken Tikka', 1],
      ['Naan', 2],
      ['Cola', 1],
    ]);
    const res = await send(o.id);
    expect(res.body.kots.map((k: Json) => k.station)).toEqual(['BBQ', 'TANDOOR', 'DRINKS']);
    await run();
    expect(received()).toHaveLength(3);
    for (const tk of received()) expect(tk).toContain(`TOKEN ${o.orderNo}`);
  });
});

describe('"one printer at the counter": a single combined ticket', () => {
  it('a Send prints ONE ticket: token on top, every station as a section, one cut', async () => {
    expect((await setting('kot.single_ticket', true)).status).toBe(200);
    sim.jobs.length = 0;
    const o = await order('TAKEAWAY', [
      ['Chicken Tikka', 1],
      ['Naan', 2],
      ['Cola', 1],
    ]);
    const res = await send(o.id);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // the kitchen display still gets one KOT per station
    expect(res.body.kots.map((k: Json) => [k.station, k.printers])).toEqual([
      ['BBQ', 1],
      ['TANDOOR', 1],
      ['DRINKS', 1],
    ]);
    expect(res.body.unprinted).toEqual([]);
    await run();
    const tickets = received();
    expect(tickets).toHaveLength(1);
    const tk = tickets[0]!;
    expect(tk).toContain(`<SIZE:3x3>TOKEN ${o.orderNo}`);
    for (const st of ['BBQ', 'TANDOOR', 'DRINKS']) expect(tk).toContain(st);
    expect(tk).toContain('1 x Chicken Tikka');
    expect(tk).toContain('2 x Naan');
    expect(tk.match(/<CUT/g) ?? []).toHaveLength(1);
    expect(tk.indexOf('TOKEN')).toBeLessThan(tk.indexOf('BBQ'));
    const kots = await t.kdb.selectFrom('kots').selectAll().where('order_id', '=', o.id).execute();
    expect(kots).toHaveLength(3);
    expect(kots.every((k) => k.print_count === 1)).toBe(true);
    (globalThis as Json).__combinedOrder = o;
  });

  it('a later Send of the same order is its own ticket with the same token', async () => {
    const o = (globalThis as Json).__combinedOrder;
    sim.jobs.length = 0;
    await api(captain).post(`/orders/${o.id}/items`, {
      itemId: items['Naan']!.id,
      variantId: items['Naan']!.variantId,
      qty: 3,
    });
    expect((await send(o.id, { rush: true })).status).toBe(201);
    await run();
    expect(received()).toHaveLength(1);
    expect(received()[0]).toContain(`TOKEN ${o.orderNo}`);
    expect(received()[0]).toContain('*** RUSH ***');
    expect(received()[0]).toContain('3 x Naan');
    expect(received()[0]).not.toContain('Chicken Tikka');
  });

  it('a reprint brings back the WHOLE ticket of that Send, marked REPRINT, and is audited', async () => {
    const o2 = await order('TAKEAWAY', [
      ['Chicken Tikka', 1],
      ['Cola', 2],
    ]);
    const sent = await send(o2.id);
    await run();
    sim.jobs.length = 0;
    const kotId = sent.body.kots[1].id; // any one of the ticket's KOTs
    const rp = await api(captain).post(`/kots/${kotId}/reprint`, { reason: 'Smudged' });
    expect(rp.status, JSON.stringify(rp.body)).toBe(201);
    await run();
    expect(received()).toHaveLength(1);
    expect(received()[0]).toContain('** REPRINT #1 **');
    expect(received()[0]).toContain('1 x Chicken Tikka');
    expect(received()[0]).toContain('2 x Cola');
    const rows = await t.kdb
      .selectFrom('audit_log')
      .select('action')
      .where('action', '=', 'KOT_REPRINT')
      .execute();
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it('switching it off again goes back to one slip per station', async () => {
    await setting('kot.single_ticket', false);
    sim.jobs.length = 0;
    const o = await order('TAKEAWAY', [
      ['Chicken Tikka', 1],
      ['Naan', 1],
    ]);
    await send(o.id);
    await run();
    expect(received()).toHaveLength(2);
  });
});

describe('the bill is printed before the money is taken', () => {
  let o: Json;
  let bill: Json;
  beforeAll(async () => {
    o = await order('TAKEAWAY', [
      ['Chicken Tikka', 2],
      ['Cola', 1],
    ]);
    await send(o.id);
    await run();
    bill = (await api(cashier).post(`/orders/${o.id}/bill`)).body;
    sim.jobs.length = 0;
  });

  it('prints the bill: token, items, amount due, NOT PAID, no drawer; the bill stays unpaid; no receipt count', async () => {
    const res = await api(cashier)
      .post(`/bills/${bill.id}/print-bill`)
      .set('Idempotency-Key', key());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ printers: 1, browser: null });
    await run();
    expect(received()).toHaveLength(1);
    const tk = received()[0]!;
    expect(tk).toContain('*** BILL - NOT PAID ***');
    expect(tk).toContain(`<SIZE:3x3>TOKEN ${o.orderNo}`);
    expect(tk).toContain('2 x Chicken Tikka');
    expect(tk).toContain('Please pay at the counter');
    expect(tk).not.toContain('<DRAWER');
    expect(tk).not.toContain('Thank you');
    const after = await api(cashier).get(`/bills/${bill.id}`);
    expect(after.body.status).toBe('PRE_BILLED');
    expect(after.body.printCount).toBe(0);
  });

  it('pressing twice with the same key prints once; a new press prints again; every press is audited', async () => {
    sim.jobs.length = 0;
    const k = key();
    await api(cashier).post(`/bills/${bill.id}/print-bill`).set('Idempotency-Key', k);
    await api(cashier).post(`/bills/${bill.id}/print-bill`).set('Idempotency-Key', k);
    await run();
    expect(received()).toHaveLength(1);
    await api(cashier).post(`/bills/${bill.id}/print-bill`).set('Idempotency-Key', key());
    await run();
    expect(received()).toHaveLength(2);
    const rows = await t.kdb
      .selectFrom('audit_log')
      .select('action')
      .where('action', '=', 'BILL_PRINT_PREBILL')
      .execute();
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect((await api(cashier).post(`/bills/${bill.id}/print-bill`)).status).toBe(400); // needs the key
  });

  it('by default the receipt still prints after payment (nothing changes for other restaurants)', async () => {
    sim.jobs.length = 0;
    const settle = await api(cashier)
      .post(`/bills/${bill.id}/settle`, {
        tenders: [
          { methodId: cashId, amountPaisa: bill.totalPaisa, tenderedPaisa: bill.totalPaisa },
        ],
      })
      .set('Idempotency-Key', key());
    expect(settle.status, JSON.stringify(settle.body)).toBe(201);
    expect(settle.body).toMatchObject({ receipts: 1, printPolicy: 'AUTO' });
    await run();
    expect(received()).toHaveLength(1);
    expect(received()[0]).toContain('Thank you');
    expect(received()[0]).toContain(`TOKEN ${o.orderNo}`);
  });

  it('a paid bill can no longer be printed as "not paid"', async () => {
    const res = await api(cashier)
      .post(`/bills/${bill.id}/print-bill`)
      .set('Idempotency-Key', key());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BILL_NOT_PAYABLE');
  });

  it('with "print after payment" switched off, paying prints nothing; the first receipt is still free on request', async () => {
    expect((await setting('receipt.print_after_payment', false)).status).toBe(200);
    const o2 = await order('TAKEAWAY', [['Naan', 2]]);
    await send(o2.id);
    const b2 = (await api(cashier).post(`/orders/${o2.id}/bill`)).body;
    await api(cashier).post(`/bills/${b2.id}/print-bill`).set('Idempotency-Key', key());
    await run();
    sim.jobs.length = 0;
    const settle = await api(cashier)
      .post(`/bills/${b2.id}/settle`, {
        tenders: [{ methodId: cashId, amountPaisa: b2.totalPaisa, tenderedPaisa: b2.totalPaisa }],
      })
      .set('Idempotency-Key', key());
    expect(settle.body).toMatchObject({ receipts: 0, printPolicy: 'MANUAL' });
    expect(settle.body.bill.printCount).toBe(0);
    await run();
    expect(received()).toHaveLength(0);
    // on request, the first print is the original (no DUPLICATE, no reason needed)
    const browser = await api(cashier).post(`/bills/${b2.id}/browser-print`, {});
    expect(browser.status, JSON.stringify(browser.body)).toBe(201);
    expect(browser.body.duplicate).toBe(0);
    await setting('receipt.print_after_payment', true);
  });
});

describe('without any thermal printer the browser prints the bill', () => {
  it('print-bill hands back the data to print, marked not paid, with the token', async () => {
    await t.kdb
      .updateTable('printers')
      .set({ is_active: false })
      .where('kind', '=', 'RECEIPT')
      .execute();
    const o = await order('TAKEAWAY', [['Naan', 1]]);
    await send(o.id);
    const b = (await api(cashier).post(`/orders/${o.id}/bill`)).body;
    const res = await api(cashier).post(`/bills/${b.id}/print-bill`).set('Idempotency-Key', key());
    expect(res.status).toBe(201);
    expect(res.body.printers).toBe(0);
    expect(res.body.browser.doc).toMatchObject({
      provisional: true,
      orderNo: o.orderNo,
      payments: [],
    });
    expect(res.body.browser.language).toBe('en');
  });
});

describe('"print the bill for this table" in one tap, pay later, the table frees on payment', () => {
  let tableId = '';
  let o: Json;
  beforeAll(async () => {
    await t.kdb
      .updateTable('printers')
      .set({ is_active: true })
      .where('kind', '=', 'RECEIPT')
      .execute();
    tableId = (await api(owner).post('/tables', { code: 'T9', seats: 4 })).body.id;
    o = (await api(captain).post('/orders', { type: 'DINE_IN', tableId })).body;
    await api(captain).post(`/orders/${o.id}/items`, {
      itemId: items['Chicken Tikka']!.id,
      variantId: items['Chicken Tikka']!.variantId,
      qty: 2,
    });
  });
  const floorStatus = async (): Promise<string> =>
    (await api(cashier).get('/floor')).body.tables.find((x: Json) => x.id === tableId).status;

  it('refuses while something is not yet sent to the kitchen', async () => {
    const res = await api(captain).post(`/orders/${o.id}/print-bill`).set('Idempotency-Key', key());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('UNSENT_ITEMS');
    expect(await floorStatus()).toBe('OCCUPIED');
  });

  it('bills and prints in one go; the table shows "bill printed"; nothing is paid yet', async () => {
    await send(o.id);
    await run();
    sim.jobs.length = 0;
    const k = key();
    const res = await api(captain).post(`/orders/${o.id}/print-bill`).set('Idempotency-Key', k);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      created: true,
      printers: 1,
      token: o.orderNo,
      tableCode: 'T9',
    });
    expect(res.body.totalPaisa).toBe(180000);
    await run();
    expect(received()).toHaveLength(1);
    expect(received()[0]).toContain('BILL - NOT PAID');
    expect(received()[0]).toContain('Table T9');
    expect(received()[0]).toContain(`TOKEN ${o.orderNo}`);
    expect(await floorStatus()).toBe('BILLED');
    // the same key again: no second paper
    const again = await api(captain).post(`/orders/${o.id}/print-bill`).set('Idempotency-Key', k);
    expect(again.status).toBe(201);
    expect(again.body.created).toBe(false);
    await run();
    expect(received()).toHaveLength(1);
    // a new press: the same bill is printed again, not a second bill
    const second = await api(captain)
      .post(`/orders/${o.id}/print-bill`)
      .set('Idempotency-Key', key());
    expect(second.body).toMatchObject({ created: false, billId: res.body.billId });
    await run();
    expect(received()).toHaveLength(2);
    expect(
      await t.kdb.selectFrom('bills').select('id').where('order_id', '=', o.id).execute(),
    ).toHaveLength(1);
  });

  it('paying frees the table at once', async () => {
    const bill = (await api(cashier).get(`/orders/${o.id}/bill`)).body;
    const settle = await api(cashier)
      .post(`/bills/${bill.id}/settle`, {
        tenders: [
          { methodId: cashId, amountPaisa: bill.totalPaisa, tenderedPaisa: bill.totalPaisa },
        ],
      })
      .set('Idempotency-Key', key());
    expect(settle.status, JSON.stringify(settle.body)).toBe(201);
    expect(await floorStatus()).toBe('FREE');
    const late = await api(captain)
      .post(`/orders/${o.id}/print-bill`)
      .set('Idempotency-Key', key());
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('BILL_ALREADY_SETTLED');
  });

  it('needs bill.create; the kitchen role cannot', async () => {
    const kitchen = (await t.login('KITCHEN')).token;
    expect(
      (await api(kitchen).post(`/orders/${o.id}/print-bill`).set('Idempotency-Key', key())).status,
    ).toBe(403);
  });

  it('the Kitchen screen can be switched off in the settings (the printed ticket is the kitchen)', async () => {
    expect((await setting('kitchen.screen_enabled', false)).status).toBe(200);
    expect((await api(owner).get('/settings')).body['kitchen.screen_enabled']).toBe(false);
    await setting('kitchen.screen_enabled', true);
  });
});

describe('the token slip: a separate small print, handed to the customer', () => {
  it('prints a small slip with the token huge, apart from the kitchen ticket; no amounts; as often as needed', async () => {
    await setting('kot.single_ticket', false);
    const o = await order('TAKEAWAY', [['Naan', 2]]);
    sim.jobs.length = 0;
    const res = await api(captain)
      .post(`/orders/${o.id}/print-token`)
      .set('Idempotency-Key', key());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toEqual({ token: o.orderNo, printers: 1, browser: null });
    await run();
    // count only THIS order's token slips (earlier tests may still have papers queued behind it)
    const slips = (): string[] =>
      received().filter(
        (x) => x.includes('Show it when you pay.') && x.includes(`<SIZE:4x4>${o.orderNo}`),
      );
    expect(slips()).toHaveLength(1);
    expect(slips()[0]).toContain(' TAKEAWAY ');
    expect(slips()[0]).not.toContain('Naan');
    expect(slips()[0]).not.toMatch(/Rs |TOTAL/);
    // the same key twice prints once; a new press prints again
    const k = key();
    await api(captain).post(`/orders/${o.id}/print-token`).set('Idempotency-Key', k);
    await api(captain).post(`/orders/${o.id}/print-token`).set('Idempotency-Key', k);
    await run();
    expect(slips()).toHaveLength(2);
    expect((await api(captain).post(`/orders/${o.id}/print-token`)).status).toBe(400);
  });

  it('works while the order is billed, not after it is paid; needs order.create', async () => {
    const o = await order('TAKEAWAY', [['Naan', 1]]);
    await send(o.id);
    const b = (await api(cashier).post(`/orders/${o.id}/bill`)).body;
    expect(
      (await api(cashier).post(`/orders/${o.id}/print-token`).set('Idempotency-Key', key())).status,
    ).toBe(201);
    await api(cashier)
      .post(`/bills/${b.id}/settle`, {
        tenders: [{ methodId: cashId, amountPaisa: b.totalPaisa, tenderedPaisa: b.totalPaisa }],
      })
      .set('Idempotency-Key', key());
    const late = await api(cashier)
      .post(`/orders/${o.id}/print-token`)
      .set('Idempotency-Key', key());
    expect(late.status).toBe(409);
    const kitchen = (await t.login('KITCHEN')).token;
    expect(
      (await api(kitchen).post(`/orders/${o.id}/print-token`).set('Idempotency-Key', key())).status,
    ).toBe(403);
  });

  it('without a thermal receipt printer it says so (0 printers) instead of failing', async () => {
    await t.kdb
      .updateTable('printers')
      .set({ is_active: false })
      .where('kind', '=', 'RECEIPT')
      .execute();
    const o = await order('TAKEAWAY', [['Naan', 1]]);
    const res = await api(captain)
      .post(`/orders/${o.id}/print-token`)
      .set('Idempotency-Key', key());
    expect(res.status).toBe(201);
    expect(res.body.printers).toBe(0);
    await t.kdb
      .updateTable('printers')
      .set({ is_active: true })
      .where('kind', '=', 'RECEIPT')
      .execute();
  });
});

describe('takeaway and delivery: who it is for, on every slip', () => {
  it('an order keeps a name and phone (and a delivery address); the slips carry them', async () => {
    const d = (
      await api(captain).post('/orders', {
        type: 'DELIVERY',
        customerName: 'Ali Raza',
        customerPhone: '0300-1234567',
        deliveryAddress: 'House 12, Street 4, Gulberg',
      })
    ).body;
    expect(d).toMatchObject({
      customerName: 'Ali Raza',
      customerPhone: '0300-1234567',
      deliveryAddress: 'House 12, Street 4, Gulberg',
    });
    await api(captain).post(`/orders/${d.id}/items`, {
      itemId: items['Naan']!.id,
      variantId: items['Naan']!.variantId,
      qty: 2,
    });
    for (let i = 0; i < 10; i++) if (!(await run()).printed) break;
    sim.jobs.length = 0;
    await send(d.id);
    await api(captain).post(`/orders/${d.id}/print-token`).set('Idempotency-Key', key());
    await run();
    const all = received().join('\n');
    expect(all).toContain(' DELIVERY ');
    expect(all).toContain('Name: Ali Raza');
    expect(all).toContain('Phone: 0300-1234567');
    expect(all).not.toContain('Address: House'); // not on the kitchen ticket or the token slip
    // the bill a rider carries has the address
    sim.jobs.length = 0;
    await api(captain).post(`/orders/${d.id}/print-bill`).set('Idempotency-Key', key());
    await run();
    const bill = received().join('\n');
    expect(bill).toContain('BILL - NOT PAID');
    expect(bill).toContain('Address: House 12, Street 4, Gulberg');
  });

  it('can be edited while the order is open; the address only counts on a delivery', async () => {
    const tk = (await api(captain).post('/orders', { type: 'TAKEAWAY' })).body;
    const patched = await api(captain)
      .patch(`/orders/${tk.id}`, {
        customerName: 'Sara',
        customerPhone: '0321-0000000',
        deliveryAddress: 'ignored',
      })
      .set('If-Match', String(tk.version));
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body).toMatchObject({
      customerName: 'Sara',
      customerPhone: '0321-0000000',
      deliveryAddress: null,
    });
    const bad = await api(captain)
      .patch(`/orders/${tk.id}`, { customerName: 'x'.repeat(81) })
      .set('If-Match', String(patched.body.version));
    expect(bad.status).toBe(400);
  });
});
