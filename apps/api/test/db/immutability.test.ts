import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SQLSTATE,
  createOrder,
  createPreBilledBill,
  pay,
  seedBase,
  settle,
  startDb,
  type Base,
  type TestDb,
} from './harness';

let db: TestDb;
let b: Base;
let orderSeq = 100;
let billSeq = 100;
let keySeq = 0;

beforeAll(async () => {
  db = await startDb(['core']);
  b = await seedBase(db.pool);
}, 180_000);

afterAll(async () => {
  await db.stop();
});

/** A fully paid, SETTLED bill (total 1160). */
async function settledBill(): Promise<string> {
  const orderId = await createOrder(db.pool, b, { orderNo: ++orderSeq });
  const billId = await createPreBilledBill(db.pool, b, orderId, ++billSeq);
  await pay(db.pool, b, billId, 1160, `k-${++keySeq}`);
  await settle(db.pool, b, billId);
  return billId;
}

describe('payments are append-only', () => {
  it('blocks UPDATE and DELETE', async () => {
    const billId = await settledBill();
    await expect(
      db.pool.query(`UPDATE payments SET amount_paisa = 1 WHERE bill_id = $1`, [billId]),
    ).rejects.toMatchObject({ code: SQLSTATE.restrictViolation });
    await expect(db.pool.query(`DELETE FROM payments WHERE bill_id = $1`, [billId])).rejects.toMatchObject({
      code: SQLSTATE.restrictViolation,
    });
  });

  it('rejects a replayed idempotency key (no double charge)', async () => {
    const orderId = await createOrder(db.pool, b, { orderNo: ++orderSeq });
    const billId = await createPreBilledBill(db.pool, b, orderId, ++billSeq);
    await pay(db.pool, b, billId, 500, 'dup-key');
    await expect(pay(db.pool, b, billId, 500, 'dup-key')).rejects.toMatchObject({
      code: SQLSTATE.uniqueViolation,
    });
  });

  it('rejects non-positive amounts', async () => {
    const orderId = await createOrder(db.pool, b, { orderNo: ++orderSeq });
    const billId = await createPreBilledBill(db.pool, b, orderId, ++billSeq);
    await expect(pay(db.pool, b, billId, 0, `k-${++keySeq}`)).rejects.toMatchObject({
      code: SQLSTATE.checkViolation,
    });
  });
});

describe('settled bills are immutable', () => {
  it('blocks changing money fields, status, and DELETE', async () => {
    const billId = await settledBill();
    for (const stmt of [
      `UPDATE bills SET total_paisa = total_paisa - 100, tax_paisa = tax_paisa - 100 WHERE id = $1`,
      `UPDATE bills SET discount_paisa = 100 WHERE id = $1`,
      `UPDATE bills SET status = 'PRE_BILLED' WHERE id = $1`,
      `UPDATE bills SET status = 'VOID' WHERE id = $1`,
      `DELETE FROM bills WHERE id = $1`,
    ]) {
      await expect(db.pool.query(stmt, [billId]), stmt).rejects.toMatchObject({
        code: SQLSTATE.restrictViolation,
      });
    }
  });

  it('still allows bookkeeping columns (fiscal status/number, print count)', async () => {
    const billId = await settledBill();
    await db.pool.query(
      `UPDATE bills SET fiscal_status='SUBMITTED', fiscal_invoice_no='PRA-1', print_count=print_count+1 WHERE id=$1`,
      [billId],
    );
    const { rows } = await db.pool.query(`SELECT fiscal_status, fiscal_invoice_no FROM bills WHERE id=$1`, [billId]);
    expect(rows[0]).toEqual({ fiscal_status: 'SUBMITTED', fiscal_invoice_no: 'PRA-1' });
  });

  it('freezes bill_lines of a settled bill', async () => {
    const billId = await settledBill();
    await expect(
      db.pool.query(`UPDATE bill_lines SET net_paisa = 1 WHERE bill_id = $1`, [billId]),
    ).rejects.toMatchObject({ code: SQLSTATE.restrictViolation });
    await expect(db.pool.query(`DELETE FROM bill_lines WHERE bill_id = $1`, [billId])).rejects.toMatchObject({
      code: SQLSTATE.restrictViolation,
    });
    await expect(
      db.pool.query(
        `INSERT INTO bill_lines(bill_id,line_kind,description,net_paisa) VALUES ($1,'CHARGE','late add',50)`,
        [billId],
      ),
    ).rejects.toMatchObject({ code: SQLSTATE.restrictViolation });
  });

  it('cannot be deleted even before settlement', async () => {
    const orderId = await createOrder(db.pool, b, { orderNo: ++orderSeq });
    const billId = await createPreBilledBill(db.pool, b, orderId, ++billSeq);
    await expect(db.pool.query(`DELETE FROM bills WHERE id = $1`, [billId])).rejects.toMatchObject({
      code: SQLSTATE.restrictViolation,
    });
  });
});

