import { sql } from 'kysely';
import { assertCanCharge, assertCanReceivePayment, availableCredit, KhataError } from '@erp/domain';
import type { AppContext } from '../../http/context';
import { AppError } from '../../http/errors';
import { withTx, type Queryable } from '../../shared/tx';
import { writeAudit } from '../audit/audit.service';
import type { Actor } from '../orders/orders.service';
import {
  accountWithCustomer,
  balanceOf,
  chargeOfBill,
  entriesOf,
  listAccounts,
} from './khata.repo';

const bad = (message: string): AppError => new AppError(400, 'VALIDATION_FAILED', message);

const audit = (
  q: Queryable,
  a: Actor,
  action: string,
  accountId: string,
  before: unknown,
  after: unknown,
  reason?: string,
) =>
  writeAudit(q, {
    branchId: a.branchId,
    userId: a.userId,
    deviceId: a.deviceId,
    action,
    entity: 'khata_account',
    entityId: accountId,
    before,
    after,
    reason,
    ip: a.ip,
  });

/** Maps the pure ledger rules to stable API errors. */
function asApiError(e: unknown): never {
  if (e instanceof KhataError) {
    const status = e.code === 'KHATA_AMOUNT_INVALID' ? 400 : 409;
    const code = e.code === 'KHATA_AMOUNT_INVALID' ? 'VALIDATION_FAILED' : e.code;
    throw new AppError(status, code, e.message, e.extra);
  }
  throw e;
}

const present = (
  a: {
    id: string;
    name: string;
    phone: string | null;
    creditLimitPaisa: number;
    isActive: boolean;
  },
  balancePaisa: number,
) => ({
  id: a.id,
  name: a.name,
  phone: a.phone,
  creditLimitPaisa: a.creditLimitPaisa,
  isActive: a.isActive,
  balancePaisa,
  availableCreditPaisa: a.isActive ? availableCredit(balancePaisa, a.creditLimitPaisa) : 0,
});

// ───────────────────────────────── reads ─────────────────────────────────

export async function searchAccounts(
  ctx: AppContext,
  branchId: string,
  opts: { search?: string | undefined; onlyOwing?: boolean | undefined; limit: number },
) {
  const rows = await listAccounts(ctx.db, branchId, {
    ...opts,
    onlyOwing: opts.onlyOwing ?? false,
  });
  return rows.map((r) => present(r, r.balancePaisa));
}

export async function getAccount(q: Queryable, branchId: string, id: string, limit: number) {
  const acct = await accountWithCustomer(q, branchId, id);
  const balance = await balanceOf(q, id);
  const entries = await entriesOf(q, id, limit);
  return { ...present(acct, balance), notes: acct.notes, entries };
}

/** What a bill's khata tender charged and the customer's balance now (for the bill view and receipt). */
export async function khataForBill(q: Queryable, billId: string) {
  const c = await chargeOfBill(q, billId);
  if (!c) return null;
  return {
    accountId: c.accountId,
    customer: c.customer,
    chargedPaisa: c.chargedPaisa,
    balancePaisa: await balanceOf(q, c.accountId),
  };
}

// ──────────────────────────────── accounts ────────────────────────────────

