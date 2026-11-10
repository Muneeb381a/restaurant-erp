import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SQLSTATE, createOrder, seedBase, startDb, type Base, type TestDb } from './harness';

const EXCLUSION = '23P01';
let db: TestDb;
let b: Base;
let n = 0;

beforeAll(async () => {
  db = await startDb(['core']);
  b = await seedBase(db.pool);
}, 180_000);
afterAll(async () => {
  await db.stop();
});

async function id(sql: string, params: unknown[] = []): Promise<string> {
  return (await db.pool.query(sql, params)).rows[0].id as string;
}
const mkItem = (kind = 'STANDARD') =>
  id(`INSERT INTO items(branch_id,tax_category_id,code,name,kind) VALUES ($1,$2,$3,'I',$4) RETURNING id`, [b.branchId, b.taxCategoryId, `C${++n}`, kind]);
const mkVariant = (itemId: string, name = 'Regular', isDefault = false) =>
  id(`INSERT INTO item_variants(item_id,name,is_default) VALUES ($1,$2,$3) RETURNING id`, [itemId, name, isDefault]);
const price = (variantId: string, from: string, to: string | null, list = b.priceListId, paisa = 1000) =>
  db.pool.query(`INSERT INTO item_prices(variant_id,price_list_id,price_paisa,effective_from,effective_to) VALUES ($1,$2,$3,$4,$5)`, [variantId, list, paisa, from, to]);

describe('item_prices cannot overlap (never guess)', () => {
  it('rejects overlapping and contained ranges, open-ended included', async () => {
    const v = await mkVariant(await mkItem());
    await price(v, '2026-01-01', '2026-06-30');
    for (const [from, to] of [['2026-06-30', '2026-12-31'], ['2026-03-01', '2026-03-05'], ['2025-12-01', '2026-01-01'], ['2026-02-01', null]] as const) {
      await expect(price(v, from, to), `${from}..${to}`).rejects.toMatchObject({ code: EXCLUSION });
    }
  });

  it('allows adjacent periods, other price lists and other variants', async () => {
    const item = await mkItem();
    const v = await mkVariant(item);
    await price(v, '2026-01-01', '2026-06-30');
    await price(v, '2026-07-01', null); // adjacent, open-ended
    const other = await id(`INSERT INTO price_lists(branch_id,code,name) VALUES ($1,'DELIVERY','Delivery') RETURNING id`, [b.branchId]);
    await price(v, '2026-01-01', null, other);
    await price(await mkVariant(item, 'Large'), '2026-01-01', null);
  });

  it('keeps the existing unique and check constraints (same start date, negative price, inverted range)', async () => {
    const v = await mkVariant(await mkItem());
    await price(v, '2026-01-01', '2026-01-31');
    await expect(price(v, '2026-01-01', '2026-01-05')).rejects.toBeTruthy();
    await expect(price(v, '2027-01-01', null, b.priceListId, -1)).rejects.toMatchObject({ code: SQLSTATE.checkViolation });
    // Postgres raises its own range error (22000) before the CHECK (23514) for an inverted range.
    await expect(price(v, '2027-05-01', '2027-04-01')).rejects.toSatisfy((e: unknown) => ['22000', SQLSTATE.checkViolation].includes((e as { code?: string }).code ?? ''));
  });
});