describe('payment guards', () => {
  it('blocks overpayment in one shot', async () => {
    const orderId = await createOrder(db.pool, b, { orderNo: ++orderSeq });
    const billId = await createPreBilledBill(db.pool, b, orderId, ++billSeq);
    await expect(pay(db.pool, b, billId, 1161, `k-${++keySeq}`)).rejects.toMatchObject({
      code: SQLSTATE.checkViolation,
    });
  });

  it('blocks overpayment across several tenders but allows exact split tender', async () => {
    const orderId = await createOrder(db.pool, b, { orderNo: ++orderSeq });
    const billId = await createPreBilledBill(db.pool, b, orderId, ++billSeq);
    await pay(db.pool, b, billId, 1000, `k-${++keySeq}`);
    await expect(pay(db.pool, b, billId, 161, `k-${++keySeq}`)).rejects.toMatchObject({
      code: SQLSTATE.checkViolation,
    });
    await pay(db.pool, b, billId, 160, `k-${++keySeq}`); // exact remainder is fine
  });

  it('blocks payment once the bill is fully settled (replay with a new key)', async () => {
    const billId = await settledBill();
    await expect(pay(db.pool, b, billId, 1, `k-${++keySeq}`)).rejects.toMatchObject({
      code: SQLSTATE.checkViolation,
    });
  });

  it('enforces bill arithmetic once a bill is priced', async () => {
    const orderId = await createOrder(db.pool, b, { orderNo: ++orderSeq });
    const billId = await createPreBilledBill(db.pool, b, orderId, ++billSeq);
    await expect(
      db.pool.query(`UPDATE bills SET total_paisa = 9999 WHERE id = $1`, [billId]),
    ).rejects.toMatchObject({ code: SQLSTATE.checkViolation });
  });
});

describe('floor and day rules', () => {
  it('allows only one OPEN/BILLED order per table, frees it after settle/cancel', async () => {
    const table = b.tableIds[0]!;
    const first = await createOrder(db.pool, b, { orderNo: ++orderSeq, tableId: table });
    await expect(createOrder(db.pool, b, { orderNo: ++orderSeq, tableId: table })).rejects.toMatchObject({
      code: SQLSTATE.uniqueViolation,
    });
    // a different table is independent
    await createOrder(db.pool, b, { orderNo: ++orderSeq, tableId: b.tableIds[1]! });
    await db.pool.query(`UPDATE orders SET status='BILLED' WHERE id=$1`, [first]);
    await expect(createOrder(db.pool, b, { orderNo: ++orderSeq, tableId: table })).rejects.toMatchObject({
      code: SQLSTATE.uniqueViolation,
    });
    await db.pool.query(`UPDATE orders SET status='CANCELLED' WHERE id=$1`, [first]);
    await createOrder(db.pool, b, { orderNo: ++orderSeq, tableId: table }); // now allowed
  });

  it('allows only one OPEN business day per branch', async () => {
    // seedBase already opened one day for this branch.
    await expect(
      db.pool.query(`INSERT INTO business_days(branch_id,business_date) VALUES ($1,'2026-08-02')`, [b.branchId]),
    ).rejects.toMatchObject({ code: SQLSTATE.uniqueViolation });
    await db.pool.query(
      `UPDATE shifts SET status='CLOSED', closed_at=now(), closed_by=$2, expected_cash_paisa=0, counted_cash_paisa=0 WHERE business_day_id=$1`,
      [b.dayId, b.userId],
    );
    await db.pool.query(
      `UPDATE business_days SET status='CLOSED', closed_at=now(), closed_by=$2 WHERE id=$1`,
      [b.dayId, b.userId],
    );
    await db.pool.query(`INSERT INTO business_days(branch_id,business_date) VALUES ($1,'2026-08-02')`, [
      b.branchId,
    ]); // allowed after close
    // a different branch is unaffected
    const other = await seedBase(db.pool);
    expect(other.branchId).not.toBe(b.branchId);
  });
});

describe('other append-only ledgers', () => {
  it('audit_log is append-only', async () => {
    const ins = await db.pool.query(
      `INSERT INTO audit_log(branch_id,user_id,action,entity) VALUES ($1,$2,'TEST','bill') RETURNING id`,
      [b.branchId, b.userId],
    );
    const id = ins.rows[0].id as string;
    await expect(db.pool.query(`UPDATE audit_log SET action='X' WHERE id=$1`, [id])).rejects.toMatchObject({
      code: SQLSTATE.restrictViolation,
    });
    await expect(db.pool.query(`DELETE FROM audit_log WHERE id=$1`, [id])).rejects.toMatchObject({
      code: SQLSTATE.restrictViolation,
    });
  });

  it('khata_entries is append-only', async () => {
    const cust = await db.pool.query(`INSERT INTO customers(name) VALUES ('Ali') RETURNING id`);
    const acct = await db.pool.query(
      `INSERT INTO khata_accounts(branch_id,customer_id,credit_limit_paisa) VALUES ($1,$2,100000) RETURNING id`,
      [b.branchId, cust.rows[0].id],
    );
    const entry = await db.pool.query(
      `INSERT INTO khata_entries(account_id,kind,amount_paisa,note,created_by) VALUES ($1,'ADJUST_UP',500,'opening balance',$2) RETURNING id`,
      [acct.rows[0].id, b.userId],
    );
    const id = entry.rows[0].id as string;
    await expect(
      db.pool.query(`UPDATE khata_entries SET amount_paisa=1 WHERE id=$1`, [id]),
    ).rejects.toMatchObject({ code: SQLSTATE.restrictViolation });
    await expect(db.pool.query(`DELETE FROM khata_entries WHERE id=$1`, [id])).rejects.toMatchObject({
      code: SQLSTATE.restrictViolation,
    });
  });
});
