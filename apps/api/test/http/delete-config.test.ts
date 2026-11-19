import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from './app-harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let t: TestApp;
let owner: string;
let captain: string;
const api = (tok: string) => t.as(tok);

let station: string;
let lists: { id: string }[];

/** A dish with one variant and a price in every list. */
async function dish(name: string, categoryId?: string): Promise<{ id: string; variantId: string }> {
  const res = await api(owner).post('/items', {
    kind: 'STANDARD',
    name,
    stationId: station,
    ...(categoryId ? { categoryId } : {}),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  for (const l of lists)
    await api(owner).put(`/variants/${res.body.variants[0].id}/prices/${l.id}`, {
      pricePaisa: 50000,
    });
  return { id: res.body.id, variantId: res.body.variants[0].id };
}

beforeAll(async () => {
  t = await startApp();
  owner = (await t.login('OWNER')).token;
  captain = (await t.login('CAPTAIN')).token;
  lists = [];
  for (const code of ['DINE_IN', 'TAKEAWAY', 'DELIVERY'])
    lists.push((await api(owner).post('/price-lists', { code, name: code })).body);
  station = (await api(owner).post('/stations', { code: 'KARAHI', name: 'Karahi' })).body.id;
  await api(owner).post('/business-days/open', {});
}, 240_000);

afterAll(async () => {
  await t.stop();
});

/** An order needs its current version to be cancelled (If-Match). */
const cancelOrder = async (id: string): Promise<number> => {
  const version = (await api(owner).get(`/orders/${id}`)).body.version;
  return (
    await api(owner)
      .post(`/orders/${id}/cancel`, { reason: 'test' })
      .set('If-Match', String(version))
  ).status;
};

const audit = (action: string, entityId?: string) => {
  let q = t.kdb.selectFrom('audit_log').selectAll().where('action', '=', action).orderBy('id');
  if (entityId) q = q.where('entity_id', '=', entityId);
  return q.execute();
};

describe('tables and areas', () => {
  it('a table that had orders is archived: gone from the lists, its code free again; an open order blocks it', async () => {
    const table = (await api(owner).post('/tables', { code: 'Q1', seats: 2 })).body;
    const o = (await api(captain).post('/orders', { type: 'DINE_IN', tableId: table.id })).body;
    const open = await api(owner).delete(`/tables/${table.id}`);
    expect(open.status).toBe(409);
    expect(open.body.title).toMatch(/open order/);

    expect(await cancelOrder(o.id)).toBe(200);
    const gone = await api(owner).delete(`/tables/${table.id}`);
    expect(gone.status).toBe(204);
    expect(gone.headers['x-archived']).toBe('true');
    const list = (await api(owner).get('/tables')).body.items as { id: string }[];
    expect(list.some((x) => x.id === table.id)).toBe(false);
    // the code can be used again
    expect((await api(owner).post('/tables', { code: 'Q1', seats: 4 })).status).toBe(201);
    expect((await audit('DINING_TABLE_ARCHIVE', table.id)).length).toBe(1);
  });

  it('an unused table and an empty area can be deleted, and it is audited', async () => {
    const area = (await api(owner).post('/areas', { name: 'Garden' })).body;
    const table = (await api(owner).post('/tables', { code: 'G1', seats: 4, area_id: area.id }))
      .body;

    // the area still has a table in it
    const blocked = await api(owner).delete(`/areas/${area.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('IN_USE');

    expect((await api(owner).delete(`/tables/${table.id}`)).status).toBe(204);
    expect((await api(owner).get(`/tables/${table.id}`)).status).toBe(404);
    expect((await api(owner).delete(`/areas/${area.id}`)).status).toBe(204);

    const log = await t.kdb
      .selectFrom('audit_log')
      .select('action')
      .where('action', 'in', ['DINING_TABLE_DELETE', 'AREA_DELETE'])
      .execute();
    expect(log.map((e: Json) => e.action).sort()).toEqual(['AREA_DELETE', 'DINING_TABLE_DELETE']);
  });

  it('a table with an open order cannot be deleted, but can still be switched off', async () => {
    const table = (await api(owner).post('/tables', { code: 'U1', seats: 2 })).body;
    const d = await dish('Chai');
    const o = (await api(captain).post('/orders', { type: 'DINE_IN', tableId: table.id })).body;
    expect(o.id).toBeTruthy();
    await api(captain).post(`/orders/${o.id}/items`, { itemId: d.id, variantId: d.variantId });

    const res = await api(owner).delete(`/tables/${table.id}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IN_USE');
    expect(res.body.title ?? res.body.detail ?? '').toMatch(/open order/i);
    expect((await api(owner).get(`/tables/${table.id}`)).status).toBe(200);
    // …and switching it off still works
    const off = await api(owner).patch(`/tables/${table.id}`, { is_active: false });
    expect(off.status).toBe(200);
    expect(off.body.is_active).toBe(false);
  });

  it('only people who may manage settings can delete', async () => {
    const table = (await api(owner).post('/tables', { code: 'P1', seats: 2 })).body;
    expect((await api(captain).delete(`/tables/${table.id}`)).status).toBe(403);
    expect((await api(owner).get(`/tables/${table.id}`)).status).toBe(200);
  });
});

describe('categories', () => {
  it('an empty category is deleted; one with dishes or sub-categories is refused', async () => {
    const cat = (await api(owner).post('/categories', { name: 'Desserts' })).body;
    const sub = (await api(owner).post('/categories', { name: 'Sweets', parentId: cat.id })).body;
    await dish('Kheer', sub.id);

    const withChild = await api(owner).delete(`/categories/${cat.id}`);
    expect(withChild.status).toBe(409);
    expect(withChild.body.code).toBe('IN_USE');
    const withDish = await api(owner).delete(`/categories/${sub.id}`);
    expect(withDish.status).toBe(409);
    expect(withDish.body.code).toBe('IN_USE');

    const empty = (await api(owner).post('/categories', { name: 'Empty' })).body;
    expect((await api(owner).delete(`/categories/${empty.id}`)).status).toBe(204);
    const list = (await api(owner).get('/categories')).body.items as { id: string }[];
    expect(list.some((c) => c.id === empty.id)).toBe(false);
  });

  it('a category with dishes and sub-categories is deleted once the caller says where the dishes go', async () => {
    const main = (await api(owner).post('/categories', { name: 'Grill' })).body;
    const sub = (await api(owner).post('/categories', { name: 'Grill Special', parentId: main.id }))
      .body;
    const target = (await api(owner).post('/categories', { name: 'Everything else' })).body;
    const d1 = await dish('Seekh', main.id);
    const d2 = await dish('Boti', sub.id);

    // without saying where, still refused
    expect((await api(owner).delete(`/categories/${main.id}`)).status).toBe(409);
    // moving to itself is nonsense
    expect((await api(owner).delete(`/categories/${main.id}?moveItemsTo=${main.id}`)).status).toBe(
      400,
    );
    // an unknown category is refused too
    expect(
      (
        await api(owner).delete(
          `/categories/${main.id}?moveItemsTo=00000000-0000-4000-8000-000000000000`,
        )
      ).status,
    ).toBe(404);

    const gone = await api(owner).delete(`/categories/${main.id}?moveItemsTo=${target.id}`);
    expect(gone.status).toBe(204);
    const item = async (id: string) =>
      t.kdb
        .selectFrom('items')
        .select('category_id')
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
    expect((await item(d1.id)).category_id).toBe(target.id); // moved
    expect((await item(d2.id)).category_id).toBe(sub.id); // the sub-category's own dish stays in it
    const subNow = await t.kdb
      .selectFrom('categories')
      .select('parent_id')
      .where('id', '=', sub.id)
      .executeTakeFirstOrThrow();
    expect(subNow.parent_id).toBeNull(); // it became a main category
    const log = await t.kdb
      .selectFrom('audit_log')
      .select('after')
      .where('action', '=', 'CATEGORY_DELETE')
      .where('entity_id', '=', main.id)
      .executeTakeFirstOrThrow();
    expect(log.after).toMatchObject({ items: 1, subCategories: 1 });
  });

  it('"none" leaves the dishes without a category', async () => {
    const cat = (await api(owner).post('/categories', { name: 'Temp' })).body;
    const d = await dish('Orphan', cat.id);
    expect((await api(owner).delete(`/categories/${cat.id}?moveItemsTo=none`)).status).toBe(204);
    const row = await t.kdb
      .selectFrom('items')
      .select('category_id')
      .where('id', '=', d.id)
      .executeTakeFirstOrThrow();
    expect(row.category_id).toBeNull();
  });

  it('a captain cannot manage categories', async () => {
    const cat = (await api(owner).post('/categories', { name: 'Private' })).body;
    expect((await api(captain).delete(`/categories/${cat.id}`)).status).toBe(403);
  });
});

describe('dishes and variants', () => {
  it('a dish that was never ordered is deleted with its prices; an ordered one is kept', async () => {
    const fresh = await dish('Trial dish');
    expect((await api(owner).delete(`/items/${fresh.id}`)).status).toBe(204);
    const gone = await t.kdb
      .selectFrom('item_variants')
      .select('id')
      .where('item_id', '=', fresh.id)
      .execute();
    expect(gone).toHaveLength(0);
    const prices = await t.kdb
      .selectFrom('item_prices')
      .select('id')
      .where('variant_id', '=', fresh.variantId)
      .execute();
    expect(prices).toHaveLength(0);

    const sold = await dish('Sold dish');
    const o = (await api(captain).post('/orders', { type: 'TAKEAWAY' })).body;
    await api(captain).post(`/orders/${o.id}/items`, {
      itemId: sold.id,
      variantId: sold.variantId,
    });
    // while it is on an open order it cannot go (the cart would lose it)
    const res = await api(owner).delete(`/items/${sold.id}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IN_USE');
    expect(res.body.title).toMatch(/open order/);

    // once that order is over, "delete" removes it from the shop for good; the old order keeps it
    expect(await cancelOrder(o.id)).toBe(200);
    const archivedDel = await api(owner).delete(`/items/${sold.id}`);
    expect(archivedDel.status).toBe(204);
    expect(archivedDel.headers['x-archived']).toBe('true');
    const listed = (await api(owner).get('/items?includeInactive=true')).body.items as {
      id: string;
    }[];
    expect(listed.some((i) => i.id === sold.id)).toBe(false);
    const admin = (await api(owner).get('/menu/admin')).body.items as { id: string }[];
    expect(admin.some((i) => i.id === sold.id)).toBe(false);
    const row = await t.kdb
      .selectFrom('items')
      .select(['is_active', 'archived_at'])
      .where('id', '=', sold.id)
      .executeTakeFirstOrThrow();
    expect(row.is_active).toBe(false);
    expect(row.archived_at).not.toBeNull(); // the row stays for the old order line
    expect((await audit('ITEM_ARCHIVE', sold.id)).length).toBe(1);
  });

  it('a variant can be deleted unless it is the last one or was ordered; the default moves on', async () => {
    const d = await dish('Karahi');
    const half = (
      await api(owner).post(`/items/${d.id}/variants`, { name: 'Half', isDefault: false })
    ).body;
    const full = d.variantId;

    // the original variant is the default: deleting it hands the default to the other one
    expect((await api(owner).delete(`/variants/${full}`)).status).toBe(204);
    const item = (await api(owner).get(`/items/${d.id}`)).body;
    expect(item.variants).toHaveLength(1);
    expect(item.variants[0].id).toBe(half.id);
    expect(item.variants[0].isDefault ?? item.variants[0].is_default).toBe(true);

    // the last one stays
    const last = await api(owner).delete(`/variants/${half.id}`);
    expect(last.status).toBe(400);
  });

  it('an ordered size is kept for the old bills but removed from the shop once its order is over', async () => {
    const d = await dish('Biryani');
    const plate = (await api(owner).post(`/items/${d.id}/variants`, { name: 'Plate' })).body;
    for (const l of lists)
      await api(owner).put(`/variants/${plate.id}/prices/${l.id}`, { pricePaisa: 30000 });
    const o = (await api(captain).post('/orders', { type: 'TAKEAWAY' })).body;
    await api(captain).post(`/orders/${o.id}/items`, { itemId: d.id, variantId: plate.id });
    const live = await api(owner).delete(`/variants/${plate.id}`);
    expect(live.status).toBe(409);
    expect(live.body.code).toBe('IN_USE');

    expect(await cancelOrder(o.id)).toBe(200);
    const res = await api(owner).delete(`/variants/${plate.id}`);
    expect(res.status).toBe(204);
    expect(res.headers['x-archived']).toBe('true');
    const item = (await api(owner).get(`/items/${d.id}`)).body;
    expect(item.variants.map((v: { id: string }) => v.id)).not.toContain(plate.id);
  });

  it('a station that dishes use cannot be deleted; an unused one can', async () => {
    const used = await api(owner).delete(`/stations/${station}`);
    expect(used.status).toBe(409);
    expect(used.body.code).toBe('IN_USE');
    const spare = (await api(owner).post('/stations', { code: 'SPARE', name: 'Spare' })).body;
    expect((await api(owner).delete(`/stations/${spare.id}`)).status).toBe(204);
  });
});
