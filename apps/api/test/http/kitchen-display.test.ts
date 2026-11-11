import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from './app-harness';
import { SimPrinter } from './sim-printer';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let t: TestApp;
let kitchen: string;
let captain: string;
let cashier: string;
let accountant: string;
let tikka: { id: string; variantId: string };
let tableId = '';
const api = (tok: string) => t.as(tok);

beforeAll(async () => {
  t = await startApp();
  const owner = (await t.login('OWNER')).token;
  kitchen = (await t.login('KITCHEN')).token;
  captain = (await t.login('CAPTAIN')).token;
  cashier = (await t.login('CASHIER')).token;
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
  const area = (await api(owner).post('/areas', { name: 'Hall' })).body.id;
  tableId = (await api(owner).post('/tables', { code: 'T1', seats: 4, area_id: area })).body.id;
  await api(cashier).post('/business-days/open', {});
}, 240_000);

afterAll(async () => {
  await t.stop();
});

async function sendOrder(rush = false): Promise<{ orderId: string; kotId: string }> {
  const o = (await api(captain).post('/orders', { type: 'DINE_IN', tableId })).body;
  await api(captain).post(`/orders/${o.id}/items`, {
    itemId: tikka.id,
    variantId: tikka.variantId,
    qty: 2,
    note: 'less spicy',
  });
  const sent = await api(captain).post(`/orders/${o.id}/send`, rush ? { rush: true } : {});
  expect(sent.status, JSON.stringify(sent.body)).toBe(201);
  const board = (await api(kitchen).get('/kitchen/board')).body;
  const ticket = board.tickets.find((x: Json) => x.orderId === o.id);
  return { orderId: o.id, kotId: ticket.id };
}

describe('kitchen board', () => {
  it('shows a sent order as a NEW ticket with its lines, table, captain and rush flag', async () => {
    const { kotId } = await sendOrder(true);
    const r = await api(kitchen).get('/kitchen/board');
    expect(r.status).toBe(200);
    const ticket = r.body.tickets.find((x: Json) => x.id === kotId);
    expect(ticket).toMatchObject({
      status: 'NEW',
      rush: true,
      stationCode: 'BBQ',
      tableCode: 'T1',
      orderType: 'DINE_IN',
    });
    expect(ticket.lines).toEqual([
      expect.objectContaining({ qty: 2, name: 'Tikka', note: 'less spicy', voided: false }),
    ]);
    expect(r.body.stations).toEqual([{ code: 'BBQ', name: 'BBQ' }]);
    // another station filter returns nothing
    expect((await api(kitchen).get('/kitchen/board?station=NOPE')).body.tickets).toHaveLength(0);
  });

  it('moves a ticket through preparing, ready and served; the table is told food is ready', async () => {
    const { orderId, kotId } = await sendOrder().catch(async () => {
      // table T1 already has an order from the first test: reuse it
      const board = (await api(kitchen).get('/kitchen/board')).body;
      const ticket = board.tickets[0];
      return { orderId: ticket.orderId as string, kotId: ticket.id as string };
    });
    const move = (tok: string, status: string) =>
      api(tok).post(`/kots/${kotId}/status`, { status });

    expect((await move(kitchen, 'DONE')).status).toBe(409); // cannot skip ahead
    expect((await move(kitchen, 'PREPARING')).body.status).toBe('PREPARING');
    expect((await move(captain, 'READY')).status).toBe(403); // waiters do not cook
    expect((await move(kitchen, 'READY')).body.status).toBe('READY');

    const floor = (await api(cashier).get('/floor')).body;
    expect(floor.tables.find((x: Json) => x.code === 'T1').order.ticketsReady).toBe(1);

    const lines = await t.kdb
      .selectFrom('order_items')
      .select('status')
      .where('order_id', '=', orderId)
      .execute();
    expect(lines.every((l) => l.status === 'READY')).toBe(true);

    expect((await move(captain, 'DONE')).body.status).toBe('DONE'); // the waiter serves
    const after = (await api(cashier).get('/floor')).body;
    expect(after.tables.find((x: Json) => x.code === 'T1').order.ticketsReady).toBe(0);
    const row = await t.kdb
      .selectFrom('kots')
      .selectAll()
      .where('id', '=', kotId)
      .executeTakeFirstOrThrow();
    expect(row.started_at).not.toBeNull();
    expect(row.ready_at).not.toBeNull();
    expect(row.done_at).not.toBeNull();

    // served tickets stay on the board for 30 minutes, then drop off
    expect(
      (await api(kitchen).get('/kitchen/board')).body.tickets.some((x: Json) => x.id === kotId),
    ).toBe(true);
    t.clock.advance(31 * 60_000);
    kitchen = (await t.login('KITCHEN')).token; // the old tokens expired with the clock
    captain = (await t.login('CAPTAIN')).token;
    accountant = (await t.login('ACCOUNTANT')).token;
    expect(
      (await api(kitchen).get('/kitchen/board')).body.tickets.some((x: Json) => x.id === kotId),
    ).toBe(false);
  });

  it('is only for roles that may see the kitchen', async () => {
    expect((await api(accountant).get('/kitchen/board')).status).toBe(403);
    expect((await api(captain).get('/kitchen/board')).status).toBe(200);
  });
});
