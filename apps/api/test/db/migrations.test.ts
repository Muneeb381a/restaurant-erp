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

    expect(await migrateUp(db.url, 'core')).toEqual(['0002_auth_rbac']);
    expect(await migrateUp(db.url, 'core')).toEqual([]);

    const user = await db.pool.query(`SELECT failed_attempts, locked_until, last_failed_at FROM users WHERE id = $1`, [b.userId]);
    expect(user.rows[0]).toEqual({ failed_attempts: 0, locked_until: null, last_failed_at: null });
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM payments`)).rows[0].n).toBe(1);

    const perms = await db.pool.query(`SELECT count(*)::int AS n FROM permissions`);
    expect(perms.rows[0].n).toBe(29);
    const owner = await db.pool.query(
      `SELECT count(*)::int AS n FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.code = 'OWNER'`,
    );
    expect(owner.rows[0].n).toBe(29);
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
    expect(await migrateUp(db.url, 'phase2')).toEqual(['0001_inventory_finance']);
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
