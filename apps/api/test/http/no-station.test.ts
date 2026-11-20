import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processPrintJobs, TcpTransport } from '../../src/modules/printing/print.service';
import { startApp, type TestApp } from './app-harness';
import { SimPrinter } from './sim-printer';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/**
 * The restaurant that set nothing up: no stations, no station-to-printer mapping, dishes without a station, ONE printer
 * on the counter (here a receipt printer only). Pressing Print KOT must still print the ticket.
 */
let t: TestApp;
let owner: string;
let cashier: string;
let sim: SimPrinter;
let dish: { id: string; variantId: string };
const api = (tok: string) => t.as(tok);
const transport = new TcpTransport();
const run = () => processPrintJobs(t.ctx, transport);

beforeAll(async () => {
  t = await startApp();
  owner = (await t.login('OWNER')).token;
  cashier = (await t.login('CASHIER')).token;
  const list = (await api(owner).post('/price-lists', { code: 'TAKEAWAY', name: 'Takeaway' })).body
    .id;
  sim = await SimPrinter.start();
  const pr = await api(owner).post('/printers', {
    name: 'Counter',
    kind: 'RECEIPT',
    conn_type: 'NETWORK',
    host: '127.0.0.1',
    port: sim.port,
    paper_mm: 80,
  });
  expect(pr.status).toBe(201);
  const item = await api(owner).post('/items', { kind: 'STANDARD', name: '1 LITTRE DRINK' }); // no station
  expect(item.status).toBe(201);
  await api(owner).put(`/variants/${item.body.variants[0].id}/prices/${list}`, {
    pricePaisa: 20000,
  });
  dish = { id: item.body.id, variantId: item.body.variants[0].id };
  await api(cashier).post('/business-days/open', {});
}, 240_000);
afterAll(async () => {
  await sim.unplug();
  await t.stop();
});

describe('nothing set up, one printer', () => {
  it('Print KOT prints the ticket (under KITCHEN) on the only printer; nothing is left unprinted', async () => {
    const o = (await api(cashier).post('/orders', { type: 'TAKEAWAY' })).body;
    await api(cashier).post(`/orders/${o.id}/items`, {
      itemId: dish.id,
      variantId: dish.variantId,
      qty: 1,
    });
    const res = await api(cashier).post(`/orders/${o.id}/send`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.kots.map((k: Json) => [k.station, k.printers])).toEqual([['KITCHEN', 1]]);
    expect(res.body.unprinted).toEqual([]);
    expect(res.body.ticket).toBeNull();
    await run();
    const tickets = sim.tickets();
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toContain(`TOKEN ${o.orderNo}`);
    expect(tickets[0]).toContain('1 x 1 LITTRE DRINK');
    expect(tickets[0]).toContain('KITCHEN');
  });

  it('a counter whose ONE printer is set up as the kitchen printer still gets its token and its bill', async () => {
    const printers = (await api(owner).get('/printers')).body.items as Json[];
    for (const p of printers) await api(owner).patch(`/printers/${p.id}`, { is_active: false });
    const kot = (
      await api(owner).post('/printers', {
        name: 'Only printer',
        kind: 'KOT',
        conn_type: 'NETWORK',
        host: '127.0.0.1',
        port: sim.port,
        paper_mm: 80,
      })
    ).body.id;
    sim.jobs.length = 0;
    const o = (await api(cashier).post('/orders', { type: 'TAKEAWAY' })).body;
    await api(cashier).post(`/orders/${o.id}/items`, {
      itemId: dish.id,
      variantId: dish.variantId,
      qty: 1,
    });
    const tok = await api(cashier)
      .post(`/orders/${o.id}/print-token`)
      .set('Idempotency-Key', `tok-${Date.now()}-1`);
    expect(tok.body).toMatchObject({ printers: 1, browser: null });
    await api(cashier).post(`/orders/${o.id}/send`, {});
    const bill = await api(cashier)
      .post(`/orders/${o.id}/print-bill`)
      .set('Idempotency-Key', `bill-${Date.now()}-1`);
    expect(bill.body.printers).toBe(1);
    await run();
    const all = sim.tickets().join(' | ');
    expect(all).toContain('Show it when you pay.');
    expect(all).toContain('BILL - NOT PAID');
    await api(owner).patch(`/printers/${kot}`, { is_active: false });
    for (const p of printers) await api(owner).patch(`/printers/${p.id}`, { is_active: true });
  });

  it('once a station IS mapped, the choice is respected: a station left unmapped stays unprinted (the screen prints it)', async () => {
    const st = (await api(owner).post('/stations', { code: 'BBQ', name: 'BBQ' })).body.id;
    const kot = (
      await api(owner).post('/printers', {
        name: 'BBQ kitchen',
        kind: 'KOT',
        conn_type: 'NETWORK',
        host: '127.0.0.1',
        port: sim.port,
        paper_mm: 80,
      })
    ).body.id;
    await api(owner).put(`/stations/${st}/printers`, { printerIds: [kot] });
    const o = (await api(cashier).post('/orders', { type: 'TAKEAWAY' })).body;
    await api(cashier).post(`/orders/${o.id}/items`, {
      itemId: dish.id,
      variantId: dish.variantId,
      qty: 1,
    });
    const res = await api(cashier).post(`/orders/${o.id}/send`, {});
    expect(res.body.unprinted).toEqual(['KITCHEN']);
    expect(res.body.ticket.sections[0].station).toBe('KITCHEN');
  });
});
