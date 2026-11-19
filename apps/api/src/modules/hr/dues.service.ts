import { installmentsLeft } from '@erp/domain';
import { sql } from 'kysely';
import type { AppContext } from '../../http/context';
import { AppError } from '../../http/errors';
import { withTx } from '../../shared/tx';
import { writeAudit } from '../audit/audit.service';
import { createExpenseTx } from '../inventory/inventory.service';
import type { Actor as OrdersActor } from '../orders/orders.service';
import { getEmployee, type Actor } from './hr.service';

const act = (a: Actor) => ({
  branchId: a.branchId,
  userId: a.userId,
  deviceId: a.deviceId ?? null,
  ip: a.ip ?? null,
});
const bad = (m: string): AppError => new AppError(400, 'VALIDATION_FAILED', m);

export interface DueRow {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  employeeStatus: string;
  kind: 'ADVANCE' | 'LOAN' | 'FINE';
  reason: string;
  principalPaisa: number;
  installmentPaisa: number;
  recoveredPaisa: number;
  writtenOffPaisa: number;
  balancePaisa: number;
  installmentsLeft: number | null;
  paused: boolean;
  closed: boolean;
  createdAt: Date;
}

/** Dues with their balance worked out from the ledger. `open` = something is still owed and it is not closed. */
export async function listDues(
  ctx: AppContext,
  branchId: string,
  f: { employeeId?: string | undefined; open?: boolean | undefined },
): Promise<DueRow[]> {
  let q = ctx.db
    .selectFrom('staff_dues as d')
    .innerJoin('employees as e', 'e.id', 'd.employee_id')
    .select([
      'd.id',
      'd.employee_id',
      'd.kind',
      'd.reason',
      'd.principal_paisa',
      'd.installment_paisa',
      'd.paused',
      'd.closed_at',
      'd.created_at',
      'e.code',
      'e.full_name',
      'e.status',
    ])
    .where('d.branch_id', '=', branchId);
  if (f.employeeId) q = q.where('d.employee_id', '=', f.employeeId);
  const dues = await q.orderBy('d.created_at', 'desc').limit(500).execute();
  if (dues.length === 0) return [];
  const entries = await ctx.db
    .selectFrom('staff_due_entries')
    .select(['due_id', 'kind', 'amount_paisa'])
    .where(
      'due_id',
      'in',
      dues.map((d) => d.id),
    )
    .execute();
  const rows = dues.map((d): DueRow => {
    const mine = entries.filter((e) => e.due_id === d.id);
    const sum = (k: string): number =>
      mine.filter((e) => e.kind === k).reduce((n, e) => n + e.amount_paisa, 0);
    const balance = sum('DISBURSE') + sum('FINE') - sum('RECOVERY') - sum('WRITE_OFF');
    return {
      id: d.id,
      employeeId: d.employee_id,
      employeeCode: d.code,
      employeeName: d.full_name,
      employeeStatus: d.status,
      kind: d.kind as DueRow['kind'],
      reason: d.reason,
      principalPaisa: d.principal_paisa,
      installmentPaisa: d.installment_paisa,
      recoveredPaisa: sum('RECOVERY'),
      writtenOffPaisa: sum('WRITE_OFF'),
      balancePaisa: balance,
      installmentsLeft: installmentsLeft(balance, d.installment_paisa),
      paused: d.paused,
      closed: d.closed_at !== null,
      createdAt: d.created_at,
    };
  });
  return f.open ? rows.filter((r) => r.balancePaisa > 0 && !r.closed) : rows;
}

export interface DueInput {
  employeeId: string;
  kind: 'ADVANCE' | 'LOAN' | 'FINE';
  amountPaisa: number;
  /** taken from each pay run; an advance or a fine defaults to the whole amount at the next payslip */
  installmentPaisa?: number | undefined;
  reason: string;
  /** where the cash came from (advance and loan only) */
  paidFrom?: 'DRAWER_CASH' | 'OWNER_CASH' | 'BANK' | undefined;
}

/**
 * Gives an advance or a loan (cash goes out through the expenses ledger) or charges a fine (nothing goes out).
 * Giving money needs `payroll.pay`; every case needs `payroll.manage`. Idempotent on the key.
 */
