import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SQLSTATE,
  createOrder,
  createPreBilledBill,
  pay,
  seedBase,
  startDb,
  type Base,
  type TestDb,
} from './harness';

let db: TestDb;
let b: Base;
let seq = 0;
beforeAll(async () => {
  db = await startDb(['core']);
  b = await seedBase(db.pool);
}, 180_000);
afterAll(async () => {
  await db.stop();
});

async function account(limit: number, active = true): Promise<string> {
  const c = (await db.pool.query(`INSERT INTO customers(name) VALUES ('Haji') RETURNING id`))
    .rows[0].id;
  return (
    await db.pool.query(
      `INSERT INTO khata_accounts(branch_id,customer_id,credit_limit_paisa,is_active) VALUES ($1,$2,$3,$4) RETURNING id`,
      [b.branchId, c, limit, active],
    )
  ).rows[0].id as string;
}
/** A bill with a payment row, so a CHARGE entry has what it must point at. */
async function billWithPayment(amount: number): Promise<{ bill: string; payment: string }> {
  const n = ++seq;
  const order = await createOrder(db.pool, b, { orderNo: 9000 + n });
  const bill = await createPreBilledBill(db.pool, b, order, 9000 + n);
  await pay(db.pool, b, bill, amount, `khata-pay-${n}`);
  const p = (await db.pool.query(`SELECT id FROM payments WHERE bill_id=$1`, [bill])).rows[0].id;
  return { bill, payment: p };
}
const chargeSql = `INSERT INTO khata_entries(account_id,kind,amount_paisa,bill_id,payment_id,created_by) VALUES ($1,'CHARGE',$2,$3,$4,$5)`;
const charge = async (acct: string, amount: number) => {
  const { bill, payment } = await billWithPayment(amount);
  return db.pool.query(chargeSql, [acct, amount, bill, payment, b.userId]);
};
const received = (acct: string, amount: number, shift = b.shiftId) =>
  db.pool.query(
    `INSERT INTO khata_entries(account_id,kind,amount_paisa,method_id,shift_id,created_by) VALUES ($1,'PAYMENT',$2,$3,$4,$5)`,
    [acct, amount, b.methodCashId, shift, b.userId],
  );
const balance = async (acct: string): Promise<number> =>
  Number(
    (
      await db.pool.query(
        `SELECT COALESCE(SUM(delta_paisa),0) AS s FROM khata_entries WHERE account_id=$1`,
        [acct],
      )
    ).rows[0].s,
  );

describe('credit limit', () => {
  it('allows a charge up to exactly the limit and refuses one paisa more', async () => {
    const a = await account(1000);
    await charge(a, 400);
    await charge(a, 600); // exactly at the limit
    await expect(charge(a, 1)).rejects.toMatchObject({ code: SQLSTATE.checkViolation });
    expect(await balance(a)).toBe(1000);
  });

  it('a limit of zero means no credit, and an inactive account takes no charges', async () => {
    await expect(charge(await account(0), 1)).rejects.toMatchObject({
      code: SQLSTATE.checkViolation,
    });
    await expect(charge(await account(5000, false), 1)).rejects.toMatchObject({
      code: SQLSTATE.restrictViolation,
    });
  });

  it('two simultaneous charges cannot both fit under the limit (per-account lock)', async () => {
    const a = await account(1000);
    const [x, y] = await Promise.all([billWithPayment(600), billWithPayment(600)]);
    const run = (e: { bill: string; payment: string }) =>
      db.pool.query(chargeSql, [a, 600, e.bill, e.payment, b.userId]);
    const results = await Promise.allSettled([run(x), run(y)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await balance(a)).toBe(600);
  });
});

describe('payments', () => {
  it('can clear the balance but not exceed it, and only into an open shift', async () => {
    const a = await account(10_000);
    await charge(a, 700);
    await expect(received(a, 701)).rejects.toMatchObject({ code: SQLSTATE.checkViolation });
    await received(a, 300);
    expect(await balance(a)).toBe(400);
    await received(a, 400);
    expect(await balance(a)).toBe(0);
    await expect(received(a, 1)).rejects.toMatchObject({ code: SQLSTATE.checkViolation });

    const b2 = await seedBase(db.pool);
    await db.pool.query(
      `UPDATE shifts SET status='CLOSED', closed_at=now(), closed_by=$2, expected_cash_paisa=0, counted_cash_paisa=0 WHERE id=$1`,
      [b2.shiftId, b2.userId],
    );
    await charge(a, 100);
    await expect(received(a, 50, b2.shiftId)).rejects.toMatchObject({
      code: SQLSTATE.restrictViolation,
    });
  });
});

describe('ledger shape and history', () => {
  it('each kind carries what makes it traceable', async () => {
    const a = await account(10_000);
    const ins = (cols: string, vals: unknown[]) =>
      db.pool.query(
        `INSERT INTO khata_entries(account_id,created_by,${cols}) VALUES ($1,$2,${vals.map((_, i) => `$${i + 3}`).join(',')})`,
        [a, b.userId, ...vals],
      );
    await expect(ins('kind,amount_paisa', ['CHARGE', 10])).rejects.toMatchObject({
      code: SQLSTATE.checkViolation,
    });
    await expect(ins('kind,amount_paisa', ['PAYMENT', 10])).rejects.toMatchObject({
      code: SQLSTATE.checkViolation,
    });
    await expect(ins('kind,amount_paisa', ['ADJUST_UP', 10])).rejects.toMatchObject({
      code: SQLSTATE.checkViolation,
    });
    await expect(ins('kind,amount_paisa,note', ['ADJUST_SIDEWAYS', 10, 'x'])).rejects.toMatchObject(
      {
        code: SQLSTATE.checkViolation,
      },
    );
    await ins('kind,amount_paisa,note', [
      'ADJUST_UP',
      10,
      'opening balance from the old ledger book',
    ]);
    expect(await balance(a)).toBe(10);
  });

  it('is append-only, and a bill payment can be charged to khata only once', async () => {
    const a = await account(10_000);
    await charge(a, 100);
    await expect(
      db.pool.query(`UPDATE khata_entries SET amount_paisa=1 WHERE account_id=$1`, [a]),
    ).rejects.toMatchObject({ code: SQLSTATE.restrictViolation });
    await expect(
      db.pool.query(`DELETE FROM khata_entries WHERE account_id=$1`, [a]),
    ).rejects.toMatchObject({ code: SQLSTATE.restrictViolation });
    const e = (
      await db.pool.query(`SELECT bill_id, payment_id FROM khata_entries WHERE account_id=$1`, [a])
    ).rows[0];
    await expect(
      db.pool.query(chargeSql, [a, 1, e.bill_id, e.payment_id, b.userId]),
    ).rejects.toMatchObject({
      code: SQLSTATE.uniqueViolation,
    });
  });

  it('idempotency keys are unique', async () => {
    const a = await account(10_000);
    await charge(a, 100);
    const withKey = (k: string) =>
      db.pool.query(
        `INSERT INTO khata_entries(account_id,kind,amount_paisa,method_id,shift_id,created_by,idempotency_key) VALUES ($1,'PAYMENT',5,$2,$3,$4,$5)`,
        [a, b.methodCashId, b.shiftId, b.userId, k],
      );
    await withKey('same-key-0001');
    await expect(withKey('same-key-0001')).rejects.toMatchObject({
      code: SQLSTATE.uniqueViolation,
    });
  });
});
