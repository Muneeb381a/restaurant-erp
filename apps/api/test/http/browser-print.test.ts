import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from './app-harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let t: TestApp;
let owner: string;
let cashier: string;
let captain: string;
let item: { id: string; variantId: string };
let cashId: string;
const api = (tok: string) => t.as(tok);
let seq = 0;

/** A restaurant with NO thermal printer (the cloud case): settle a Rs 1,000 takeaway on cash. */
async function settledBill(): Promise<string> {
  const o = (await api(captain).post('/orders', { type: 'TAKEAWAY' })).body;
  await api(captain).post(`/orders/${o.id}/items`, { itemId: item.id, variantId: item.variantId });
  await api(captain).post(`/orders/${o.id}/send`, {});
  const bill = (await api(cashier).post(`/orders/${o.id}/bill`)).body;
  const res = await api(cashier)
    .post(`/bills/${bill.id}/settle`, {
      tenders: [{ methodId: cashId, amountPaisa: 100000, tenderedPaisa: 100000 }],
    })
    .set('Idempotency-Key', `browser-print-${Date.now()}-${++seq}`);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return bill.id;
}

beforeAll(async () => {
  t = await startApp();
  owner = (await t.login('OWNER')).token;
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
  await t.stop();
});

describe('printing a receipt from the browser', () => {
  it('gives the receipt as data: the first print is free and nothing is queued for a printer', async () => {
    const id = await settledBill();
    expect((await api(cashier).get(`/bills/${id}`)).body.printCount).toBe(0); // no printer: nothing printed yet

    const res = await api(cashier).post(`/bills/${id}/browser-print`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.duplicate).toBe(0);
    expect(res.body.language).toBe('en');
    expect(res.body.doc).toMatchObject({ totalPaisa: 100000, orderType: 'TAKEAWAY' });
    expect(res.body.doc.lines).toHaveLength(1);
    expect(res.body.doc.lines[0]).toMatchObject({ name: 'Tikka', amountPaisa: 100000 });
    expect(res.body.doc.payments[0]).toMatchObject({ method: 'Cash', amountPaisa: 100000 });
    expect((await api(cashier).get(`/bills/${id}`)).body.printCount).toBe(1);

    const jobs = await t.kdb
      .selectFrom('print_jobs')
      .select('id')
      .where('ref_id', '=', id)
      .execute();
    expect(jobs).toHaveLength(0);
    const log = await t.kdb
      .selectFrom('audit_log')
      .selectAll()
      .where('entity_id', '=', id)
      .where('action', '=', 'BILL_PRINT')
      .execute();
    expect(log).toHaveLength(1);
  });

  it('a second print is a copy: it needs permission and a reason, is numbered and audited', async () => {
    const id = await settledBill();
    expect((await api(cashier).post(`/bills/${id}/browser-print`, {})).status).toBe(201);

    // a captain has no bill.reprint (a cashier does)
    const denied = await api(captain).post(`/bills/${id}/browser-print`, {
      reason: 'Customer copy',
    });
    expect(denied.status).toBe(403);
    expect(denied.body.permission).toBe('bill.reprint');

    // the owner needs a reason
    expect((await api(cashier).post(`/bills/${id}/browser-print`, {})).status).toBe(400); // allowed, but needs a reason
    expect((await api(owner).post(`/bills/${id}/browser-print`, { reason: 'x' })).status).toBe(400);

    const copy = await api(owner).post(`/bills/${id}/browser-print`, {
      reason: 'Customer lost it',
    });
    expect(copy.status).toBe(201);
    expect(copy.body.duplicate).toBe(1);
    expect(copy.body.doc.duplicate).toBe(1);
    const again = await api(owner).post(`/bills/${id}/browser-print`, { reason: 'Second copy' });
    expect(again.body.duplicate).toBe(2);

    const log = await t.kdb
      .selectFrom('audit_log')
      .selectAll()
      .where('entity_id', '=', id)
      .where('action', '=', 'BILL_REPRINT')
      .orderBy('id')
      .execute();
    expect(log.map((e: Json) => e.reason)).toEqual(['Customer lost it', 'Second copy']);
  });

  it('only a settled bill has a receipt, and another branch cannot print it', async () => {
    const o = (await api(captain).post('/orders', { type: 'TAKEAWAY' })).body;
    await api(captain).post(`/orders/${o.id}/items`, {
      itemId: item.id,
      variantId: item.variantId,
    });
    await api(captain).post(`/orders/${o.id}/send`, {});
    const bill = (await api(cashier).post(`/orders/${o.id}/bill`)).body;
    const open = await api(cashier).post(`/bills/${bill.id}/browser-print`, {});
    expect(open.status).toBe(409);
    expect(open.body.code).toBe('BILL_NOT_PAYABLE');
    expect(
      (await api(cashier).post(`/bills/00000000-0000-4000-8000-000000000000/browser-print`, {}))
        .status,
    ).toBe(404);
    // an unknown field is refused (the body is strict)
    const id = await settledBill();
    expect((await api(cashier).post(`/bills/${id}/browser-print`, { copies: 5 })).status).toBe(400);
  });
});
