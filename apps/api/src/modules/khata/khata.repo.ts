import { sql } from 'kysely';
import { AppError } from '../../http/errors';
import type { Queryable } from '../../shared/tx';

/** Data access for khata accounts and the append-only ledger. */

export async function accountWithCustomer(
  q: Queryable,
  branchId: string,
  accountId: string,
  lock = false,
) {
  let query = q
    .selectFrom('khata_accounts')
    .innerJoin('customers', 'customers.id', 'khata_accounts.customer_id')
    .select([
      'khata_accounts.id as id',
      'khata_accounts.customer_id as customerId',
      'khata_accounts.credit_limit_paisa as creditLimitPaisa',
      'khata_accounts.is_active as isActive',
      'customers.name as name',
      'customers.phone as phone',
      'customers.notes as notes',
    ])
    .where('khata_accounts.id', '=', accountId)
    .where('khata_accounts.branch_id', '=', branchId);
  if (lock) query = query.forUpdate('khata_accounts');
  const row = await query.executeTakeFirst();
  if (!row) throw new AppError(404, 'NOT_FOUND', 'khata account not found');
  return row;
}

export async function balanceOf(q: Queryable, accountId: string): Promise<number> {
  const r = await q
    .selectFrom('khata_entries')
    .select(sql<number>`COALESCE(SUM(delta_paisa), 0)::bigint`.as('balance'))
    .where('account_id', '=', accountId)
    .executeTakeFirstOrThrow();
  return r.balance;
}

export interface Aging {
  /** When the oldest part of what is still owed was put on the account (null when nothing is owed). */
  owingSince: Date | null;
  lastPaymentAt: Date | null;
}

/**
 * How old the debt is. Payments settle the oldest credit first (first in, first out), so what is
 * still owed is made of the newest increases: walk them from the newest back until they add up to
 * the balance; the date reached is "owing since".
 */
export async function agingOf(q: Queryable, accountIds: string[]): Promise<Map<string, Aging>> {
  const out = new Map<string, Aging>();
  if (accountIds.length === 0) return out;
  const ids = sql.join(accountIds.map((id) => sql`${id}::uuid`));
  const { rows } = await sql<{
    account_id: string;
    owing_since: Date | null;
    last_payment_at: Date | null;
  }>`
    WITH bal AS (
      SELECT account_id, SUM(delta_paisa) AS bal
        FROM khata_entries WHERE account_id IN (${ids}) GROUP BY account_id
    ), inc AS (
      SELECT account_id, created_at, amount_paisa,
             SUM(amount_paisa) OVER (PARTITION BY account_id ORDER BY seq DESC) AS run
        FROM khata_entries
       WHERE account_id IN (${ids}) AND kind IN ('CHARGE','ADJUST_UP')
    ), since AS (
      SELECT inc.account_id, MIN(inc.created_at) AS owing_since
        FROM inc JOIN bal USING (account_id)
       WHERE bal.bal > 0 AND inc.run - inc.amount_paisa < bal.bal
       GROUP BY inc.account_id
    ), paid AS (
      SELECT account_id, MAX(created_at) AS last_payment_at
        FROM khata_entries WHERE account_id IN (${ids}) AND kind = 'PAYMENT' GROUP BY account_id
    )
    SELECT a.id AS account_id, since.owing_since, paid.last_payment_at
      FROM khata_accounts a
      LEFT JOIN since ON since.account_id = a.id
      LEFT JOIN paid ON paid.account_id = a.id
     WHERE a.id IN (${ids})
  `.execute(q);
  for (const r of rows)
    out.set(r.account_id, {
      owingSince: r.owing_since ? new Date(r.owing_since) : null,
      lastPaymentAt: r.last_payment_at ? new Date(r.last_payment_at) : null,
    });
  return out;
}

/** Totals for the strip at the top of the khata page, over every account (not just the page shown). */
export async function summaryOf(q: Queryable, branchId: string) {
  const { rows } = await sql<{
    owed: string;
    owing: string;
    near_limit: string;
    accounts: string;
  }>`
    WITH b AS (
      SELECT a.id, a.credit_limit_paisa AS lim, a.is_active,
             COALESCE(SUM(e.delta_paisa), 0) AS bal
        FROM khata_accounts a LEFT JOIN khata_entries e ON e.account_id = a.id
       WHERE a.branch_id = ${branchId}
       GROUP BY a.id
    )
    SELECT COALESCE(SUM(bal) FILTER (WHERE bal > 0), 0)::bigint AS owed,
           COUNT(*) FILTER (WHERE bal > 0) AS owing,
           COUNT(*) FILTER (WHERE bal > 0 AND lim > 0 AND bal * 10 >= lim * 9) AS near_limit,
           COUNT(*) AS accounts
      FROM b
  `.execute(q);
  const r = rows[0]!;
  return {
    owedPaisa: Number(r.owed),
    accountsOwing: Number(r.owing),
    nearLimit: Number(r.near_limit),
    accounts: Number(r.accounts),
  };
}

