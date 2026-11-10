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
let seq = 0;
beforeAll(async () => {
  db = await startDb(['core']);
  b = await seedBase(db.pool);
}, 180_000);
afterAll(async () => {
  await db.stop();
});

/** A settled bill (total 1160) with one line of quantity 2. */
async function settledBill(): Promise<{ bill: string; line: string }> {
  const n = 7000 + ++seq;
  const order = await createOrder(db.pool, b, { orderNo: n });
  const bill = await createPreBilledBill(db.pool, b, order, n);
  await db.pool.query(`UPDATE bill_lines SET qty=2 WHERE bill_id=$1`, [bill]);
  await pay(db.pool, b, bill, 1160, `cn-pay-${n}`);
  await settle(db.pool, b, bill);
  const line = (await db.pool.query(`SELECT id FROM bill_lines WHERE bill_id=$1`, [bill])).rows[0].id;
  return { bill, line };
}
let cnSeq = 0;
const note = (bill: string, total: number, shift = b.shiftId) =>
  db.pool.query(
    `INSERT INTO credit_notes(branch_id,business_day_id,bill_id,cn_no,reason,net_paisa,tax_paisa,total_paisa,shift_id,approved_by,created_by)
     VALUES ($1,$2,$3,$4,'test',$5,0,$5,$6,$7,$7) RETURNING id`,
    [b.branchId, b.dayId, bill, ++cnSeq, total, shift, b.userId],
  );
const noteLine = (cn: string, line: string, qty: number, net = 100) =>
  db.pool.query(
    `INSERT INTO credit_note_lines(credit_note_id,bill_line_id,qty,net_paisa,tax_paisa) VALUES ($1,$2,$3,$4,0)`,
    [cn, line, qty, net],
  );

describe('credit notes', () => {
  it('only a settled bill can be credited', async () => {
    const order = await createOrder(db.pool, b, { orderNo: 7900 });
    const open = await createPreBilledBill(db.pool, b, order, 7900);
    await expect(note(open, 100)).rejects.toMatchObject({ code: SQLSTATE.restrictViolation });
  });

  it('credit notes together cannot exceed the bill total', async () => {
    const { bill } = await settledBill();
    await note(bill, 1000);
    await note(bill, 160); // exactly the rest
    await expect(note(bill, 1)).rejects.toMatchObject({ code: SQLSTATE.checkViolation });
  });

  it('a line cannot be returned more than it was sold, and must belong to the credited bill', async () => {
    const { bill, line } = await settledBill();
    const other = await settledBill();
    const cn = (await note(bill, 100)).rows[0].id;
    await noteLine(cn, line, 1);
    await noteLine(cn, line, 1); // 2 of 2
    await expect(noteLine(cn, line, 0.001)).rejects.toMatchObject({ code: SQLSTATE.checkViolation });
    await expect(noteLine(cn, other.line, 1)).rejects.toMatchObject({ code: SQLSTATE.checkViolation });
  });

  it('two simultaneous returns of the same line cannot both succeed', async () => {
    const { bill, line } = await settledBill();
    const [a, c] = await Promise.all([note(bill, 100), note(bill, 100)]);
    const run = (cn: string) => noteLine(cn, line, 1.5);
    const results = await Promise.allSettled([run(a.rows[0].id), run(c.rows[0].id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('are immutable (not even deletable); only fiscal fields can change; the shift must be open', async () => {
    const { bill } = await settledBill();
    const id = (await note(bill, 100)).rows[0].id;
    await expect(db.pool.query(`UPDATE credit_notes SET total_paisa=1, net_paisa=1 WHERE id=$1`, [id])).rejects.toMatchObject({
      code: SQLSTATE.restrictViolation,
    });
    await expect(db.pool.query(`UPDATE credit_notes SET reason='changed' WHERE id=$1`, [id])).rejects.toMatchObject({
      code: SQLSTATE.restrictViolation,
    });
    await db.pool.query(`UPDATE credit_notes SET fiscal_status='PENDING' WHERE id=$1`, [id]); // M7 may do this
    await expect(db.pool.query(`DELETE FROM credit_notes WHERE id=$1`, [id])).rejects.toMatchObject({
      code: SQLSTATE.restrictViolation,
    });

    const b2 = await seedBase(db.pool);
    await db.pool.query(
      `UPDATE shifts SET status='CLOSED', closed_at=now(), closed_by=$2, expected_cash_paisa=0, counted_cash_paisa=0 WHERE id=$1`,
      [b2.shiftId, b2.userId],
    );
    await expect(note(bill, 10, b2.shiftId)).rejects.toMatchObject({ code: SQLSTATE.restrictViolation });
  });
});
