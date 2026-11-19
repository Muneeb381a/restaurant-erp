import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  enqueuePrintJob,
  backoffMs,
  MAX_JOB_AGE_MS,
  processPrintJobs,
  TcpTransport,
} from '../../src/modules/printing/print.service';
import { startApp, type TestApp } from './app-harness';
import { SimPrinter } from './sim-printer';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let t: TestApp;
let owner: string;
let manager: string;
let cashier: string;
let captain: string;
let kitchen: string;
const L: Record<string, string> = {};
const S: Record<string, string> = {};
let bbq: SimPrinter;
let tandoor: SimPrinter;
let bbqBackup: SimPrinter;
const P: Record<string, string> = {};

const api = (tok: string) => t.as(tok);
const transport = new TcpTransport();
const run = () => processPrintJobs(t.ctx, transport);
const audit = (action: string) =>
  t.kdb.selectFrom('audit_log').selectAll().where('action', '=', action).orderBy('id').execute();
const jobs = (where?: { status?: string; printer?: string }) => {
  let q = t.kdb.selectFrom('print_jobs').selectAll().orderBy('seq');
  if (where?.status) q = q.where('status', '=', where.status);
  if (where?.printer) q = q.where('printer_id', '=', where.printer);
  return q.execute();
};

interface Fx {
  id: string;
  variantId: string;
  variants: { id: string }[];
}
async function mkItem(body: Record<string, unknown>, price = 50000): Promise<Fx> {
  const res = await api(owner).post('/items', { kind: 'STANDARD', ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  for (const list of ['DINE_IN', 'TAKEAWAY', 'DELIVERY']) {
    await api(owner).put(`/variants/${res.body.variants[0].id}/prices/${L[list]}`, {
      pricePaisa: price,
    });
  }
  return { id: res.body.id, variantId: res.body.variants[0].id, variants: res.body.variants };
}
const newOrder = async (
  type: 'TAKEAWAY' | 'DINE_IN' = 'TAKEAWAY',
  tableId?: string,
): Promise<Json> => {
  const res = await api(captain).post('/orders', { type, ...(tableId ? { tableId } : {}) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
};
const add = (orderId: string, item: Fx, extra: Record<string, unknown> = {}) =>
  api(captain).post(`/orders/${orderId}/items`, {
    itemId: item.id,
    variantId: item.variantId,
    ...extra,
  });
const send = (orderId: string, body: object = {}) =>
  api(captain).post(`/orders/${orderId}/send`, body);
const addPrinter = async (name: string, sim: SimPrinter, paper = 80): Promise<string> => {
  const res = await api(owner).post('/printers', {
    name,
    kind: 'KOT',
    conn_type: 'NETWORK',
    host: '127.0.0.1',
    port: sim.port,
    paper_mm: paper,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id;
};
const mapStation = (station: string, printers: string[]) =>
  api(owner).put(`/stations/${S[station]}/printers`, { printerIds: printers });

let tikka: Fx;
let karahi: Fx;
let naan: Fx;
let cola: Fx;
let noStation: Fx;
const tableIds: string[] = [];

beforeAll(async () => {
  t = await startApp();
  owner = (await t.login('OWNER')).token;
  manager = (await t.login('MANAGER')).token;
  cashier = (await t.login('CASHIER')).token;
  captain = (await t.login('CAPTAIN')).token;
  kitchen = (await t.login('KITCHEN')).token;
  for (const [code, name] of [
    ['DINE_IN', 'Dine-in'],
    ['TAKEAWAY', 'Takeaway'],
    ['DELIVERY', 'Delivery'],
  ] as const) {
    L[code] = (await api(owner).post('/price-lists', { code, name })).body.id;
  }
  for (const code of ['BBQ', 'TANDOOR', 'DRINKS', 'COLD'])
    S[code] = (await api(owner).post('/stations', { code, name: code })).body.id;
  for (const code of ['T1', 'T2', 'T3'])
    tableIds.push((await api(owner).post('/tables', { code, seats: 4 })).body.id);

  bbq = await SimPrinter.start();
  tandoor = await SimPrinter.start();
  bbqBackup = await SimPrinter.start();
  P.bbq = await addPrinter('BBQ printer', bbq, 80);
  P.tandoor = await addPrinter('Tandoor printer', tandoor, 58);
  P.backup = await addPrinter('BBQ backup', bbqBackup, 80);
  await mapStation('BBQ', [P.bbq!]);
  await mapStation('TANDOOR', [P.tandoor!]);
  // DRINKS and COLD stations deliberately have no printer

  tikka = await mkItem({ name: 'Chicken Tikka (Leg)', stationId: S.BBQ });
  karahi = await mkItem(
    { name: 'Chicken Karahi', stationId: S.BBQ, variants: [{ name: 'Half' }, { name: 'Full' }] },
    110000,
  );
  naan = await mkItem({ name: 'Naan', stationId: S.TANDOOR }, 5000);
  cola = await mkItem({ name: 'Cola', stationId: S.DRINKS }, 10000);
  noStation = await mkItem({ name: 'Mystery Dish' });

  await api(cashier).post('/business-days/open', {});
}, 240_000);

afterAll(async () => {
  await Promise.all([bbq.unplug(), tandoor.unplug(), bbqBackup.unplug()]);
  await t.stop();
});

describe('backoff', () => {
  it('doubles from 2 s up to a 30 s ceiling', () => {
    expect([1, 2, 3, 4, 5, 6, 10].map(backoffMs)).toEqual([
      2000, 4000, 8000, 16000, 30000, 30000, 30000,
    ]);
  });
});

describe('send to kitchen', () => {
  it('one KOT per station in one transaction: lines become SENT, jobs are queued, unprinted stations are reported', async () => {
    const o = await newOrder('DINE_IN', tableIds[0]);
    await add(o.id, tikka, { qty: 2, note: 'less spicy' });
    await add(o.id, naan, { qty: 4 });
    await add(o.id, cola);
    const res = await send(o.id);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.headers.etag).toBe(`"${res.body.order.version}"`);

    const kots = res.body.kots as Json[];
    expect(kots.map((k) => [k.kotNo, k.station, k.lineCount, k.printers])).toEqual([
      [1, 'BBQ', 1, 1],
      [2, 'TANDOOR', 1, 1],
      [3, 'DRINKS', 1, 0],
    ]);
    expect(res.body.unprinted).toEqual(['DRINKS']);
    expect(res.body.order.items.every((i: Json) => i.status === 'SENT')).toBe(true);
    expect(res.body.order.items.every((i: Json) => i.kotId)).toBe(true);

    // nothing is printed until the worker runs; then each station's printer gets ITS ticket
    expect(bbq.jobs).toHaveLength(0);
    expect(await run()).toMatchObject({ printed: 2, failed: 0, dead: 0 });
    expect(bbq.jobs).toHaveLength(1);
    expect(tandoor.jobs).toHaveLength(1);
    const ticket = bbq.tickets()[0]!;
    expect(ticket).toContain('KOT #1');
    expect(ticket).toContain('BBQ');
    expect(ticket).toContain('Table T1');
    expect(ticket).toContain('Order #1');
    expect(ticket).toContain('Waiter: CAPTAIN');
    expect(ticket).toContain('2 x Chicken Tikka (Leg)');
    expect(ticket).toContain('"less spicy"');
    expect(ticket).not.toContain('Naan'); // station routing: the naan is NOT on the BBQ ticket
    expect(tandoor.tickets()[0]).toContain('4 x Naan');
    const narrow = tandoor
      .tickets()[0]!
      .split('\n')
      .map((l) => l.replace(/<[^>]+>/g, '').length);
    expect(Math.max(...narrow)).toBeLessThanOrEqual(32); // 58 mm printer → 32 columns
    expect(await jobs({ status: 'DONE' })).toHaveLength(2);
    expect(
      (
        await t.kdb
          .selectFrom('kots')
          .select('print_count')
          .where('kot_no', '=', 3)
          .executeTakeFirstOrThrow()
      ).print_count,
    ).toBe(0);
  });

  it('a second send finds nothing new; later additions get a new KOT with only the new lines', async () => {
    const o = await newOrder();
    await add(o.id, tikka);
    expect((await send(o.id)).status).toBe(201);
    const again = await send(o.id);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('NOTHING_TO_SEND');
    await add(o.id, tikka, { qty: 3 });
    const second = await send(o.id);
    expect(second.body.kots).toHaveLength(1);
    expect(second.body.kots[0].lineCount).toBe(1);
    await run();
    expect(bbq.tickets().at(-1)).toContain('3 x Chicken Tikka (Leg)');
  });

  it('numbers KOTs gap-free per day across orders', async () => {
    const nos = (await t.kdb.selectFrom('kots').select('kot_no').orderBy('kot_no').execute()).map(
      (k) => k.kot_no,
    );
    expect(nos).toEqual(nos.map((_, i) => i + 1));
  });

  it('can send a single course; RUSH tickets carry the banner', async () => {
    const o = await newOrder();
    await add(o.id, tikka, { course: 1, qty: 1 });
    await add(o.id, karahi, { course: 2, qty: 1 });
    const first = await send(o.id, { course: 1, rush: true });
    expect(first.body.kots.map((k: Json) => k.lineCount)).toEqual([1]);
    expect(first.body.order.items.map((i: Json) => i.status)).toEqual(['SENT', 'NEW']);
    await run();
    expect(bbq.tickets().at(-1)).toContain('*** RUSH ***');
    const second = await send(o.id, { course: 2 });
    expect(second.status).toBe(201);
    await run();
    expect(bbq.tickets().at(-1)).not.toContain('RUSH');
    expect(
      (
        await t.kdb
          .selectFrom('kots')
          .select('is_rush')
          .where('order_id', '=', o.id)
          .orderBy('kot_no')
          .execute()
      ).map((k) => k.is_rush),
    ).toEqual([true, false]);
  });

  it('is atomic: an item without a station aborts the whole send', async () => {
    const o = await newOrder();
    await add(o.id, tikka);
    await add(o.id, noStation);
    const kotsBefore = (await t.kdb.selectFrom('kots').select('id').execute()).length;
    const jobsBefore = (await jobs()).length;
    const res = await send(o.id);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'STATION_MISSING', items: ['Mystery Dish'] });
    expect((await t.kdb.selectFrom('kots').select('id').execute()).length).toBe(kotsBefore);
    expect((await jobs()).length).toBe(jobsBefore);
    expect(
      (await api(captain).get(`/orders/${o.id}`)).body.items.every((i: Json) => i.status === 'NEW'),
    ).toBe(true);
  });

  it('a dish given its station AFTER it was added to the order is sent to that station (no stale snapshot)', async () => {
    const late = await mkItem({ name: 'Late Station Karahi' }); // no station yet
    const o = await newOrder();
    await add(o.id, late);
    const first = await send(o.id);
    expect(first.status).toBe(409);
    expect(first.body.code).toBe('STATION_MISSING');
    expect(first.body.items).toEqual(['Late Station Karahi']);
    expect(first.body.title).toContain('Admin, Menu');
    // the owner fixes the menu; the order line was added before, but sending looks the dish up again
    const fix = await api(owner).patch(`/items/${late.id}`, { stationId: S.BBQ });
    expect(fix.status, JSON.stringify(fix.body)).toBe(200);
    const second = await send(o.id);
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body.kots.map((k: Json) => k.station)).toEqual(['BBQ']);
    const line = await t.kdb
      .selectFrom('order_items')
      .select('station_id')
      .where('order_id', '=', o.id)
      .executeTakeFirst();
    expect(line?.station_id).toBe(S.BBQ);
  });

  it('refuses held, billed or stale-version orders', async () => {
    const o = await newOrder();
    await add(o.id, tikka);
    expect(
      (await api(captain).post(`/orders/${o.id}/send`, {}).set('If-Match', '1')).body.code,
    ).toBe('VERSION_CONFLICT');
    await api(captain).post(`/orders/${o.id}/hold`);
    expect((await send(o.id)).body.code).toBe('ORDER_HELD');
    await api(captain).post(`/orders/${o.id}/resume`);
    await t.kdb.updateTable('orders').set({ status: 'BILLED' }).where('id', '=', o.id).execute();
    expect((await send(o.id)).body.code).toBe('ORDER_NOT_EDITABLE');
    await t.kdb.updateTable('orders').set({ status: 'OPEN' }).where('id', '=', o.id).execute();
    expect((await api(kitchen).post(`/orders/${o.id}/send`, {})).status).toBe(403);
  });

  it('two simultaneous sends of one order: exactly one wins (row lock), one KOT', async () => {
    const o = await newOrder();
    await add(o.id, tikka);
    const [a, b] = await Promise.all([send(o.id), send(o.id)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(
      await t.kdb.selectFrom('kots').select('id').where('order_id', '=', o.id).execute(),
    ).toHaveLength(1);
    await run();
  });

  it('deal components go to the stations of their own items; the deal line itself prints nothing', async () => {
    const dealItem = await mkItem({ name: 'Mini Deal', kind: 'DEAL' }, 90000);
    await api(owner).put(`/items/${dealItem.id}/deal`, {
      slots: [
        { name: 'Main', qty: 1, options: [{ variantId: tikka.variantId, isDefault: true }] },
        { name: 'Bread', qty: 2, options: [{ variantId: naan.variantId }] },
      ],
    });
    const o = await newOrder();
    const added = await add(o.id, dealItem, { qty: 1 });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const res = await send(o.id);
    expect(res.body.kots.map((k: Json) => k.station).sort()).toEqual(['BBQ', 'TANDOOR']);
    expect(res.body.order.items.every((i: Json) => i.status === 'SENT')).toBe(true); // parent too
    await run();
    expect(tandoor.tickets().at(-1)).toContain('2 x Naan');
    expect(tandoor.tickets().at(-1)).toContain('(Mini Deal)');
    expect(bbq.tickets().at(-1)).toContain('1 x Chicken Tikka (Leg)');
  });

  it('with kot.print_on_send off the KOT exists but nothing is queued', async () => {
    await api(owner).put('/settings/kot.print_on_send', { value: false });
    const o = await newOrder();
    await add(o.id, tikka);
    const before = (await jobs()).length;
    const res = await send(o.id);
    expect(res.status).toBe(201);
    expect(res.body.unprinted).toEqual([]);
    expect(res.body.kots[0].printers).toBe(0);
    expect((await jobs()).length).toBe(before);
    await api(owner).put('/settings/kot.print_on_send', { value: true });
  });

  it('lists and shows KOTs with their lines (branch scoped)', async () => {
    const o = await newOrder();
    await add(o.id, karahi, { note: 'boneless' });
    const sent = await send(o.id);
    const kotId = sent.body.kots[0].id;
    const list = await api(captain).get(`/kots?orderId=${o.id}`);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({
      kotNo: sent.body.kots[0].kotNo,
      station: 'BBQ',
      printCount: 1,
    });
    const detail = await api(captain).get(`/kots/${kotId}`);
    expect(detail.body.lines[0]).toMatchObject({
      name: 'Chicken Karahi (Half)',
      note: 'boneless',
      status: 'SENT',
    });
    const other = (await t.login('MANAGER2')).token;
    expect((await api(other).get(`/kots/${kotId}`)).status).toBe(404);
    expect((await api(other).get('/kots')).body.items).toEqual([]);
    await run();
  });
});

describe('cancel tickets (void after send)', () => {
  it('printing a CANCEL ticket on the original station printer with the reason; free voids print nothing', async () => {
    const o = await newOrder();
    const a = await add(o.id, tikka);
    await send(o.id);
    const fresh = await add(o.id, tikka, { qty: 2 });
    await run();
    const printed = bbq.jobs.length;

    // a NEW line voids for free: no ticket
    const free = await api(captain).post(
      `/orders/${o.id}/items/${fresh.body.addedLineId}/void`,
      {},
    );
    expect(free.status).toBe(200);
    await run();
    expect(bbq.jobs.length).toBe(printed);

    // a SENT line needs kot.void + reason and tells the kitchen to stop
    const res = await api(manager).post(`/orders/${o.id}/items/${a.body.addedLineId}/void`, {
      reason: 'customer changed mind',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await run()).toMatchObject({ printed: 1 });
    const ticket = bbq.tickets().at(-1)!;
    expect(ticket).toContain('*** CANCEL ***');
    expect(ticket).toContain('>> VOID <<');
    expect(ticket).toContain('Reason: customer changed mind');
    expect(ticket).toContain('1 x Chicken Tikka (Leg)');
    const kinds = (await jobs()).map((j) => j.kind);
    expect(kinds.at(-1)).toBe('KOT_CANCEL');
  });

  it('voiding a sent deal cancels each component on its own station', async () => {
    const dealItem = await mkItem({ name: 'Void Deal', kind: 'DEAL' }, 90000);
    await api(owner).put(`/items/${dealItem.id}/deal`, {
      slots: [
        { name: 'Main', qty: 1, options: [{ variantId: tikka.variantId, isDefault: true }] },
        { name: 'Bread', qty: 1, options: [{ variantId: naan.variantId }] },
      ],
    });
    const o = await newOrder();
    const added = await add(o.id, dealItem);
    await send(o.id);
    await run();
    const bbqBefore = bbq.jobs.length;
    const tandoorBefore = tandoor.jobs.length;
    const res = await api(manager).post(`/orders/${o.id}/items/${added.body.addedLineId}/void`, {
      reason: 'guest left',
    });
    expect(res.status).toBe(200);
    await run();
    expect(bbq.jobs.length).toBe(bbqBefore + 1);
    expect(tandoor.jobs.length).toBe(tandoorBefore + 1);
    expect(tandoor.tickets().at(-1)).toContain('*** CANCEL ***');
    expect(tandoor.tickets().at(-1)).toContain('Naan');
  });
});

describe('reprint', () => {
  it('needs kot.reprint and a reason; marks REPRINT #n; counts and audits each one', async () => {
    const o = await newOrder();
    await add(o.id, karahi);
    const sent = await send(o.id);
    const kotId = sent.body.kots[0].id;
    await run();

    expect(
      (await api(kitchen).post(`/kots/${kotId}/reprint`, { reason: 'lost ticket' })).status,
    ).toBe(403);
    expect((await api(captain).post(`/kots/${kotId}/reprint`, {})).status).toBe(400);
    expect((await api(captain).post(`/kots/${kotId}/reprint`, { reason: 'x' })).status).toBe(400);

    const r1 = await api(captain).post(`/kots/${kotId}/reprint`, {
      reason: 'ticket fell on the floor',
    });
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    expect(r1.body).toMatchObject({ reprint: 1, station: 'BBQ', printers: 1 });
    await run();
    expect(bbq.tickets().at(-1)).toContain('** REPRINT #1 **');
    const r2 = await api(cashier).post(`/kots/${kotId}/reprint`, {
      reason: 'second copy for the chef',
    });
    expect(r2.body.reprint).toBe(2);
    await run();
    expect(bbq.tickets().at(-1)).toContain('** REPRINT #2 **');
    expect(bbq.tickets().at(-1)).not.toContain('REPRINT #1');

    expect(
      (
        await t.kdb
          .selectFrom('kots')
          .select('print_count')
          .where('id', '=', kotId)
          .executeTakeFirstOrThrow()
      ).print_count,
    ).toBe(3);
    const log = (await audit('KOT_REPRINT')).filter((l) => l.entity_id === kotId);
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ reason: 'ticket fell on the floor', entity: 'kot' });
    expect(log[1]!.after).toMatchObject({ reprint: 2 });
  });

  it('refuses when the station has no printer or every line was voided', async () => {
    const o = await newOrder();
    await add(o.id, cola);
    const sent = await send(o.id);
    const res = await api(captain).post(`/kots/${sent.body.kots[0].id}/reprint`, {
      reason: 'need a copy',
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_PRINTER');

    const o2 = await newOrder();
    const line = await add(o2.id, tikka);
    const sent2 = await send(o2.id);
    await api(manager).post(`/orders/${o2.id}/items/${line.body.addedLineId}/void`, {
      reason: 'wrong order',
    });
    const empty = await api(captain).post(`/kots/${sent2.body.kots[0].id}/reprint`, {
      reason: 'need a copy',
    });
    expect(empty.body.code).toBe('NOTHING_TO_SEND');
    await run();
    expect(
      (
        await api(captain).post('/kots/00000000-0000-4000-8000-000000000000/reprint', {
          reason: 'need a copy',
        })
      ).status,
    ).toBe(404);
  });
});

describe('printer unplugged: queue, retry with backoff, drain in order, no duplicates', () => {
  it('jobs wait while the printer is down and print exactly once, in order, when it is back', async () => {
    await bbq.unplug();
    const baseline = bbq.jobs.length;

    const o1 = await newOrder();
    await add(o1.id, tikka, { qty: 1 });
    await send(o1.id);
    const o2 = await newOrder();
    await add(o2.id, karahi, { qty: 1 });
    await send(o2.id);
    const kotNos = (
      await t.kdb.selectFrom('kots').select('kot_no').orderBy('kot_no', 'desc').limit(2).execute()
    )
      .map((k) => k.kot_no)
      .reverse();

    // first pass: the head job fails; the second is NOT attempted (it must not overtake)
    const r1 = await run();
    expect(r1).toMatchObject({ printed: 0, failed: 1 });
    const queued = await jobs({ printer: P.bbq });
    const pending = queued.filter((j) => j.status !== 'DONE');
    expect(pending.map((j) => j.status)).toEqual(['FAILED', 'PENDING']);
    expect(pending[0]).toMatchObject({ attempts: 1 });
    expect(pending[0]!.last_error).toMatch(/ECONNREFUSED|refused/i);
    expect(pending[0]!.next_attempt_at.getTime()).toBe(t.clock.now().getTime() + 2000);
    expect(pending[1]).toMatchObject({ attempts: 0 });

    // health shows the printer offline and the queue length (counter staff can see this)
    const health = (await api(cashier).get('/printers/health')).body.items.find(
      (p: Json) => p.id === P.bbq,
    );
    expect(health).toMatchObject({ state: 'OFFLINE', queued: 2, dead: 0 });
    expect(health.lastError).toBeTruthy();

    // before the backoff expires nothing is attempted
    expect(await run()).toMatchObject({ printed: 0, failed: 0 });
    expect((await jobs({ printer: P.bbq })).find((j) => j.id === pending[0]!.id)!.attempts).toBe(1);

    // back online, backoff over → drained in creation order, once each
    await bbq.plug();
    t.clock.advance(2500);
    expect(await run()).toMatchObject({ printed: 2, failed: 0 });
    expect(bbq.jobs.length).toBe(baseline + 2);
    const tickets = bbq.tickets().slice(baseline);
    expect(tickets[0]).toContain(`KOT #${kotNos[0]}`);
    expect(tickets[1]).toContain(`KOT #${kotNos[1]}`);
    expect(await run()).toMatchObject({ printed: 0 }); // nothing is printed twice
    expect(bbq.jobs.length).toBe(baseline + 2);

    const healthAfter = (await api(cashier).get('/printers/health')).body.items.find(
      (p: Json) => p.id === P.bbq,
    );
    expect(healthAfter).toMatchObject({ state: 'OK', queued: 0, lastError: null });
  });

  it('keeps retrying with growing delays while the printer stays down', async () => {
    await bbq.unplug();
    const o = await newOrder();
    await add(o.id, tikka);
    await send(o.id);
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      await run();
      const j = (await jobs({ printer: P.bbq, status: 'FAILED' }))[0]!;
      delays.push(j.next_attempt_at.getTime() - t.clock.now().getTime());
      t.clock.advance(j.next_attempt_at.getTime() - t.clock.now().getTime());
    }
    expect(delays).toEqual([2000, 4000, 8000, 16000, 30000]);
    await bbq.plug();
    expect(await run()).toMatchObject({ printed: 1 });
  });

  it('printers are independent: one being down does not hold back another', async () => {
    await tandoor.unplug();
    const o = await newOrder();
    await add(o.id, tikka);
    await add(o.id, naan);
    await send(o.id);
    const bbqBefore = bbq.jobs.length;
    const r = await run();
    expect(r).toMatchObject({ printed: 1, failed: 1 });
    expect(bbq.jobs.length).toBe(bbqBefore + 1);
    await tandoor.plug();
    t.clock.advance(3000);
    expect(await run()).toMatchObject({ printed: 1 });
  });

  it('two workers running at once never print the same ticket twice', async () => {
    const before = bbq.jobs.length;
    for (let i = 0; i < 5; i++) {
      const o = await newOrder();
      await add(o.id, tikka, { qty: i + 1 });
      await send(o.id);
    }
    const [a, b, c] = await Promise.all([run(), run(), run()]);
    expect(a.printed + b.printed + c.printed).toBe(5);
    expect(bbq.jobs.length).toBe(before + 5);
    const quantities = bbq
      .tickets()
      .slice(before)
      .map((tk) => /(\d) x Chicken Tikka/.exec(tk)![1]);
    expect(quantities).toEqual(['1', '2', '3', '4', '5']); // and in order
  });

  it('creating the same job twice is a no-op (idempotency key)', async () => {
    const job = {
      branchId: t.branchId,
      printerId: P.bbq!,
      kind: 'TEST' as const,
      refType: null,
      refId: null,
      title: 'test page',
      payload: new Uint8Array([0x1b, 0x40]),
      idempotencyKey: 'test-page-1',
      createdBy: null,
      at: t.clock.now(),
    };
    expect(await enqueuePrintJob(t.kdb, job)).toBe(true);
    expect(await enqueuePrintJob(t.kdb, job)).toBe(false);
    await run();
    expect((await jobs()).filter((j) => j.idempotency_key === 'test-page-1')).toHaveLength(1);
  });

  it('recovers a job whose worker died (expired lease) and prints it once', async () => {
    const o = await newOrder();
    await add(o.id, tikka, { qty: 7 });
    await send(o.id);
    const [job] = await jobs({ status: 'PENDING', printer: P.bbq });
    await t.kdb
      .updateTable('print_jobs')
      .set({
        status: 'IN_FLIGHT',
        attempts: 1,
        lease_until: new Date(t.clock.now().getTime() - 1000),
      })
      .where('id', '=', job!.id)
      .execute();
    const before = bbq.jobs.length;
    expect(await run()).toMatchObject({ printed: 1 });
    expect(bbq.jobs.length).toBe(before + 1);
    expect(bbq.tickets().at(-1)).toContain('7 x Chicken Tikka');
  });

  it('a live lease blocks the successors (order is kept) until it expires', async () => {
    const o1 = await newOrder();
    await add(o1.id, tikka, { qty: 8 });
    await send(o1.id);
    const o2 = await newOrder();
    await add(o2.id, tikka, { qty: 9 });
    await send(o2.id);
    const [head] = await jobs({ status: 'PENDING', printer: P.bbq });
    await t.kdb
      .updateTable('print_jobs')
      .set({ status: 'IN_FLIGHT', lease_until: new Date(t.clock.now().getTime() + 20_000) })
      .where('id', '=', head!.id)
      .execute();
    const before = bbq.jobs.length;
    expect(await run()).toMatchObject({ printed: 0 });
    expect(bbq.jobs.length).toBe(before);
    t.clock.advance(31_000);
    expect(await run()).toMatchObject({ printed: 2 });
    expect(
      bbq
        .tickets()
        .slice(before)
        .map((tk) => /(\d) x Chicken Tikka/.exec(tk)![1]),
    ).toEqual(['8', '9']);
  });

  it('two printers for one station both get a copy; a backup that is off does not stop the main one', async () => {
    await mapStation('BBQ', [P.bbq!, P.backup!]);
    await bbqBackup.unplug();
    const o = await newOrder();
    await add(o.id, tikka, { qty: 6 });
    const res = await send(o.id);
    expect(res.body.kots[0].printers).toBe(2);
    const main = bbq.jobs.length;
    expect(await run()).toMatchObject({ printed: 1, failed: 1 });
    expect(bbq.jobs.length).toBe(main + 1);
    await bbqBackup.plug();
    t.clock.advance(3000);
    await run();
    expect(bbqBackup.tickets().at(-1)).toContain('6 x Chicken Tikka');
    await mapStation('BBQ', [P.bbq!]);
  });
});

describe('dead jobs, misconfiguration and the admin view', () => {
  it('parks a ticket that is too old to be useful as DEAD, and lets an admin re-queue it', async () => {
    await bbq.unplug();
    const o = await newOrder();
    await add(o.id, tikka, { qty: 5 });
    await send(o.id);
    t.clock.advance(MAX_JOB_AGE_MS + 60_000);
    owner = (await t.login('OWNER')).token; // access tokens last 15 minutes
    captain = (await t.login('CAPTAIN')).token;
    cashier = (await t.login('CASHIER')).token;
    manager = (await t.login('MANAGER')).token;
    const r = await run();
    expect(r).toMatchObject({ printed: 0, dead: 1 });
    const [dead] = await jobs({ status: 'DEAD', printer: P.bbq });
    expect(dead!.last_error).toContain('gave up');

    const list = await api(owner).get('/print-jobs?status=DEAD');
    expect(list.body.items.map((j: Json) => j.id)).toContain(dead!.id);
    expect(list.body.items[0].payload).toBeUndefined(); // bytes are not exposed
    expect((await api(captain).get('/print-jobs')).status).toBe(403);
    expect((await api(captain).post(`/print-jobs/${dead!.id}/retry`)).status).toBe(403);

    await bbq.plug();
    const retry = await api(owner).post(`/print-jobs/${dead!.id}/retry`);
    expect(retry.body.status).toBe('PENDING');
    expect(await run()).toMatchObject({ printed: 1 });
    expect(bbq.tickets().at(-1)).toContain('5 x Chicken Tikka');
    expect((await audit('PRINT_JOB_RETRY')).length).toBe(1);
    expect((await api(owner).post(`/print-jobs/${dead!.id}/retry`)).status).toBe(404); // already printed
  });

  it('unsupported connection types and deactivated printers go DEAD at once and do not block others', async () => {
    const usb = (
      await api(owner).post('/printers', { name: 'USB kitchen', kind: 'KOT', conn_type: 'USB' })
    ).body.id;
    await mapStation('COLD', [usb]);
    const o = await newOrder();
    await add(o.id, await mkItem({ name: 'Cold Dish', stationId: S.COLD }));
    await add(o.id, tikka);
    await send(o.id);
    const before = bbq.jobs.length;
    const r = await run();
    expect(r).toMatchObject({ printed: 1, dead: 1 });
    expect(bbq.jobs.length).toBe(before + 1);
    const [usbJob] = await jobs({ printer: usb });
    expect(usbJob).toMatchObject({ status: 'DEAD' });
    expect(usbJob!.last_error).toContain('unsupported connection');

    await api(owner).patch(`/printers/${P.tandoor}`, { is_active: false });
    const o2 = await newOrder();
    await add(o2.id, naan);
    const sent = await send(o2.id);
    expect(sent.body.unprinted).toEqual(['TANDOOR']); // an inactive printer is not a target at all
    await api(owner).patch(`/printers/${P.tandoor}`, { is_active: true });
  });

  it('reports printer health: UNKNOWN before use, OK after a print, INACTIVE when switched off', async () => {
    const fresh = await SimPrinter.start();
    const id = await addPrinter('Spare', fresh);
    const state = async () =>
      (await api(cashier).get('/printers/health')).body.items.find((p: Json) => p.id === id).state;
    expect(await state()).toBe('UNKNOWN');
    await api(owner).patch(`/printers/${id}`, { is_active: false });
    expect(await state()).toBe('INACTIVE');
    await api(owner).patch(`/printers/${id}`, { is_active: true });
    await fresh.unplug();
  });

  it('lists jobs for admins with filters', async () => {
    const all = await api(owner).get('/print-jobs?limit=5');
    expect(all.body.items.length).toBeLessThanOrEqual(5);
    expect((await api(owner).get('/print-jobs?status=BOGUS')).status).toBe(400);
    const done = await api(owner).get(`/print-jobs?status=DONE&printerId=${P.bbq}`);
    expect(done.body.items.every((j: Json) => j.status === 'DONE' && j.printer_id === P.bbq)).toBe(
      true,
    );
  });
});

describe('database guarantees', () => {
  it('print history cannot be deleted', async () => {
    const [job] = await jobs({ status: 'DONE' });
    await expect(
      t.kdb.deleteFrom('print_jobs').where('id', '=', job!.id).execute(),
    ).rejects.toMatchObject({ code: '23001' });
  });
});

describe('print test page', () => {
  it('queues a test page for an active printer (settings.manage) and it prints', async () => {
    const before = bbq.jobs.length;
    const res = await api(owner).post(`/printers/${P.bbq}/test`);
    expect(res.status).toBe(202);
    expect(await run()).toMatchObject({ printed: 1 });
    expect(bbq.jobs.length).toBe(before + 1);
    expect(bbq.tickets().at(-1)).toContain('TEST PAGE');
    expect(bbq.tickets().at(-1)).toContain('BBQ printer');
    expect((await jobs()).at(-1)).toMatchObject({ kind: 'TEST', status: 'DONE' });
  });

  it('is refused for staff without settings.manage, unknown printers and deactivated printers', async () => {
    expect((await api(captain).post(`/printers/${P.bbq}/test`)).status).toBe(403);
    expect(
      (await api(owner).post('/printers/00000000-0000-4000-8000-000000000000/test')).status,
    ).toBe(404);
    await api(owner).patch(`/printers/${P.backup}`, { is_active: false });
    expect((await api(owner).post(`/printers/${P.backup}/test`)).status).toBe(404);
    await api(owner).patch(`/printers/${P.backup}`, { is_active: true });
  });
});
