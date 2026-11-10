import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from './app-harness';

// The order view is asserted structurally; its shape is loose JSON here.
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
const TABLE: Record<string, string> = {};

const api = (tok: string) => t.as(tok);
const audit = (action: string, entityId?: string) => {
  let q = t.kdb.selectFrom('audit_log').selectAll().where('action', '=', action).orderBy('id');
  if (entityId) q = q.where('entity_id', '=', entityId);
  return q.execute();
};
const setStatus = (lineId: string, status: string) =>
  t.kdb.updateTable('order_items').set({ status }).where('id', '=', lineId).execute();

interface Fixture {
  id: string;
  variantId: string;
  variants: { id: string; name: string }[];
}
async function mkItem(
  body: Record<string, unknown>,
  prices: Record<string, number> = { DINE_IN: 50000, TAKEAWAY: 50000, DELIVERY: 50000 },
): Promise<Fixture> {
  const res = await api(owner).post('/items', { kind: 'STANDARD', ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  for (const [list, paisa] of Object.entries(prices)) {
    const p = await api(owner).put(`/variants/${res.body.variants[0].id}/prices/${L[list]}`, {
      pricePaisa: paisa,
    });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
  }
  return { id: res.body.id, variantId: res.body.variants[0].id, variants: res.body.variants };
}

async function newOrder(
  type: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY' = 'TAKEAWAY',
  table?: string,
  tok = captain,
): Promise<Json> {
  const res = await api(tok).post('/orders', { type, ...(table ? { tableId: TABLE[table] } : {}) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}
const add = (
  tok: string,
  orderId: string,
  item: Fixture,
  extra: Record<string, unknown> = {},
  variantId = item.variantId,
) => api(tok).post(`/orders/${orderId}/items`, { itemId: item.id, variantId, ...extra });
const getOrder = async (id: string): Promise<Json> =>
  (await api(captain).get(`/orders/${id}`)).body;

let tikka: Fixture;
let karahi: Fixture;
let chops: Fixture;
let spicy: Fixture;
let spiceMods: { mild: string; hot: string };
let deal: Fixture;
let dealParts: {
  karahiHalf: string;
  karahiFull: string;
  naan: string;
  cola: string;
  sprite: string;
};

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
  S.BBQ = (await api(owner).post('/stations', { code: 'BBQ', name: 'BBQ' })).body.id;
  S.TANDOOR = (await api(owner).post('/stations', { code: 'TANDOOR', name: 'Tandoor' })).body.id;
  for (const code of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9'])
    TABLE[code] = (await api(owner).post('/tables', { code, seats: 4 })).body.id;

  tikka = await mkItem({ name: 'Chicken Tikka', nameUr: 'چکن تکہ', stationId: S.BBQ });
  karahi = await mkItem(
    { name: 'Chicken Karahi', variants: [{ name: 'Half' }, { name: 'Full' }] },
    { DINE_IN: 110000, TAKEAWAY: 110000, DELIVERY: 110000 },
  );
  await api(owner).put(`/variants/${karahi.variants[1]!.id}/prices/${L.DINE_IN}`, {
    pricePaisa: 210000,
  });
  await api(owner).put(`/variants/${karahi.variants[1]!.id}/prices/${L.TAKEAWAY}`, {
    pricePaisa: 210000,
  });
  chops = await mkItem(
    { name: 'Mutton Chops', kind: 'WEIGHT' },
    { DINE_IN: 480000, TAKEAWAY: 480000, DELIVERY: 480000 },
  );

  spicy = await mkItem(
    { name: 'Spicy Boti' },
    { DINE_IN: 80000, TAKEAWAY: 80000, DELIVERY: 80000 },
  );
  const g = (
    await api(owner).post('/modifier-groups', {
      code: 'SPICE',
      name: 'Spice',
      minSelect: 1,
      maxSelect: 1,
    })
  ).body;
  const mild = (
    await api(owner).post(`/modifier-groups/${g.id}/modifiers`, {
      name: 'Mild',
      priceDeltaPaisa: 0,
    })
  ).body;
  const hot = (
    await api(owner).post(`/modifier-groups/${g.id}/modifiers`, {
      name: 'Extra hot',
      priceDeltaPaisa: 5000,
    })
  ).body;
  spiceMods = { mild: mild.id, hot: hot.id };
  await api(owner).put(`/items/${spicy.id}/modifier-groups`, { groupIds: [g.id] });

  const naan = await mkItem(
    { name: 'Naan', stationId: S.TANDOOR },
    { DINE_IN: 3000, TAKEAWAY: 3000, DELIVERY: 3000 },
  );
  const cola = await mkItem({ name: 'Cola' }, { DINE_IN: 8000, TAKEAWAY: 8000, DELIVERY: 8000 });
  const sprite = await mkItem(
    { name: 'Sprite' },
    { DINE_IN: 8000, TAKEAWAY: 8000, DELIVERY: 8000 },
  );
  deal = await mkItem(
    { name: 'Family Deal', kind: 'DEAL' },
    { DINE_IN: 400000, TAKEAWAY: 400000, DELIVERY: 400000 },
  );
  dealParts = {
    karahiHalf: karahi.variants[0]!.id,
    karahiFull: karahi.variants[1]!.id,
    naan: naan.variantId,
    cola: cola.variantId,
    sprite: sprite.variantId,
  };
  const d = await api(owner).put(`/items/${deal.id}/deal`, {
    slots: [
      {
        name: 'Karahi',
        qty: 1,
        options: [
          { variantId: dealParts.karahiHalf, isDefault: true },
          { variantId: dealParts.karahiFull, priceDeltaPaisa: 30000 },
        ],
      },
      { name: 'Naan', qty: 4, options: [{ variantId: dealParts.naan }] },
      {
        name: 'Drinks',
        qty: 2,
        options: [{ variantId: dealParts.cola }, { variantId: dealParts.sprite }],
      },
    ],
  });
  expect(d.status, JSON.stringify(d.body)).toBe(200);
}, 240_000);
afterAll(async () => {
  await t.stop();
});

describe('business day and shift', () => {
  it('no order can be taken before the day is opened; only day.open holders may open it', async () => {
    const res = await api(captain).post('/orders', { type: 'TAKEAWAY' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DAY_NOT_OPEN');
    expect((await api(captain).post('/business-days/open', {})).status).toBe(403);
    expect((await api(cashier).post('/shifts/open', { openingFloatPaisa: 0 })).body.code).toBe(
      'DAY_NOT_OPEN',
    );
    expect((await api(captain).get('/business-days/current')).body).toEqual({ day: null });
  });

  it('opens the day (default = today in the branch timezone), once; audited', async () => {
    const res = await api(cashier).post('/business-days/open', {});
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ businessDate: '2026-08-01', status: 'OPEN' });
    expect((await api(captain).get('/business-days/current')).body.day.businessDate).toBe(
      '2026-08-01',
    );
    const again = await api(manager).post('/business-days/open', {});
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('DAY_ALREADY_OPEN');
    expect(await audit('DAY_OPEN')).toHaveLength(1);
  });

  it('opens one shift per cashier and per till, with a counted float', async () => {
    expect((await api(cashier).post('/shifts/open', { openingFloatPaisa: -5 })).status).toBe(400);
    const s = await api(cashier).post('/shifts/open', { openingFloatPaisa: 500000 });
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    expect(s.body).toMatchObject({ openingFloatPaisa: 500000, status: 'OPEN' });
    expect((await api(cashier).get('/shifts/current')).body.shift.id).toBe(s.body.id);
    expect((await api(captain).get('/shifts/current')).body).toEqual({ shift: null });
    const dup = await api(cashier).post('/shifts/open', { openingFloatPaisa: 0 });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('SHIFT_ALREADY_OPEN');

    const device = (await api(owner).post('/devices', { name: 'Till 1', kind: 'COUNTER' })).body.id;
    expect(
      (await api(manager).post('/shifts/open', { openingFloatPaisa: 0, deviceId: device })).status,
    ).toBe(201);
    const second = await api(owner).post('/shifts/open', {
      openingFloatPaisa: 0,
      deviceId: device,
    });
    expect(second.status).toBe(409);
    expect(second.body.title).toContain('till');
    expect((await audit('SHIFT_OPEN')).length).toBe(2);
  });
});

describe('creating orders and the floor', () => {
  it('numbers orders per day, defaults the price list by type, and returns the version as ETag', async () => {
    const a = await api(captain).post('/orders', { type: 'DINE_IN', tableId: TABLE.T1, guests: 4 });
    expect(a.status).toBe(201);
    expect(a.headers.etag).toBe('"1"');
    expect(a.body).toMatchObject({
      orderNo: 1,
      type: 'DINE_IN',
      status: 'OPEN',
      tableCode: 'T1',
      guests: 4,
      version: 1,
      held: false,
      subtotalPaisa: 0,
    });
    expect(a.body.priceListId).toBe(L.DINE_IN);
    const b = await newOrder('TAKEAWAY');
    expect(b.orderNo).toBe(2);
    expect(b.priceListId).toBe(L.TAKEAWAY);
    expect(b.waiterId).toBeTruthy();
  });

  it('validates type/table combinations, tables, customers and price lists', async () => {
    expect((await api(captain).post('/orders', { type: 'DINE_IN' })).status).toBe(400);
    expect(
      (await api(captain).post('/orders', { type: 'TAKEAWAY', tableId: TABLE.T2 })).status,
    ).toBe(400);
    expect(
      (
        await api(captain).post('/orders', {
          type: 'DINE_IN',
          tableId: '00000000-0000-4000-8000-000000000000',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api(captain).post('/orders', {
          type: 'TAKEAWAY',
          customerId: '00000000-0000-4000-8000-000000000000',
        })
      ).status,
    ).toBe(404);
    expect(
      (await api(captain).post('/orders', { type: 'TAKEAWAY', priceList: 'NOPE' })).status,
    ).toBe(400);
    expect(
      (await api(captain).post('/orders', { type: 'TAKEAWAY', branchId: t.otherBranchId })).status,
    ).toBe(400);
    await api(owner).patch(`/tables/${TABLE.T9}`, { is_active: false });
    expect(
      (await api(captain).post('/orders', { type: 'DINE_IN', tableId: TABLE.T9 })).status,
    ).toBe(404);
    expect((await api(kitchen).post('/orders', { type: 'TAKEAWAY' })).status).toBe(403);
  });

  it('one open order per table: a second order on the same table is refused with the existing order', async () => {
    const first = await newOrder('DINE_IN', 'T2');
    const dup = await api(captain).post('/orders', { type: 'DINE_IN', tableId: TABLE.T2 });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ code: 'TABLE_OCCUPIED', orderId: first.id });
  });

  it('two captains racing for the same table: exactly one wins', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        api(captain).post('/orders', { type: 'DINE_IN', tableId: TABLE.T3 }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409, 409]);
    expect(
      results.filter((r) => r.status === 409).every((r) => r.body.code === 'TABLE_OCCUPIED'),
    ).toBe(true);
    const nos = (
      await t.kdb
        .selectFrom('orders')
        .select('order_no')
        .where('table_id', '=', TABLE.T3!)
        .execute()
    ).length;
    expect(nos).toBe(1); // the losers' transactions rolled back
  });

  it('floor shows live table status with order summary', async () => {
    const o = await newOrder('DINE_IN', 'T4');
    await add(captain, o.id, tikka, { qty: 2 });
    const floor = (await api(captain).get('/floor')).body;
    const t4 = floor.tables.find((x: Json) => x.code === 'T4');
    expect(t4).toMatchObject({
      status: 'OCCUPIED',
      order: { id: o.id, itemCount: 1, subtotalPaisa: 100000, held: false },
    });
    expect(floor.tables.find((x: Json) => x.code === 'T5')).toMatchObject({
      status: 'FREE',
      order: null,
    });
    expect(floor.tables.find((x: Json) => x.code === 'T9')).toBeUndefined(); // inactive tables are not shown
    await t.kdb.updateTable('orders').set({ status: 'BILLED' }).where('id', '=', o.id).execute();
    expect(
      (await api(captain).get('/floor')).body.tables.find((x: Json) => x.code === 'T4').status,
    ).toBe('BILLED');
    await t.kdb.updateTable('orders').set({ status: 'OPEN' }).where('id', '=', o.id).execute();
  });

  it('lists orders by status, type and held', async () => {
    const list = (await api(captain).get('/orders')).body.items;
    expect(list.length).toBeGreaterThan(3);
    expect(list.every((x: Json) => ['OPEN', 'BILLED'].includes(x.status))).toBe(true);
    expect(
      (await api(captain).get('/orders?type=DINE_IN')).body.items.every(
        (x: Json) => x.type === 'DINE_IN',
      ),
    ).toBe(true);
    expect((await api(captain).get('/orders?status=SETTLED')).body.items).toEqual([]);
    expect((await api(captain).get('/orders?status=bogus')).status).toBe(400);
  });
});

describe('adding items: authoritative pricing', () => {
  it('prices a standard line, snapshots names/station/tax and bumps the version', async () => {
    const o = await newOrder();
    const res = await add(captain, o.id, tikka, { qty: 3, note: 'less spicy', course: 2 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const line = res.body.items.find((i: Json) => i.id === res.body.addedLineId);
    expect(line).toMatchObject({
      name: 'Chicken Tikka',
      nameUr: 'چکن تکہ',
      qty: 3,
      unitPricePaisa: 50000,
      lineTotalPaisa: 150000,
      modifiersTotalPaisa: 0,
      status: 'NEW',
      note: 'less spicy',
      course: 2,
      stationId: S.BBQ,
    });
    expect(line.taxCategoryId).toBeTruthy();
    expect(res.body.subtotalPaisa).toBe(150000);
    expect(res.body.version).toBe(2);
    expect(res.headers.etag).toBe('"2"');
  });

  it('snapshots "Item (Variant)" names and uses the order\'s price list', async () => {
    const o = await newOrder('DINE_IN', 'T5');
    const half = await add(captain, o.id, karahi, {}, karahi.variants[0]!.id);
    const full = await add(captain, o.id, karahi, {}, karahi.variants[1]!.id);
    expect(half.body.items[0].name).toBe('Chicken Karahi (Half)');
    expect(full.body.items[1]).toMatchObject({
      name: 'Chicken Karahi (Full)',
      lineTotalPaisa: 210000,
    });
    expect(full.body.subtotalPaisa).toBe(320000);
  });

  it('prices weighed items with integer half-up rounding', async () => {
    const o = await newOrder();
    const res = await add(captain, o.id, chops, { weightG: 750 });
    expect(res.body.items[0]).toMatchObject({
      weightG: 750,
      qty: 1,
      unitPricePaisa: 480000,
      lineTotalPaisa: 360000,
    });
    const odd = await add(captain, o.id, chops, { weightG: 333 }); // 480000 × 333 / 1000 = 159840 exactly
    expect(odd.body.items[1].lineTotalPaisa).toBe(159840);
    expect((await add(captain, o.id, chops)).body.reason).toBe('LINE_WEIGHT_REQUIRED');
    expect((await add(captain, o.id, chops, { weightG: 500, qty: 2 })).body.reason).toBe(
      'LINE_QTY_INVALID',
    );
    expect((await add(captain, o.id, tikka, { weightG: 500 })).body.reason).toBe(
      'LINE_WEIGHT_NOT_ALLOWED',
    );
  });

  it('validates modifiers against the item and adds their delta once per unit', async () => {
    const o = await newOrder();
    expect((await add(captain, o.id, spicy)).body.reason).toBe('MODIFIER_GROUP_MIN'); // spice level is required
    expect(
      (await add(captain, o.id, spicy, { modifierIds: [spiceMods.mild, spiceMods.hot] })).body
        .reason,
    ).toBe('MODIFIER_GROUP_MAX');
    expect((await add(captain, o.id, tikka, { modifierIds: [spiceMods.hot] })).body.reason).toBe(
      'MODIFIER_UNKNOWN',
    );
    const ok = await add(captain, o.id, spicy, { qty: 2, modifierIds: [spiceMods.hot] });
    expect(ok.body.items[0]).toMatchObject({
      qty: 2,
      lineTotalPaisa: 170000,
      modifiersTotalPaisa: 10000,
    });
    expect(ok.body.items[0].modifiers).toEqual([
      expect.objectContaining({ name: 'Extra hot', priceDeltaPaisa: 5000 }),
    ]);
  });

  it('refuses sold-out (86), unpriced-for-this-channel, inactive and foreign items', async () => {
    const o = await newOrder();
    const sold = await mkItem({ name: 'Sold Out' });
    await api(cashier).patch(`/items/${sold.id}/availability`, { isAvailable: false });
    const r1 = await add(captain, o.id, sold);
    expect(r1.status).toBe(409);
    expect(r1.body.code).toBe('ITEM_UNAVAILABLE');

    const dineOnly = await mkItem({ name: 'Dine Only' }, { DINE_IN: 1000 });
    const r2 = await add(captain, o.id, dineOnly); // order is TAKEAWAY
    expect(r2.body.code).toBe('ITEM_NOT_ON_MENU');

    const gone = await mkItem({ name: 'Retired' });
    await api(owner).patch(`/items/${gone.id}`, { isActive: false });
    expect((await add(captain, o.id, gone)).status).toBe(404);
    expect((await add(captain, o.id, tikka, {}, karahi.variantId)).status).toBe(404); // variant of another item
    expect((await add(captain, o.id, tikka, { qty: 0 })).status).toBe(400);
    expect((await add(captain, o.id, tikka, { dealPicks: [] })).status).toBe(400);
  });

  it('keeps the price snapshot: later price changes do not touch lines already on the order', async () => {
    const item = await mkItem({ name: 'Snapshot Item' });
    const o = await newOrder();
    const first = await add(captain, o.id, item);
    await api(owner).put(`/variants/${item.variantId}/prices/${L.TAKEAWAY}`, { pricePaisa: 60000 });
    const second = await add(captain, o.id, item);
    expect(second.body.items.map((i: Json) => i.lineTotalPaisa)).toEqual([50000, 60000]);
    expect(first.body.items[0].unitPricePaisa).toBe(50000);
  });

  it('refuses lines on orders that are billed, cancelled or held', async () => {
    const o = await newOrder();
    await t.kdb.updateTable('orders').set({ status: 'BILLED' }).where('id', '=', o.id).execute();
    expect((await add(captain, o.id, tikka)).body.code).toBe('ORDER_NOT_EDITABLE');
    await t.kdb.updateTable('orders').set({ status: 'OPEN' }).where('id', '=', o.id).execute();
    await api(captain).post(`/orders/${o.id}/hold`);
    expect((await add(captain, o.id, tikka)).body.code).toBe('ORDER_HELD');
  });

  it('other branches cannot see or touch an order', async () => {
    const o = await newOrder();
    const other = (await t.login('MANAGER2')).token;
    expect((await api(other).get(`/orders/${o.id}`)).status).toBe(404);
    expect(
      (
        await api(other).post(`/orders/${o.id}/items`, {
          itemId: tikka.id,
          variantId: tikka.variantId,
        })
      ).status,
    ).toBe(404);
  });
});

describe('deals on an order', () => {
  it('fixed components and a required choice: picks are validated and the price is allocated', async () => {
    const o = await newOrder();
    const missing = await add(captain, o.id, deal); // drinks need a real choice
    expect(missing.status).toBe(400);
    expect(missing.body.reason).toBe('DEAL_SLOT_COUNT');

    const slots = (await api(owner).get(`/items/${deal.id}`)).body.deal.slots;
    const opt = (slot: string, variant: string) => {
      const s = slots.find((x: Json) => x.name === slot);
      return { slotId: s.id, optionId: s.options.find((x: Json) => x.variantId === variant).id };
    };
    const picks = [
      { ...opt('Karahi', dealParts.karahiFull), count: 1 },
      { ...opt('Naan', dealParts.naan), count: 4 },
      { ...opt('Drinks', dealParts.cola), count: 1 },
      { ...opt('Drinks', dealParts.sprite), count: 1 },
    ];
    const res = await add(captain, o.id, deal, { dealPicks: picks });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const parent = res.body.items.find((i: Json) => i.id === res.body.addedLineId);
    const kids = res.body.items.filter((i: Json) => i.parentId === parent.id);
    expect(parent).toMatchObject({
      name: 'Family Deal',
      unitPricePaisa: 400000,
      lineTotalPaisa: 430000,
    }); // + Rs 300 for the full karahi
    expect(kids).toHaveLength(4);
    expect(kids.every((k: Json) => k.unitPricePaisa === 0 && k.status === 'NEW')).toBe(true);
    expect(kids.reduce((n: number, k: Json) => n + k.lineTotalPaisa, 0)).toBe(430000); // allocation adds up
    expect(kids.find((k: Json) => k.name === 'Naan').qty).toBe(4);
    expect(kids.find((k: Json) => k.name === 'Naan').stationId).toBe(S.TANDOOR); // KOT routing follows the component
    expect(res.body.subtotalPaisa).toBe(430000); // components are not counted twice

    // changing the deal quantity scales components and re-allocates
    const doubled = await api(captain).patch(`/orders/${o.id}/items/${parent.id}`, { qty: 2 });
    expect(doubled.body.subtotalPaisa).toBe(860000);
    const kids2 = doubled.body.items.filter((i: Json) => i.parentId === parent.id);
    expect(kids2.find((k: Json) => k.name === 'Naan').qty).toBe(8);
    expect(kids2.reduce((n: number, k: Json) => n + k.lineTotalPaisa, 0)).toBe(860000);

    // voiding the deal voids its components; they cannot be edited on their own
    expect(
      (await api(captain).patch(`/orders/${o.id}/items/${kids[0].id}`, { qty: 3 })).status,
    ).toBe(404);
    const voided = await api(captain).post(`/orders/${o.id}/items/${parent.id}/void`, {});
    expect(voided.body.items.every((i: Json) => i.status === 'VOID')).toBe(true);
    expect(voided.body.subtotalPaisa).toBe(0);
  });

  it('rejects wrong picks and sold-out components', async () => {
    const o = await newOrder();
    const slots = (await api(owner).get(`/items/${deal.id}`)).body.deal.slots;
    const naanSlot = slots.find((x: Json) => x.name === 'Naan');
    const bad = await add(captain, o.id, deal, {
      dealPicks: [{ slotId: naanSlot.id, optionId: naanSlot.options[0].id, count: 3 }],
    });
    expect(bad.body.reason).toBe('DEAL_SLOT_COUNT');
    const colaItem = (await api(owner).get('/items')).body.items.find(
      (i: Json) => i.name === 'Cola',
    );
    await api(cashier).patch(`/items/${colaItem.id}/availability`, { isAvailable: false });
    const drinks = slots.find((x: Json) => x.name === 'Drinks');
    const picks = [
      ...slots
        .filter((s: Json) => s.name !== 'Drinks')
        .map((s: Json) => ({
          slotId: s.id,
          optionId: (s.options.find((x: Json) => x.isDefault) ?? s.options[0]).id,
          count: s.qty,
        })),
      {
        slotId: drinks.id,
        optionId: drinks.options.find((x: Json) => x.variantId === dealParts.cola).id,
        count: 2,
      },
    ];
    expect((await add(captain, o.id, deal, { dealPicks: picks })).body.code).toBe(
      'ITEM_UNAVAILABLE',
    );
    await api(cashier).patch(`/items/${colaItem.id}/availability`, { isAvailable: true });
  });
});

describe('optimistic locking and concurrency', () => {
  it('If-Match is optional for items but must match when sent; the conflict says what is current', async () => {
    const o = await newOrder();
    const ok = await api(captain)
      .post(`/orders/${o.id}/items`, { itemId: tikka.id, variantId: tikka.variantId })
      .set('If-Match', '"1"');
    expect(ok.status).toBe(201);
    const stale = await api(captain)
      .post(`/orders/${o.id}/items`, { itemId: tikka.id, variantId: tikka.variantId })
      .set('If-Match', '1');
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: 2 });
    expect(
      (
        await api(captain)
          .post(`/orders/${o.id}/items`, { itemId: tikka.id, variantId: tikka.variantId })
          .set('If-Match', 'abc')
      ).status,
    ).toBe(400);
  });

  it('ten parallel adds to one order all succeed, serialised by the row lock (no lost updates)', async () => {
    const o = await newOrder();
    const results = await Promise.all(Array.from({ length: 10 }, () => add(captain, o.id, tikka)));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const final = await getOrder(o.id);
    expect(final.items).toHaveLength(10);
    expect(final.subtotalPaisa).toBe(500000);
    expect(final.version).toBe(11);
  });

  it('structural changes require If-Match (428 without it)', async () => {
    const o = await newOrder('DINE_IN', 'T6');
    const res = await api(captain).post(`/orders/${o.id}/transfer`, { tableId: TABLE.T7 });
    expect(res.status).toBe(428);
    expect(res.body.code).toBe('PRECONDITION_REQUIRED');
    expect((await api(captain).patch(`/orders/${o.id}`, { guests: 3 })).status).toBe(428);
    const ok = await api(captain)
      .patch(`/orders/${o.id}`, { guests: 3, notes: 'birthday' })
      .set('If-Match', String(o.version));
    expect(ok.body).toMatchObject({ guests: 3, notes: 'birthday', version: o.version + 1 });
    expect(
      (
        await api(captain)
          .patch(`/orders/${o.id}`, { guests: 5 })
          .set('If-Match', String(o.version))
      ).body.code,
    ).toBe('VERSION_CONFLICT');
    expect((await api(captain).patch(`/orders/${o.id}`, {}).set('If-Match', '2')).status).toBe(400);
  });
});

describe('editing and voiding lines', () => {
  it('edits quantity, notes, course and modifiers of NEW lines and reprices them', async () => {
    const o = await newOrder();
    const a = await add(captain, o.id, spicy, { qty: 2, modifierIds: [spiceMods.mild] });
    const lineId = a.body.addedLineId;
    const up = await api(captain).patch(`/orders/${o.id}/items/${lineId}`, {
      qty: 5,
      note: 'no onion',
      course: 3,
    });
    expect(up.body.items[0]).toMatchObject({
      qty: 5,
      lineTotalPaisa: 400000,
      note: 'no onion',
      course: 3,
    });
    const hot = await api(captain).patch(`/orders/${o.id}/items/${lineId}`, {
      modifierIds: [spiceMods.hot],
    });
    expect(hot.body.items[0]).toMatchObject({ lineTotalPaisa: 425000, modifiersTotalPaisa: 25000 });
    expect(hot.body.items[0].modifiers.map((m: Json) => m.name)).toEqual(['Extra hot']);
    expect(
      (await api(captain).patch(`/orders/${o.id}/items/${lineId}`, { modifierIds: [] })).body
        .reason,
    ).toBe('MODIFIER_GROUP_MIN');
    expect(
      (await api(captain).patch(`/orders/${o.id}/items/${lineId}`, { weightG: 100 })).status,
    ).toBe(400);
    expect(hot.body.subtotalPaisa).toBe(425000);
  });

  it('re-weighs a weighed line', async () => {
    const o = await newOrder();
    const a = await add(captain, o.id, chops, { weightG: 500 });
    const w = await api(captain).patch(`/orders/${o.id}/items/${a.body.addedLineId}`, {
      weightG: 1250,
    });
    expect(w.body.items[0]).toMatchObject({ weightG: 1250, lineTotalPaisa: 600000 });
    expect(
      (await api(captain).patch(`/orders/${o.id}/items/${a.body.addedLineId}`, { qty: 2 })).status,
    ).toBe(400);
  });

  it('lines already sent to the kitchen cannot be edited', async () => {
    const o = await newOrder();
    const a = await add(captain, o.id, tikka);
    await setStatus(a.body.addedLineId, 'SENT');
    const res = await api(captain).patch(`/orders/${o.id}/items/${a.body.addedLineId}`, { qty: 2 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ITEM_NOT_EDITABLE');
  });

  it('voiding a NEW line is free; voiding twice is refused', async () => {
    const o = await newOrder();
    const a = await add(captain, o.id, tikka, { qty: 2 });
    const v = await api(captain).post(`/orders/${o.id}/items/${a.body.addedLineId}/void`, {});
    expect(v.body.items[0]).toMatchObject({ status: 'VOID', voidReason: 'Removed before sending' });
    expect(v.body.subtotalPaisa).toBe(0);
    expect(
      (await api(captain).post(`/orders/${o.id}/items/${a.body.addedLineId}/void`, {})).body.code,
    ).toBe('ITEM_NOT_EDITABLE');
    expect(await audit('ITEM_VOID_AFTER_SEND', o.id)).toHaveLength(0); // free voids are not sensitive
  });

  it('voiding after the kitchen saw it needs kot.void + a reason, is audited, and flags wastage once prepared', async () => {
    const o = await newOrder();
    const a = await add(captain, o.id, tikka);
    const b = await add(captain, o.id, tikka);
    await setStatus(a.body.addedLineId, 'SENT');
    await setStatus(b.body.addedLineId, 'PREPARING');

    const denied = await api(captain).post(`/orders/${o.id}/items/${a.body.addedLineId}/void`, {
      reason: 'customer changed mind',
    });
    expect(denied.status).toBe(403);
    expect(denied.body.permission).toBe('kot.void');
    expect(
      (await api(manager).post(`/orders/${o.id}/items/${a.body.addedLineId}/void`, {})).status,
    ).toBe(400); // no reason
    expect(
      (
        await api(manager).post(`/orders/${o.id}/items/${a.body.addedLineId}/void`, {
          reason: 'ab',
        })
      ).status,
    ).toBe(400);

    const ok = await api(manager).post(`/orders/${o.id}/items/${a.body.addedLineId}/void`, {
      reason: 'customer changed mind',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.items.find((i: Json) => i.id === a.body.addedLineId)).toMatchObject({
      status: 'VOID',
      voidReason: 'customer changed mind',
    });
    await api(manager).post(`/orders/${o.id}/items/${b.body.addedLineId}/void`, {
      reason: 'dropped on floor',
    });

    const rows = await audit('ITEM_VOID_AFTER_SEND', o.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ reason: 'customer changed mind', entity: 'order' });
    expect(rows[0]!.before).toMatchObject({ status: 'SENT', name: 'Chicken Tikka' });
    expect(rows[0]!.after).toMatchObject({ status: 'VOID', wastage: false });
    expect(rows[1]!.after).toMatchObject({ wastage: true });
    expect(rows[1]!.user_id).toBeTruthy();
  });
});

describe('hold and resume', () => {
  it('parks an order, lists it under held, and resumes it; both calls are idempotent', async () => {
    const o = await newOrder();
    const held = await api(captain).post(`/orders/${o.id}/hold`);
    expect(held.body.held).toBe(true);
    const v = held.body.version;
    expect((await api(captain).post(`/orders/${o.id}/hold`)).body.version).toBe(v); // no-op
    expect(
      (await api(captain).get('/orders?held=true')).body.items.map((x: Json) => x.id),
    ).toContain(o.id);
    expect(
      (await api(captain).get('/orders?held=false')).body.items.map((x: Json) => x.id),
    ).not.toContain(o.id);
    const resumed = await api(captain).post(`/orders/${o.id}/resume`);
    expect(resumed.body.held).toBe(false);
    expect((await add(captain, o.id, tikka)).status).toBe(201);
    expect((await api(captain).post(`/orders/${o.id}/hold`).set('If-Match', '1')).body.code).toBe(
      'VERSION_CONFLICT',
    );
  });
});

describe('table transfer', () => {
  it('moves the order, frees the old table, audits, and refuses occupied tables', async () => {
    const o = await newOrder('DINE_IN', 'T7');
    await add(captain, o.id, tikka);
    const cur = await getOrder(o.id);
    const moved = await api(captain)
      .post(`/orders/${o.id}/transfer`, { tableId: TABLE.T8 })
      .set('If-Match', String(cur.version));
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body).toMatchObject({ tableCode: 'T8', version: cur.version + 1 });
    const floor = (await api(captain).get('/floor')).body.tables;
    expect(floor.find((x: Json) => x.code === 'T7').status).toBe('FREE');
    expect(floor.find((x: Json) => x.code === 'T8').order.id).toBe(o.id);
    const [log] = await audit('ORDER_TRANSFER', o.id);
    expect(log!.before).toMatchObject({ table: 'T7' });
    expect(log!.after).toMatchObject({ table: 'T8' });

    const other = await newOrder('DINE_IN', 'T7');
    const clash = await api(captain)
      .post(`/orders/${other.id}/transfer`, { tableId: TABLE.T8 })
      .set('If-Match', String(other.version));
    expect(clash.status).toBe(409);
    expect(clash.body).toMatchObject({ code: 'TABLE_OCCUPIED', orderId: o.id });
    expect(
      (
        await api(captain)
          .post(`/orders/${other.id}/transfer`, { tableId: TABLE.T7 })
          .set('If-Match', String(other.version))
      ).status,
    ).toBe(400); // same table
    expect(
      (
        await api(captain)
          .post(`/orders/${other.id}/transfer`, { tableId: TABLE.T8 })
          .set('If-Match', '99')
      ).body.code,
    ).toBe('VERSION_CONFLICT');
    expect(
      (
        await api(kitchen)
          .post(`/orders/${other.id}/transfer`, { tableId: TABLE.T1 })
          .set('If-Match', '1')
      ).status,
    ).toBe(403);
    const takeaway = await newOrder();
    expect(
      (
        await api(captain)
          .post(`/orders/${takeaway.id}/transfer`, { tableId: TABLE.T1 })
          .set('If-Match', '1')
      ).status,
    ).toBe(400);
  });

  it('two captains transferring different orders to the same free table: exactly one succeeds', async () => {
    // free the tables used by earlier tests, then race two orders for T5
    await t.kdb
      .updateTable('orders')
      .set({ status: 'CANCELLED' })
      .where('table_id', 'in', [TABLE.T1!, TABLE.T2!, TABLE.T3!, TABLE.T4!, TABLE.T5!, TABLE.T6!])
      .execute();
    const a = await newOrder('DINE_IN', 'T1');
    const b = await newOrder('DINE_IN', 'T2');
    const [ra, rb] = await Promise.all([
      api(captain)
        .post(`/orders/${a.id}/transfer`, { tableId: TABLE.T5 })
        .set('If-Match', String(a.version)),
      api(captain)
        .post(`/orders/${b.id}/transfer`, { tableId: TABLE.T5 })
        .set('If-Match', String(b.version)),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    const loser = ra.status === 409 ? ra : rb;
    expect(loser.body.code).toBe('TABLE_OCCUPIED');
  });
});

describe('merge', () => {
  it('moves all lines (and KOTs) into the target and cancels the source, freeing its table', async () => {
    const target = await newOrder('TAKEAWAY');
    const source = await newOrder('TAKEAWAY');
    await add(captain, target.id, tikka, { qty: 1 });
    const s1 = await add(captain, source.id, tikka, { qty: 2 });
    await add(captain, source.id, karahi, {}, karahi.variants[0]!.id);
    await setStatus(s1.body.addedLineId, 'SENT');
    const kot = await t.kdb
      .insertInto('kots')
      .values({
        branch_id: t.branchId,
        business_day_id: (await getOrder(source.id)).businessDayId,
        order_id: source.id,
        station_id: S.BBQ!,
        kot_no: 1,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const cur = await getOrder(target.id);
    const res = await api(captain)
      .post(`/orders/${target.id}/merge`, { sourceOrderId: source.id })
      .set('If-Match', String(cur.version));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items).toHaveLength(3);
    expect(res.body.subtotalPaisa).toBe(50000 + 100000 + 110000);
    expect(res.body.version).toBe(cur.version + 1);

    const src = await getOrder(source.id);
    expect(src).toMatchObject({ status: 'CANCELLED', items: [] });
    expect(src.notes).toContain(`#${target.orderNo}`);
    expect(
      (
        await t.kdb
          .selectFrom('kots')
          .select('order_id')
          .where('id', '=', kot.id)
          .executeTakeFirstOrThrow()
      ).order_id,
    ).toBe(target.id);
    const [log] = await audit('ORDER_MERGE', target.id);
    expect(log!.before).toMatchObject({ sourceOrderId: source.id });
    expect(log!.after).toMatchObject({ linesMoved: 2 });
    expect(
      (
        await api(captain)
          .post(`/orders/${target.id}/merge`, { sourceOrderId: source.id })
          .set('If-Match', String(res.body.version))
      ).body.code,
    ).toBe('ORDER_NOT_EDITABLE'); // source is gone
  });

  it('merging dine-in tables frees the source table', async () => {
    await t.kdb
      .updateTable('orders')
      .set({ status: 'CANCELLED' })
      .where('status', '=', 'OPEN')
      .where('type', '=', 'DINE_IN')
      .execute();
    const a = await newOrder('DINE_IN', 'T1');
    const b = await newOrder('DINE_IN', 'T2');
    await add(captain, b.id, tikka);
    const res = await api(captain)
      .post(`/orders/${a.id}/merge`, { sourceOrderId: b.id })
      .set('If-Match', String(a.version));
    expect(res.status).toBe(200);
    const floor = (await api(captain).get('/floor')).body.tables;
    expect(floor.find((x: Json) => x.code === 'T2').status).toBe('FREE');
    expect(floor.find((x: Json) => x.code === 'T1').order).toMatchObject({
      id: a.id,
      itemCount: 1,
    });
    // the freed table can be used again
    expect(
      (await api(captain).post('/orders', { type: 'DINE_IN', tableId: TABLE.T2 })).status,
    ).toBe(201);
  });

  it('refuses self-merge, different types, stale versions and missing permission', async () => {
    const a = await newOrder('TAKEAWAY');
    const b = await newOrder('DELIVERY');
    const c = await newOrder('TAKEAWAY');
    const post = (tok: string, target: Json, source: string, v = target.version) =>
      api(tok)
        .post(`/orders/${target.id}/merge`, { sourceOrderId: source })
        .set('If-Match', String(v));
    expect((await post(captain, a, a.id)).status).toBe(400);
    expect((await post(captain, a, b.id)).body.title).toContain('same type');
    expect((await post(captain, a, c.id, 99)).body.code).toBe('VERSION_CONFLICT');
    expect((await post(kitchen, a, c.id)).status).toBe(403);
    expect((await api(captain).post(`/orders/${a.id}/merge`, { sourceOrderId: c.id })).status).toBe(
      428,
    );
    expect((await post(captain, a, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('two merges in opposite directions at once cannot deadlock: one wins, one is refused', async () => {
    const a = await newOrder('TAKEAWAY');
    const b = await newOrder('TAKEAWAY');
    await add(captain, a.id, tikka);
    await add(captain, b.id, tikka);
    const [va, vb] = [(await getOrder(a.id)).version, (await getOrder(b.id)).version];
    const [r1, r2] = await Promise.all([
      api(captain)
        .post(`/orders/${a.id}/merge`, { sourceOrderId: b.id })
        .set('If-Match', String(va)),
      api(captain)
        .post(`/orders/${b.id}/merge`, { sourceOrderId: a.id })
        .set('If-Match', String(vb)),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const survivors = [await getOrder(a.id), await getOrder(b.id)].filter(
      (o) => o.status === 'OPEN',
    );
    expect(survivors).toHaveLength(1);
    expect(survivors[0].items).toHaveLength(2);
  });
});

describe('cancel', () => {
  it('needs order.cancel, a reason and the version; voids unsent lines and frees the table', async () => {
    const o = await newOrder('DINE_IN', 'T3');
    await add(captain, o.id, tikka);
    const cur = await getOrder(o.id);
    const post = (tok: string, body: object, v = String(cur.version)) =>
      api(tok).post(`/orders/${o.id}/cancel`, body).set('If-Match', v);
    expect((await post(captain, { reason: 'guest left' })).status).toBe(403);
    expect((await post(manager, {})).status).toBe(400);
    expect((await post(manager, { reason: 'x' })).status).toBe(400);
    expect(
      (await api(manager).post(`/orders/${o.id}/cancel`, { reason: 'guest left' })).status,
    ).toBe(428);
    expect((await post(manager, { reason: 'guest left' }, '99')).body.code).toBe(
      'VERSION_CONFLICT',
    );

    const res = await post(manager, { reason: 'guest left' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: 'CANCELLED' });
    expect(
      res.body.items.every((i: Json) => i.status === 'VOID' && i.voidReason.includes('guest left')),
    ).toBe(true);
    const [log] = await audit('ORDER_CANCEL', o.id);
    expect(log).toMatchObject({ reason: 'guest left' });
    expect(log!.before).toMatchObject({ status: 'OPEN', itemCount: 1, subtotalPaisa: 50000 });

    expect(
      (await api(captain).get('/floor')).body.tables.find((x: Json) => x.code === 'T3').status,
    ).toBe('FREE');
    expect((await add(captain, o.id, tikka)).body.code).toBe('ORDER_NOT_EDITABLE');
    expect(
      (await post(manager, { reason: 'again please' }, String(res.body.version))).body.code,
    ).toBe('ORDER_NOT_EDITABLE');
  });

  it('refuses while items are with the kitchen — void them first', async () => {
    const o = await newOrder();
    const a = await add(captain, o.id, tikka);
    await setStatus(a.body.addedLineId, 'SENT');
    const cur = await getOrder(o.id);
    const res = await api(manager)
      .post(`/orders/${o.id}/cancel`, { reason: 'wrong table' })
      .set('If-Match', String(cur.version));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORDER_HAS_SENT_ITEMS');
    await api(manager).post(`/orders/${o.id}/items/${a.body.addedLineId}/void`, {
      reason: 'wrong table',
    });
    const cur2 = await getOrder(o.id);
    expect(
      (
        await api(manager)
          .post(`/orders/${o.id}/cancel`, { reason: 'wrong table' })
          .set('If-Match', String(cur2.version))
      ).status,
    ).toBe(200);
  });
});