export function createAccount(
  ctx: AppContext,
  a: Actor,
  input: {
    name: string;
    phone?: string | undefined;
    notes?: string | undefined;
    creditLimitPaisa: number;
  },
) {
  return withTx(ctx.db, async (trx) => {
    const customer = await trx
      .insertInto('customers')
      .values({ name: input.name, phone: input.phone ?? null, notes: input.notes ?? null })
      .returning('id')
      .executeTakeFirstOrThrow();
    const acct = await trx
      .insertInto('khata_accounts')
      .values({
        branch_id: a.branchId,
        customer_id: customer.id,
        credit_limit_paisa: input.creditLimitPaisa,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await audit(trx, a, 'KHATA_ACCOUNT_CREATE', acct.id, null, {
      name: input.name,
      creditLimitPaisa: input.creditLimitPaisa,
    });
    return getAccount(trx, a.branchId, acct.id, 0);
  });
}

export function updateAccount(
  ctx: AppContext,
  a: Actor,
  id: string,
  input: {
    name?: string;
    phone?: string | null;
    notes?: string | null;
    creditLimitPaisa?: number;
    isActive?: boolean;
  },
) {
  return withTx(ctx.db, async (trx) => {
    const before = await accountWithCustomer(trx, a.branchId, id, true);
    const custPatch = {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.phone !== undefined && { phone: input.phone }),
      ...(input.notes !== undefined && { notes: input.notes }),
    };
    if (Object.keys(custPatch).length)
      await trx
        .updateTable('customers')
        .set(custPatch)
        .where('id', '=', before.customerId)
        .execute();
    const acctPatch = {
      ...(input.creditLimitPaisa !== undefined && { credit_limit_paisa: input.creditLimitPaisa }),
      ...(input.isActive !== undefined && { is_active: input.isActive }),
    };
    if (Object.keys(acctPatch).length)
      await trx.updateTable('khata_accounts').set(acctPatch).where('id', '=', id).execute();
    await audit(
      trx,
      a,
      'KHATA_ACCOUNT_UPDATE',
      id,
      { name: before.name, creditLimitPaisa: before.creditLimitPaisa, isActive: before.isActive },
      input,
    );
    return getAccount(trx, a.branchId, id, 0);
  });
}

// ─────────────────────────────── charging (at settle) ───────────────────────────────

/**
 * Called by the billing service inside the settle transaction: puts a bill's khata tender on the
 * customer's account. The account row is locked, the limit is checked here for a clear error and
 * again by the database trigger as the backstop.
 */
export async function chargeKhata(
  trx: Queryable,
  a: Actor,
  input: { accountId: string; billId: string; paymentId: string; amountPaisa: number; at: Date },
): Promise<void> {
  const acct = await accountWithCustomer(trx, a.branchId, input.accountId, true);
  if (!acct.isActive)
    throw new AppError(409, 'KHATA_ACCOUNT_INACTIVE', 'This khata account is switched off');
  const balance = await balanceOf(trx, acct.id);
  try {
    assertCanCharge(balance, acct.creditLimitPaisa, input.amountPaisa);
  } catch (e) {
    if (e instanceof KhataError && e.code === 'KHATA_LIMIT_EXCEEDED')
      throw new AppError(409, e.code, e.message, {
        balancePaisa: balance,
        limitPaisa: acct.creditLimitPaisa,
        availablePaisa: availableCredit(balance, acct.creditLimitPaisa),
      });
    return asApiError(e);
  }
  await trx
    .insertInto('khata_entries')
    .values({
      account_id: acct.id,
      kind: 'CHARGE',
      amount_paisa: input.amountPaisa,
      bill_id: input.billId,
      payment_id: input.paymentId,
      created_by: a.userId,
      created_at: input.at,
    })
    .execute();
  await audit(
    trx,
    a,
    'KHATA_CHARGE',
    acct.id,
    { balancePaisa: balance },
    {
      balancePaisa: balance + input.amountPaisa,
      billId: input.billId,
      amountPaisa: input.amountPaisa,
    },
  );
}

// ─────────────────────────────── collecting payments ───────────────────────────────

/**
 * A customer pays off (part of) their balance. Cash goes into the cashier's drawer, so it needs the
 * cashier's own open shift; every method other than khata itself is allowed.
 */
export function receivePayment(
  ctx: AppContext,
  a: Actor,
  accountId: string,
  input: { methodId: string; amountPaisa: number; reference?: string | undefined },
  idempotencyKey: string,
) {
  return withTx(ctx.db, async (trx) => {
    const existing = await trx
      .selectFrom('khata_entries')
      .select(['id', 'account_id', 'amount_paisa'])
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
    if (existing) {
      if (existing.account_id !== accountId)
        throw new AppError(409, 'CONFLICT', 'That Idempotency-Key was used for another account');
      return {
        id: existing.id,
        amountPaisa: existing.amount_paisa,
        balancePaisa: await balanceOf(trx, accountId),
        replayed: true,
      };
    }
    const shift = await trx
      .selectFrom('shifts')
      .select('id')
      .where('opened_by', '=', a.userId)
      .where('status', '=', 'OPEN')
      .forShare()
      .executeTakeFirst();
    if (!shift) throw new AppError(409, 'SHIFT_NOT_OPEN', 'Open your shift before taking money');
    const method = await trx
      .selectFrom('payment_methods')
      .selectAll()
      .where('id', '=', input.methodId)
      .where('branch_id', '=', a.branchId)
      .where('is_active', '=', true)
      .executeTakeFirst();
    if (!method || method.code === 'KHATA') throw bad('Choose a cash, card or wallet method');
    const reference = input.reference?.trim() || null;
    if (method.needs_reference && !reference)
      throw bad('A reference is required for this payment method');

    const acct = await accountWithCustomer(trx, a.branchId, accountId, true);
    const balance = await balanceOf(trx, acct.id);
    try {
      assertCanReceivePayment(balance, input.amountPaisa);
    } catch (e) {
      return asApiError(e);
    }
    const row = await trx
      .insertInto('khata_entries')
      .values({
        account_id: acct.id,
        kind: 'PAYMENT',
        amount_paisa: input.amountPaisa,
        method_id: method.id,
        shift_id: shift.id,
        reference,
        created_by: a.userId,
        idempotency_key: idempotencyKey,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await audit(
      trx,
      a,
      'KHATA_PAYMENT',
      acct.id,
      { balancePaisa: balance },
      {
        balancePaisa: balance - input.amountPaisa,
        amountPaisa: input.amountPaisa,
        method: method.code,
      },
    );
    return {
      id: row.id,
      amountPaisa: input.amountPaisa,
      balancePaisa: balance - input.amountPaisa,
      replayed: false,
    };
  });
}

/** A manager corrects a balance up or down. Needs a reason; audited; never silent. */
export function adjustBalance(
  ctx: AppContext,
  a: Actor,
  accountId: string,
  input: { direction: 'UP' | 'DOWN'; amountPaisa: number; reason: string },
) {
  return withTx(ctx.db, async (trx) => {
    const acct = await accountWithCustomer(trx, a.branchId, accountId, true);
    const balance = await balanceOf(trx, acct.id);
    const kind = input.direction === 'UP' ? 'ADJUST_UP' : 'ADJUST_DOWN';
    await trx
      .insertInto('khata_entries')
      .values({
        account_id: acct.id,
        kind,
        amount_paisa: input.amountPaisa,
        note: input.reason,
        created_by: a.userId,
      })
      .execute();
    const after = balance + (input.direction === 'UP' ? input.amountPaisa : -input.amountPaisa);
    await audit(
      trx,
      a,
      'KHATA_ADJUST',
      acct.id,
      { balancePaisa: balance },
      { balancePaisa: after, direction: input.direction, amountPaisa: input.amountPaisa },
      input.reason,
    );
    return { balancePaisa: after };
  });
}

/**
 * A credit note on a khata-paid bill can be returned to the customer's account (their balance falls)
 * up to what the bill charged to khata, less what earlier credit notes already returned there.
 */
export async function refundToKhata(
  trx: Queryable,
  a: Actor,
  input: { billId: string; creditNoteId: string; amountPaisa: number; at: Date },
): Promise<{ customer: string; balancePaisa: number }> {
  const charge = await chargeOfBill(trx, input.billId);
  if (!charge) throw new AppError(409, 'KHATA_NOT_ON_BILL', 'This bill was not put on khata');
  const prior = await trx
    .selectFrom('khata_entries')
    .innerJoin('credit_notes', 'credit_notes.id', 'khata_entries.credit_note_id')
    .select(sql<number>`COALESCE(SUM(khata_entries.amount_paisa), 0)::bigint`.as('n'))
    .where('credit_notes.bill_id', '=', input.billId)
    .where('khata_entries.kind', '=', 'REFUND')
    .executeTakeFirstOrThrow();
  const room = charge.chargedPaisa - prior.n;
  if (input.amountPaisa > room)
    throw new AppError(409, 'KHATA_REFUND_EXCEEDS', 'More than this bill charged to khata', {
      maxPaisa: Math.max(0, room),
    });
  const acct = await accountWithCustomer(trx, a.branchId, charge.accountId, true);
  const balance = await balanceOf(trx, acct.id);
  await trx
    .insertInto('khata_entries')
    .values({
      account_id: acct.id,
      kind: 'REFUND',
      amount_paisa: input.amountPaisa,
      bill_id: input.billId,
      credit_note_id: input.creditNoteId,
      created_by: a.userId,
      created_at: input.at,
    })
    .execute();
  await audit(
    trx,
    a,
    'KHATA_REFUND',
    acct.id,
    { balancePaisa: balance },
    {
      balancePaisa: balance - input.amountPaisa,
      billId: input.billId,
      amountPaisa: input.amountPaisa,
    },
  );
  return { customer: acct.name, balancePaisa: balance - input.amountPaisa };
}
