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
beforeAll(async () => {
  db = await startDb(['core']);
}, 180_000);
afterAll(async () => {
  await db.stop();
});

const closeShift = (b: Base, expected = 1000, counted = 1000) =>
  db.pool.query(
    `UPDATE shifts SET status='CLOSED', closed_at=now(), closed_by=$2, expected_cash_paisa=$3, counted_cash_paisa=$4 WHERE id=$1`,
    [b.shiftId, b.userId, expected, counted],
  );
const move = (b: Base, key: string, kind = 'PAID_OUT', amount = 100) =>
  db.pool.query(
    `INSERT INTO cash_movements(shift_id,kind,amount_paisa,reason,created_by,idempotency_key) VALUES ($1,$2,$3,'test',$4,$5)`,
    [b.shiftId, kind, amount, b.userId, key],
  );

describe('closing a shift', () => {
  it('needs counted and expected cash and who closed it; the variance is computed', async () => {
    const b = await seedBase(db.pool);
    await expect(
      db.pool.query(`UPDATE shifts SET status='CLOSED', closed_at=now() WHERE id=$1`, [b.shiftId]),
    ).rejects.toMatchObject({ code: SQLSTATE.checkViolation });
    await closeShift(b, 1000, 900);
    const row = (await db.pool.query(`SELECT variance_paisa FROM shifts WHERE id=$1`, [b.shiftId])).rows[0];
    expect(Number(row.variance_paisa)).toBe(-100);
  });

  it('a closed shift is immutable; only a clean reopen is allowed; shifts are never deleted', async () => {
    const b = await seedBase(db.pool);
    await closeShift(b);
    await expect(
      db.pool.query(`UPDATE shifts SET counted_cash_paisa=5000 WHERE id=$1`, [b.shiftId]),
    ).rejects.toMatchObject({ code: SQLSTATE.restrictViolation });
    await expect(
      db.pool.query(`UPDATE shifts SET notes='edited' WHERE id=$1`, [b.shiftId]),
    ).rejects.toMatchObject({ code: SQLSTATE.restrictViolation });
    // a "reopen" that keeps the old count, or changes the float, is refused
    await expect(
      db.pool.query(`UPDATE shifts SET status='OPEN' WHERE id=$1`, [b.shiftId]),
    ).rejects.toMatchObject({ code: SQLSTATE.restrictViolation });
    await expect(
      db.pool.query(
        `UPDATE shifts SET status='OPEN', closed_at=NULL, closed_by=NULL, counted_cash_paisa=NULL, expected_cash_paisa=NULL, opening_float_paisa=999 WHERE id=$1`,
        [b.shiftId],
      ),
    ).rejects.toMatchObject({ code: SQLSTATE.restrictViolation });
    await db.pool.query(
      `UPDATE shifts SET status='OPEN', closed_at=NULL, closed_by=NULL, counted_cash_paisa=NULL, expected_cash_paisa=NULL WHERE id=$1`,
      [b.shiftId],
    );
    await expect(db.pool.query(`DELETE FROM shifts WHERE id=$1`, [b.shiftId])).rejects.toMatchObject({
      code: SQLSTATE.restrictViolation,
    });
  });

  it('the float and owner of an open shift cannot change', async () => {
    const b = await seedBase(db.pool);
    await expect(
      db.pool.query(`UPDATE shifts SET opening_float_paisa=1 WHERE id=$1`, [b.shiftId]),
    ).rejects.toMatchObject({ code: SQLSTATE.restrictViolation });
  });
});

describe('money moves only through an open shift', () => {
  it('payments and cash movements are refused once the shift is closed', async () => {
    const b = await seedBase(db.pool);
    const order = await createOrder(db.pool, b, { orderNo: 1 });
    const bill = await createPreBilledBill(db.pool, b, order, 1);
    await pay(db.pool, b, bill, 500, 'open-ok');
    await move(b, 'move-ok');
    await closeShift(b);
    await expect(pay(db.pool, b, bill, 100, 'late')).rejects.toMatchObject({
      code: SQLSTATE.restrictViolation,
    });
    await expect(move(b, 'late-move')).rejects.toMatchObject({ code: SQLSTATE.restrictViolation });
  });
});

describe('cash movements', () => {
  it('are append-only and idempotent', async () => {
    const b = await seedBase(db.pool);
    await move(b, 'dup-key-0001');
    await expect(move(b, 'dup-key-0001')).rejects.toMatchObject({ code: SQLSTATE.uniqueViolation });
    await expect(db.pool.query(`UPDATE cash_movements SET amount_paisa=1`)).rejects.toMatchObject({
      code: SQLSTATE.restrictViolation,
    });
    await expect(db.pool.query(`DELETE FROM cash_movements`)).rejects.toMatchObject({
      code: SQLSTATE.restrictViolation,
    });
  });
});

describe('closing the business day', () => {
  it('a closed day is immutable and nothing new can start in it', async () => {
    const b = await seedBase(db.pool);
    await expect(
      db.pool.query(`UPDATE business_days SET status='CLOSED' WHERE id=$1`, [b.dayId]),
    ).rejects.toMatchObject({ code: SQLSTATE.checkViolation });
    await closeShift(b);
    await db.pool.query(
      `UPDATE business_days SET status='CLOSED', closed_at=now(), closed_by=$2 WHERE id=$1`,
      [b.dayId, b.userId],
    );
    await expect(
      db.pool.query(`UPDATE business_days SET status='OPEN', closed_at=NULL WHERE id=$1`, [b.dayId]),
    ).rejects.toMatchObject({ code: SQLSTATE.restrictViolation });
    await expect(db.pool.query(`DELETE FROM business_days WHERE id=$1`, [b.dayId])).rejects.toMatchObject({
      code: SQLSTATE.restrictViolation,
    });
    await expect(createOrder(db.pool, b, { orderNo: 77 })).rejects.toMatchObject({
      code: SQLSTATE.restrictViolation,
    });
    await expect(
      db.pool.query(`INSERT INTO shifts(branch_id,business_day_id,opened_by) VALUES ($1,$2,$3)`, [
        b.branchId,
        b.dayId,
        b.userId,
      ]),
    ).rejects.toMatchObject({ code: SQLSTATE.restrictViolation });
  });
});