export function createDue(ctx: AppContext, a: OrdersActor, i: DueInput, key: string) {
  return withTx(ctx.db, async (trx) => {
    const dup = await trx
      .selectFrom('staff_dues')
      .select('id')
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
    if (dup) return { id: dup.id, replayed: true as const };
    const gives = i.kind !== 'FINE';
    if (gives && !a.permissions.has('payroll.pay'))
      throw new AppError(403, 'PERMISSION_DENIED', 'You do not have permission for this action', {
        permission: 'payroll.pay',
      });
    if (gives && !i.paidFrom) throw bad('Say where the money is paid from');
    const installment = i.installmentPaisa ?? (i.kind === 'LOAN' ? 0 : i.amountPaisa);
    if (i.kind === 'LOAN' && installment <= 0)
      throw bad('A loan needs an instalment (how much to take each pay run)');
    if (installment > i.amountPaisa) throw bad('The instalment cannot be more than the amount');
    const emp = await getEmployee(trx, a.branchId, i.employeeId, true);
    if (emp.status === 'LEFT')
      throw new AppError(
        409,
        'NOT_EMPLOYED_ON_DATE',
        'This person has left; settle with them directly',
      );

    let expenseId: string | null = null;
    if (gives) {
      const exp = await createExpenseTx(
        trx,
        ctx,
        a,
        {
          category: 'STAFF_ADVANCE',
          amountPaisa: i.amountPaisa,
          paidFrom: i.paidFrom!,
          note: `${i.kind === 'LOAN' ? 'Loan' : 'Advance'} ${emp.code} ${emp.full_name}: ${i.reason}`,
        },
        `${key}:expense`,
      );
      expenseId = exp.id;
    }
    const due = await trx
      .insertInto('staff_dues')
      .values({
        branch_id: a.branchId,
        employee_id: i.employeeId,
        kind: i.kind,
        principal_paisa: i.amountPaisa,
        installment_paisa: installment,
        reason: i.reason,
        expense_id: expenseId,
        created_by: a.userId,
        idempotency_key: key,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('staff_due_entries')
      .values({
        due_id: due.id,
        kind: gives ? 'DISBURSE' : 'FINE',
        amount_paisa: i.amountPaisa,
        note: i.reason,
        created_by: a.userId,
      })
      .execute();
    await writeAudit(trx, {
      ...act(a),
      action: gives ? 'STAFF_DUE_GIVE' : 'STAFF_DUE_FINE',
      entity: 'staff_due',
      entityId: due.id,
      reason: i.reason,
      after: {
        employee: emp.code,
        kind: i.kind,
        amountPaisa: i.amountPaisa,
        installmentPaisa: installment,
      },
    });
    return { id: due.id, replayed: false as const };
  });
}

export function setDuePaused(ctx: AppContext, a: Actor, id: string, paused: boolean) {
  return withTx(ctx.db, async (trx) => {
    const d = await trx
      .selectFrom('staff_dues')
      .select(['id', 'paused'])
      .where('id', '=', id)
      .where('branch_id', '=', a.branchId)
      .forUpdate()
      .executeTakeFirst();
    if (!d) throw new AppError(404, 'NOT_FOUND', 'not found');
    await trx.updateTable('staff_dues').set({ paused }).where('id', '=', id).execute();
    await writeAudit(trx, {
      ...act(a),
      action: paused ? 'STAFF_DUE_PAUSE' : 'STAFF_DUE_RESUME',
      entity: 'staff_due',
      entityId: id,
    });
  });
}

/** The owner forgives what is still owed. The ledger keeps the story: given, recovered, written off. */
export function writeOffDue(ctx: AppContext, a: Actor, id: string, reason: string) {
  return withTx(ctx.db, async (trx) => {
    const d = await trx
      .selectFrom('staff_dues')
      .select(['id', 'closed_at'])
      .where('id', '=', id)
      .where('branch_id', '=', a.branchId)
      .forUpdate()
      .executeTakeFirst();
    if (!d) throw new AppError(404, 'NOT_FOUND', 'not found');
    const bal = (
      await sql<{
        b: string;
      }>`select coalesce(sum(case when kind in ('DISBURSE','FINE') then amount_paisa else -amount_paisa end), 0) as b from staff_due_entries where due_id = ${id}`.execute(
        trx,
      )
    ).rows[0]!.b;
    const balance = Number(bal);
    if (balance <= 0 || d.closed_at)
      throw new AppError(409, 'CONFLICT', 'Nothing is owed on this one any more');
    await trx
      .insertInto('staff_due_entries')
      .values({
        due_id: id,
        kind: 'WRITE_OFF',
        amount_paisa: balance,
        note: reason,
        created_by: a.userId,
      })
      .execute();
    await trx
      .updateTable('staff_dues')
      .set({ closed_at: sql<Date>`now()` })
      .where('id', '=', id)
      .execute();
    await writeAudit(trx, {
      ...act(a),
      action: 'STAFF_DUE_WRITE_OFF',
      entity: 'staff_due',
      entityId: id,
      reason,
      after: { writtenOffPaisa: balance },
    });
    return { writtenOffPaisa: balance };
  });
}
