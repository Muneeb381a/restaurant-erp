import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { migrateUp, type MigrationSet } from '../../src/db/migrate';

export interface TestDb {
  url: string;
  pool: pg.Pool;
  stop: () => Promise<void>;
}

/** Starts a throwaway real Postgres 16 and applies the requested migration sets. */
export async function startDb(sets: MigrationSet[] = ['core']): Promise<TestDb> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    'postgres:16-alpine',
  ).start();
  const url = container.getConnectionUri();
  for (const set of sets) await migrateUp(url, set);
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  return {
    url,
    pool,
    stop: async () => {
      await pool.end();
      await container.stop();
    },
  };
}

/** Postgres SQLSTATE codes we assert on. */
export const SQLSTATE = {
  restrictViolation: '23001',
  uniqueViolation: '23505',
  checkViolation: '23514',
} as const;

export interface Base {
  branchId: string;
  userId: string;
  dayId: string;
  shiftId: string;
  priceListId: string;
  methodCashId: string;
  taxCategoryId: string;
  tableIds: string[];
}

let counter = 0;
const uniq = (p: string): string => `${p}${++counter}`;

async function one<T = { id: string }>(
  pool: pg.Pool,
  text: string,
  values: unknown[] = [],
): Promise<T> {
  const res = await pool.query(text, values);
  return res.rows[0] as T;
}

/** Minimal graph of reference rows every money test needs. */
export async function seedBase(pool: pg.Pool): Promise<Base> {
  const branch = await one(
    pool,
    `INSERT INTO branches(code,name) VALUES ($1,'Test') RETURNING id`,
    [uniq('B')],
  );
  const role = await one(pool, `INSERT INTO roles(code,name) VALUES ($1,'R') RETURNING id`, [
    uniq('R'),
  ]);
  const user = await one(
    pool,
    `INSERT INTO users(role_id,username,full_name) VALUES ($1,$2,'U') RETURNING id`,
    [role.id, uniq('u')],
  );
  const day = await one(
    pool,
    `INSERT INTO business_days(branch_id,business_date,opened_by) VALUES ($1,'2026-08-01',$2) RETURNING id`,
    [branch.id, user.id],
  );
  const shift = await one(
    pool,
    `INSERT INTO shifts(branch_id,business_day_id,opened_by) VALUES ($1,$2,$3) RETURNING id`,
    [branch.id, day.id, user.id],
  );
  const priceList = await one(
    pool,
    `INSERT INTO price_lists(branch_id,code,name) VALUES ($1,'DINE_IN','Dine-in') RETURNING id`,
    [branch.id],
  );
  const method = await one(
    pool,
    `INSERT INTO payment_methods(branch_id,code,name,tender_class) VALUES ($1,'CASH','Cash','CASH_OTHER') RETURNING id`,
    [branch.id],
  );
  const taxCat = await one(
    pool,
    `INSERT INTO tax_categories(code,name) VALUES ($1,'Food') RETURNING id`,
    [uniq('TC')],
  );
  const tableIds: string[] = [];
  for (const code of ['T1', 'T2']) {
    const t = await one(
      pool,
      `INSERT INTO dining_tables(branch_id,code) VALUES ($1,$2) RETURNING id`,
      [branch.id, code],
    );
    tableIds.push(t.id);
  }
  return {
    branchId: branch.id,
    userId: user.id,
    dayId: day.id,
    shiftId: shift.id,
    priceListId: priceList.id,
    methodCashId: method.id,
    taxCategoryId: taxCat.id,
    tableIds,
  };
}

export async function createOrder(
  pool: pg.Pool,
  b: Base,
  opts: { tableId?: string; orderNo: number; status?: string },
): Promise<string> {
  const row = await one(
    pool,
    `INSERT INTO orders(branch_id,business_day_id,order_no,type,table_id,price_list_id,opened_by,status)
     VALUES ($1,$2,$3,$8,$4,$5,$6,$7) RETURNING id`,
    [
      b.branchId,
      b.dayId,
      opts.orderNo,
      opts.tableId ?? null,
      b.priceListId,
      b.userId,
      opts.status ?? 'OPEN',
      opts.tableId ? 'DINE_IN' : 'TAKEAWAY', // schema: DINE_IN requires a table
    ],
  );
  return row.id;
}

/** Creates a PRE_BILLED bill: subtotal 1000, tax 160, total 1160 (all paisa). */
export async function createPreBilledBill(
  pool: pg.Pool,
  b: Base,
  orderId: string,
  billNo: number,
): Promise<string> {
  const bill = await one(
    pool,
    `INSERT INTO bills(branch_id,business_day_id,order_id,bill_no,created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [b.branchId, b.dayId, orderId, billNo, b.userId],
  );
  await pool.query(
    `INSERT INTO bill_lines(bill_id,line_kind,description,net_paisa,tax_category_id)
     VALUES ($1,'CHARGE','Test line',1000,$2)`,
    [bill.id, b.taxCategoryId],
  );
  await pool.query(
    `UPDATE bills SET status='PRE_BILLED', subtotal_paisa=1000, taxable_paisa=1000, tax_paisa=160,
       tax_rate_bps=1600, tax_payment_class='CASH_OTHER', total_paisa=1160 WHERE id=$1`,
    [bill.id],
  );
  return bill.id;
}

export async function pay(
  pool: pg.Pool,
  b: Base,
  billId: string,
  amount: number,
  key: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO payments(bill_id,shift_id,method_id,tender_class,amount_paisa,idempotency_key,received_by)
     VALUES ($1,$2,$3,'CASH_OTHER',$4,$5,$6)`,
    [billId, b.shiftId, b.methodCashId, amount, key, b.userId],
  );
}

export async function settle(pool: pg.Pool, b: Base, billId: string): Promise<void> {
  await pool.query(
    `UPDATE bills SET status='SETTLED', settled_at=now(), settled_by=$2, shift_id=$3 WHERE id=$1`,
    [billId, b.userId, b.shiftId],
  );
}