/** The customer already using this phone number, comparing the last ten digits so 0300-1234567, 03001234567 and +92 300 1234567 match. */
export async function customerByPhone(
  q: Queryable,
  phone: string,
  exceptCustomerId?: string,
): Promise<{ id: string; name: string } | undefined> {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7) return undefined;
  const tail = digits.slice(-10);
  let query = q
    .selectFrom('customers')
    .select(['id', 'name'])
    .where(sql<boolean>`right(regexp_replace(phone, '\\D', '', 'g'), 10) = ${tail}`);
  if (exceptCustomerId) query = query.where('id', '<>', exceptCustomerId);
  return query.executeTakeFirst();
}

export async function listAccounts(
  q: Queryable,
  branchId: string,
  opts: {
    search?: string | undefined;
    onlyOwing?: boolean;
    limit: number;
    sort?: 'name' | 'owed' | undefined;
  },
) {
  let query = q
    .selectFrom('khata_accounts')
    .innerJoin('customers', 'customers.id', 'khata_accounts.customer_id')
    .leftJoin('khata_entries', 'khata_entries.account_id', 'khata_accounts.id')
    .select([
      'khata_accounts.id as id',
      'customers.name as name',
      'customers.phone as phone',
      'khata_accounts.credit_limit_paisa as creditLimitPaisa',
      'khata_accounts.is_active as isActive',
      sql<number>`COALESCE(SUM(khata_entries.delta_paisa), 0)::bigint`.as('balancePaisa'),
    ])
    .where('khata_accounts.branch_id', '=', branchId)
    .groupBy([
      'khata_accounts.id',
      'customers.name',
      'customers.phone',
      'khata_accounts.credit_limit_paisa',
      'khata_accounts.is_active',
    ])
    .limit(opts.limit);
  query =
    opts.sort === 'owed'
      ? query
          .orderBy(sql`COALESCE(SUM(khata_entries.delta_paisa), 0)`, 'desc')
          .orderBy('customers.name')
      : query.orderBy('customers.name');
  const term = opts.search?.trim();
  if (term) {
    const like = `%${term.replace(/[%_\\]/g, '\\$&')}%`;
    query = query.where((eb) =>
      eb.or([eb('customers.name', 'ilike', like), eb('customers.phone', 'ilike', like)]),
    );
  }
  if (opts.onlyOwing)
    query = query.having(sql<boolean>`COALESCE(SUM(khata_entries.delta_paisa), 0) > 0`);
  return query.execute();
}

export async function entriesOf(q: Queryable, accountId: string, limit: number) {
  return q
    .selectFrom('khata_entries')
    .leftJoin('payment_methods', 'payment_methods.id', 'khata_entries.method_id')
    .leftJoin('bills', 'bills.id', 'khata_entries.bill_id')
    .leftJoin('users', 'users.id', 'khata_entries.created_by')
    .select([
      'khata_entries.id as id',
      'khata_entries.kind as kind',
      'khata_entries.amount_paisa as amountPaisa',
      'khata_entries.delta_paisa as deltaPaisa',
      'khata_entries.note as note',
      'khata_entries.reference as reference',
      'khata_entries.created_at as createdAt',
      'payment_methods.name as method',
      'bills.bill_no as billNo',
      'users.full_name as by',
      // what the customer owed right after this entry (the window runs over the whole ledger, then LIMIT cuts)
      sql<number>`SUM(khata_entries.delta_paisa) OVER (ORDER BY khata_entries.seq)::bigint`.as(
        'balanceAfterPaisa',
      ),
    ])
    .where('khata_entries.account_id', '=', accountId)
    .orderBy('khata_entries.seq', 'desc')
    .limit(limit)
    .execute();
}

export async function chargeOfBill(q: Queryable, billId: string) {
  return q
    .selectFrom('khata_entries')
    .innerJoin('khata_accounts', 'khata_accounts.id', 'khata_entries.account_id')
    .innerJoin('customers', 'customers.id', 'khata_accounts.customer_id')
    .select([
      'khata_accounts.id as accountId',
      'customers.name as customer',
      'khata_entries.amount_paisa as chargedPaisa',
    ])
    .where('khata_entries.bill_id', '=', billId)
    .where('khata_entries.kind', '=', 'CHARGE')
    .executeTakeFirst();
}
