import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SQLSTATE, createOrder, seedBase, startDb, type Base, type TestDb } from './harness';

let db: TestDb;
let b: Base;
let seq = 5000;
let itemId: string;
let variantId: string;

beforeAll(async () => {
  db = await startDb(['core']);
  b = await seedBase(db.pool);
  itemId = (await db.pool.query(`INSERT INTO items(branch_id,tax_category_id,code,name) VALUES ($1,$2,'X','X') RETURNING id`, [b.branchId, b.taxCategoryId])).rows[0].id;
  variantId = (await db.pool.query(`INSERT INTO item_variants(item_id,name,is_default) VALUES ($1,'Regular',true) RETURNING id`, [itemId])).rows[0].id;
}, 180_000);
afterAll(async () => {
  await db.stop();
});

const addLine = async (orderId: string, status = 'NEW'): Promise<string> =>
  (await db.pool.query(
    `INSERT INTO order_items(order_id,item_id,variant_id,name_snapshot,qty,unit_price_paisa,line_total_paisa,tax_category_id,created_by,status)
     VALUES ($1,$2,$3,'X',1,1000,1000,$4,$5,$6) RETURNING id`,
    [orderId, itemId, variantId, b.taxCategoryId, b.userId, status],
  )).rows[0].id;
const newOrder = () => createOrder(db.pool, b, { orderNo: ++seq });
const setOrder = (id: string, status: string) => db.pool.query(`UPDATE orders SET status=$2 WHERE id=$1`, [id, status]);
const restrict = { code: SQLSTATE.restrictViolation };

describe('order lines are frozen once the order is SETTLED or CANCELLED', () => {
  it.each(['SETTLED', 'CANCELLED'])('%s: blocks new lines, deletes, and any change to what was sold', async (final) => {
    const order = await newOrder();
    const line = await addLine(order, 'SERVED');
    await db.pool.query(`INSERT INTO order_item_modifiers(order_item_id,name_snapshot,price_delta_paisa) VALUES ($1,'Hot',100)`, [line]);
    await setOrder(order, final);

    await expect(addLine(order)).rejects.toMatchObject(restrict);
    await expect(db.pool.query(`DELETE FROM order_items WHERE id=$1`, [line])).rejects.toMatchObject(restrict);
    for (const set of ['qty = 2', 'line_total_paisa = 1', 'unit_price_paisa = 1', 'name_snapshot = \'Y\'', 'is_complimentary = true']) {
      await expect(db.pool.query(`UPDATE order_items SET ${set} WHERE id=$1`, [line]), set).rejects.toMatchObject(restrict);
    }
    await expect(db.pool.query(`UPDATE order_items SET status='VOID', void_reason='x', voided_by=$2 WHERE id=$1`, [line, b.userId])).rejects.toMatchObject(restrict);
    await expect(db.pool.query(`INSERT INTO order_item_modifiers(order_item_id,name_snapshot) VALUES ($1,'Late')`, [line])).rejects.toMatchObject(restrict);
    await expect(db.pool.query(`UPDATE order_item_modifiers SET price_delta_paisa = 0 WHERE order_item_id=$1`, [line])).rejects.toMatchObject(restrict);
    await expect(db.pool.query(`DELETE FROM order_item_modifiers WHERE order_item_id=$1`, [line])).rejects.toMatchObject(restrict);
  });

  it('still lets the kitchen progress a line after payment (status only), but never back to VOID', async () => {
    const order = await newOrder();
    const line = await addLine(order, 'SENT');
    await setOrder(order, 'SETTLED'); // e.g. a takeaway paid before it is ready
    await db.pool.query(`UPDATE order_items SET status='READY' WHERE id=$1`, [line]);
    await db.pool.query(`UPDATE order_items SET status='SERVED' WHERE id=$1`, [line]);
    expect((await db.pool.query(`SELECT status FROM order_items WHERE id=$1`, [line])).rows[0].status).toBe('SERVED');
  });

  it('OPEN and BILLED orders stay editable (the app decides; the DB only protects final orders)', async () => {
    const order = await newOrder();
    const line = await addLine(order);
    await db.pool.query(`UPDATE order_items SET qty = 3, line_total_paisa = 3000 WHERE id=$1`, [line]);
    await setOrder(order, 'BILLED');
    await db.pool.query(`UPDATE order_items SET note = 'x' WHERE id=$1`, [line]);
    await addLine(order);
  });
});

describe('one open shift per cashier and per till', () => {
  it('rejects a second open shift for the same user or device; closed shifts do not count', async () => {
    const dev = (await db.pool.query(`INSERT INTO devices(branch_id,name,kind,token_hash) VALUES ($1,'Till','COUNTER','h') RETURNING id`, [b.branchId])).rows[0].id;
    const user2 = (await db.pool.query(`INSERT INTO users(role_id,username,full_name) SELECT role_id,'second','S' FROM users WHERE id=$1 RETURNING id`, [b.userId])).rows[0].id;
    const open = (user: string, device: string | null) =>
      db.pool.query(`INSERT INTO shifts(branch_id,business_day_id,opened_by,device_id) VALUES ($1,$2,$3,$4)`, [b.branchId, b.dayId, user, device]);

    // seedBase already opened a shift for b.userId (no device)
    await expect(open(b.userId, null)).rejects.toMatchObject({ code: SQLSTATE.uniqueViolation });
    await open(user2, dev);
    const user3 = (await db.pool.query(`INSERT INTO users(role_id,username,full_name) SELECT role_id,'third','T' FROM users WHERE id=$1 RETURNING id`, [b.userId])).rows[0].id;
    await expect(open(user3, dev)).rejects.toMatchObject({ code: SQLSTATE.uniqueViolation });
    await db.pool.query(
      `UPDATE shifts SET status='CLOSED', closed_at=now(), closed_by=$1, expected_cash_paisa=0, counted_cash_paisa=0 WHERE opened_by=$1`,
      [user2],
    );
    await open(user3, dev); // the till is free again
  });
});
