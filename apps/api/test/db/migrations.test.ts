import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateUp } from '../../src/db/migrate';
import { SQLSTATE, createOrder, createPreBilledBill, pay, seedBase, startDb, type TestDb } from './harness';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const strip = (s: string): string => s.replace(/^-- Up Migration\r?\n-- Ported[^\n]*\n/, '');

describe('migrations stay in sync with the reference SQL in db/', () => {
  it.each([
    ['db/001_core.sql', 'apps/api/migrations/0001_core.sql'],
    ['db/002_inventory_finance.sql', 'apps/api/migrations-phase2/0001_inventory_finance.sql'],
  ])('%s == %s', async (ref, mig) => {
    const [a, b] = await Promise.all([
      readFile(path.join(root, ref), 'utf8'),
      readFile(path.join(root, mig), 'utf8'),
    ]);
    expect(strip(b)).toBe(a);
  });
});

describe('0002_auth_rbac on a database that already has data (upgrade path)', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await startDb([]);
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  it('upgrades a populated 0001 database without touching existing rows', async () => {
    expect(await migrateUp(db.url, 'core', 1)).toEqual(['0001_core']);
    const b = await seedBase(db.pool); // users, shift, tables … created under the old schema
    const orderId = await createOrder(db.pool, b, { orderNo: 1, tableId: b.tableIds[0]! });
    const billId = await createPreBilledBill(db.pool, b, orderId, 1);
    await pay(db.pool, b, billId, 1160, 'before-0002');

    expect(await migrateUp(db.url, 'core')).toEqual(['0002_auth_rbac', '0003_menu', '0004_orders', '0005_kitchen_printing', '0006_billing', '0007_shifts_cash', '0008_khata', '0009_credit_notes', '0010_urdu_receipt', '0011_tax', '0012_fiscal', '0013_kitchen_display', '0014_guest_menu', '0015_must_change_password', '0016_branding']);
    expect(await migrateUp(db.url, 'core')).toEqual([]);

    const user = await db.pool.query(`SELECT failed_attempts, locked_until, last_failed_at FROM users WHERE id = $1`, [b.userId]);
    expect(user.rows[0]).toEqual({ failed_attempts: 0, locked_until: null, last_failed_at: null });
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM payments`)).rows[0].n).toBe(1);

    const perms = await db.pool.query(`SELECT count(*)::int AS n FROM permissions`);
    expect(perms.rows[0].n).toBe(35);
    const owner = await db.pool.query(
      `SELECT count(*)::int AS n FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.code = 'OWNER'`,
    );
    expect(owner.rows[0].n).toBe(35);
    // the existing role created by seedBase is untouched
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM roles WHERE id IN (SELECT role_id FROM users WHERE id = $1)`, [b.userId])).rows[0].n).toBe(1);
  });

  it('keeps device tokens and refresh hashes unique', async () => {
    const b = await seedBase(db.pool);
    const dev = `INSERT INTO devices(branch_id,name,kind,token_hash) VALUES ($1,'d','COUNTER','same-hash')`;
    await db.pool.query(dev, [b.branchId]);
    await expect(db.pool.query(dev, [b.branchId])).rejects.toMatchObject({ code: SQLSTATE.uniqueViolation });
  });
});

describe('phase 2 migration on a database that already has data', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await startDb(['core']);
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  it('applies on top of populated core tables, is idempotent, and keeps ledgers immutable', async () => {
    const b = await seedBase(db.pool);
    const orderId = await createOrder(db.pool, b, { orderNo: 1, tableId: b.tableIds[0]! });
    const billId = await createPreBilledBill(db.pool, b, orderId, 1);
    await pay(db.pool, b, billId, 1160, 'pre-existing');

    expect(await migrateUp(db.url, 'core')).toEqual([]); // re-run is a no-op
    expect(await migrateUp(db.url, 'phase2')).toEqual(['0001_inventory_finance', '0002_inventory_app']);
    expect(await migrateUp(db.url, 'phase2')).toEqual([]);

    const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM payments`);
    expect(rows[0].n).toBe(1); // data survived

    const ing = await db.pool.query(
      `INSERT INTO ingredients(branch_id,name,base_uom,purchase_uom,purchase_to_base)
       VALUES ($1,'Chicken','g','kg',1000) RETURNING id`,
      [b.branchId],
    );
    const mv = await db.pool.query(
      `INSERT INTO stock_movements(branch_id,ingredient_id,kind,qty_base) VALUES ($1,$2,'OPENING',5000) RETURNING id`,
      [b.branchId, ing.rows[0].id],
    );
    await expect(
      db.pool.query(`UPDATE stock_movements SET qty_base = 1 WHERE id = $1`, [mv.rows[0].id]),
    ).rejects.toMatchObject({ code: SQLSTATE.restrictViolation });
    await expect(db.pool.query(`DELETE FROM stock_movements WHERE id = $1`, [mv.rows[0].id])).rejects.toMatchObject({
      code: SQLSTATE.restrictViolation,
    });
  });
});


describe('0003_menu on a database that already has menu data', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await startDb([]);
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  it('keeps existing items/prices and adds the new columns and guards', async () => {
    expect(await migrateUp(db.url, 'core', 2)).toEqual(['0001_core', '0002_auth_rbac']);
    const b = await seedBase(db.pool);
    const item = (await db.pool.query(
      `INSERT INTO items(branch_id,tax_category_id,code,name,name_ur) VALUES ($1,$2,'OLD1','Old Karahi','پرانی کڑاہی') RETURNING id`,
      [b.branchId, b.taxCategoryId],
    )).rows[0].id as string;
    const variant = (await db.pool.query(
      `INSERT INTO item_variants(item_id,name,is_default) VALUES ($1,'Full',true) RETURNING id`,
      [item],
    )).rows[0].id as string;
    await db.pool.query(
      `INSERT INTO item_prices(variant_id,price_list_id,price_paisa,effective_from) VALUES ($1,$2,210000,'2026-01-01')`,
      [variant, b.priceListId],
    );

    expect(await migrateUp(db.url, 'core')).toEqual(['0003_menu', '0004_orders', '0005_kitchen_printing', '0006_billing', '0007_shifts_cash', '0008_khata', '0009_credit_notes', '0010_urdu_receipt', '0011_tax', '0012_fiscal', '0013_kitchen_display', '0014_guest_menu', '0015_must_change_password', '0016_branding']);

    const row = (await db.pool.query(`SELECT name_ur, search_terms FROM items WHERE id=$1`, [item])).rows[0];
    expect(row).toEqual({ name_ur: 'پرانی کڑاہی', search_terms: null });
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM item_prices`)).rows[0].n).toBe(1);
    // the new overlap guard now applies to that old data
    await expect(
      db.pool.query(
        `INSERT INTO item_prices(variant_id,price_list_id,price_paisa,effective_from) VALUES ($1,$2,1,'2026-06-01')`,
        [variant, b.priceListId],
      ),
    ).rejects.toMatchObject({ code: '23P01' });
  });
});