describe('deal guards', () => {
  it('slots only on DEAL items; options can never be deals themselves', async () => {
    const std = await mkItem();
    await expect(db.pool.query(`INSERT INTO deal_slots(deal_item_id,name) VALUES ($1,'x')`, [std])).rejects.toMatchObject({ code: SQLSTATE.restrictViolation });

    const deal = await mkItem('DEAL');
    const slot = await id(`INSERT INTO deal_slots(deal_item_id,name) VALUES ($1,'Main') RETURNING id`, [deal]);
    const ok = await mkVariant(await mkItem());
    await db.pool.query(`INSERT INTO deal_slot_options(slot_id,variant_id) VALUES ($1,$2)`, [slot, ok]);
    await expect(db.pool.query(`INSERT INTO deal_slot_options(slot_id,variant_id) VALUES ($1,$2)`, [slot, ok])).rejects.toMatchObject({ code: SQLSTATE.uniqueViolation });

    const nested = await mkVariant(await mkItem('DEAL'), 'Deal', true);
    await expect(db.pool.query(`INSERT INTO deal_slot_options(slot_id,variant_id) VALUES ($1,$2)`, [slot, nested])).rejects.toMatchObject({ code: SQLSTATE.restrictViolation });
  });

  it('an item\'s kind is frozen once it has orders or deal slots, but free before that', async () => {
    const free = await mkItem();
    await db.pool.query(`UPDATE items SET kind='WEIGHT' WHERE id=$1`, [free]);

    const dealItem = await mkItem('DEAL');
    await db.pool.query(`INSERT INTO deal_slots(deal_item_id,name) VALUES ($1,'S')`, [dealItem]);
    await expect(db.pool.query(`UPDATE items SET kind='STANDARD' WHERE id=$1`, [dealItem])).rejects.toMatchObject({ code: SQLSTATE.restrictViolation });

    const sold = await mkItem();
    const v = await mkVariant(sold);
    const order = await createOrder(db.pool, b, { orderNo: 900 });
    await db.pool.query(
      `INSERT INTO order_items(order_id,item_id,variant_id,name_snapshot,qty,unit_price_paisa,line_total_paisa,tax_category_id,created_by)
       VALUES ($1,$2,$3,'I',1,1000,1000,$4,$5)`,
      [order, sold, v, b.taxCategoryId, b.userId],
    );
    await expect(db.pool.query(`UPDATE items SET kind='WEIGHT' WHERE id=$1`, [sold])).rejects.toMatchObject({ code: SQLSTATE.restrictViolation });
    await db.pool.query(`UPDATE items SET name='Renamed' WHERE id=$1`, [sold]); // other edits are fine
  });
});

describe('uniqueness rules', () => {
  it('one default variant per item; variant names unique case-insensitively', async () => {
    const item = await mkItem();
    await mkVariant(item, 'Half', true);
    await expect(mkVariant(item, 'Full', true)).rejects.toMatchObject({ code: SQLSTATE.uniqueViolation });
    await mkVariant(item, 'Full', false);
    await expect(mkVariant(item, 'FULL')).rejects.toMatchObject({ code: SQLSTATE.uniqueViolation });
  });

  it('category names are unique per parent (case-insensitive), including top level', async () => {
    const ins = (name: string, parent: string | null = null) =>
      id(`INSERT INTO categories(branch_id,parent_id,name) VALUES ($1,$2,$3) RETURNING id`, [b.branchId, parent, name]);
    const bbq = await ins('BBQ');
    await expect(ins('bbq')).rejects.toMatchObject({ code: SQLSTATE.uniqueViolation });
    await ins('Tikka', bbq);
    await ins('Tikka'); // same name under another parent is fine
    await expect(ins('TIKKA', bbq)).rejects.toMatchObject({ code: SQLSTATE.uniqueViolation });
  });

  it('modifier group codes are unique per branch, but several groups may have no code', async () => {
    const ins = (code: string | null) =>
      id(`INSERT INTO modifier_groups(branch_id,name,code) VALUES ($1,'G',$2) RETURNING id`, [b.branchId, code]);
    await ins('SPICE');
    await expect(ins('SPICE')).rejects.toMatchObject({ code: SQLSTATE.uniqueViolation });
    await ins(null);
    await ins(null);
  });
});

describe('reference data', () => {
  it('RESTAURANT_SERVICE tax category exists after migration (no rates implied)', async () => {
    const r = await db.pool.query(`SELECT count(*)::int AS n FROM tax_categories WHERE code='RESTAURANT_SERVICE'`);
    expect(r.rows[0].n).toBe(1);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM tax_rules`)).rows[0].n).toBe(0);
  });
});
