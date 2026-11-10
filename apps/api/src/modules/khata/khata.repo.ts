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

export async function listAccounts(
  q: Queryable,
  branchId: string,
  opts: { search?: string | undefined; onlyOwing?: boolean; limit: number },
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
    .orderBy('customers.name')
    .limit(opts.limit);
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
    ])
    .where('khata_entries.account_id', '=', accountId)
    .orderBy('khata_entries.created_at', 'desc')
    .orderBy('khata_entries.id', 'desc')
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
