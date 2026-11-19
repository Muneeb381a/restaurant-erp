import { HrError, leaveBalance, leaveDates, leaveHalfDays, type LeaveBalance } from '@erp/domain';
import { sql } from 'kysely';
import type { AppContext } from '../../http/context';
import { AppError } from '../../http/errors';
import { withTx, type Queryable } from '../../shared/tx';
import { writeAudit } from '../audit/audit.service';
import { getEmployee, type Actor } from './hr.service';

const act = (a: Actor) => ({
  branchId: a.branchId,
  userId: a.userId,
  deviceId: a.deviceId ?? null,
  ip: a.ip ?? null,
});

const bad = (message: string): AppError => new AppError(400, 'VALIDATION_FAILED', message);
const asBad = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof HrError) throw bad(e.message);
    throw e;
  }
};

// ─────────────────────────────── leave types ───────────────────────────────

/**
 * The kinds of leave a restaurant starts with. NO allowance is filled in: how many days a year is a legal
 * question (docs/OPEN-QUESTIONS.md #46), so each starts as "not limited" until the owner types a number.
 */
const DEFAULT_TYPES = [
  { code: 'ANNUAL', name: 'Annual leave', name_ur: 'سالانہ چھٹی', paid: true },
  { code: 'CASUAL', name: 'Casual leave', name_ur: 'اتفاقی چھٹی', paid: true },
  { code: 'SICK', name: 'Sick leave', name_ur: 'بیماری کی چھٹی', paid: true },
  { code: 'UNPAID', name: 'Unpaid leave', name_ur: 'بغیر تنخواہ چھٹی', paid: false },
] as const;

async function ensureTypes(q: Queryable, branchId: string): Promise<void> {
  const any = await q
    .selectFrom('leave_types')
    .select('id')
    .where('branch_id', '=', branchId)
    .limit(1)
    .executeTakeFirst();
  if (any) return;
  await q
    .insertInto('leave_types')
    .values(DEFAULT_TYPES.map((t) => ({ ...t, branch_id: branchId })))
    .onConflict((oc) => oc.columns(['branch_id', 'code']).doNothing())
    .execute();
}

const presentType = (t: {
  id: string;
  code: string;
  name: string;
  name_ur: string | null;
  paid: boolean;
  allowance_half_days: number | null;
  allow_negative: boolean;
  is_active: boolean;
}) => ({
  id: t.id,
  code: t.code,
  name: t.name,
  nameUr: t.name_ur,
  paid: t.paid,
  allowanceHalfDays: t.allowance_half_days,
  allowNegative: t.allow_negative,
  isActive: t.is_active,
});

export async function listLeaveTypes(ctx: AppContext, branchId: string) {
  await withTx(ctx.db, (trx) => ensureTypes(trx, branchId));
  const rows = await ctx.db
    .selectFrom('leave_types')
    .selectAll()
    .where('branch_id', '=', branchId)
    .orderBy('created_at')
    .orderBy('code')
    .execute();
  return rows.map(presentType);
}

export interface LeaveTypeInput {
  code?: string | undefined;
  name?: string | undefined;
  nameUr?: string | null | undefined;
  paid?: boolean | undefined;
  allowanceHalfDays?: number | null | undefined;
  allowNegative?: boolean | undefined;
  isActive?: boolean | undefined;
}

export function createLeaveType(ctx: AppContext, a: Actor, i: LeaveTypeInput) {
  return withTx(ctx.db, async (trx) => {
    await ensureTypes(trx, a.branchId);
    try {
      const row = await trx
        .insertInto('leave_types')
        .values({
          branch_id: a.branchId,
          code: i.code!,
          name: i.name!,
          name_ur: i.nameUr ?? null,
          paid: i.paid ?? true,
          allowance_half_days: i.allowanceHalfDays ?? null,
          allow_negative: i.allowNegative ?? false,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(trx, {
        ...act(a),
        action: 'LEAVE_TYPE_CREATE',
        entity: 'leave_type',
        entityId: row.id,
        after: presentType(row),
      });
      return presentType(row);
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        throw new AppError(409, 'CONFLICT', 'There is already a kind of leave with that code');
      throw e;
    }
  });
}

export function updateLeaveType(ctx: AppContext, a: Actor, id: string, i: LeaveTypeInput) {
  return withTx(ctx.db, async (trx) => {
    const before = await trx
      .selectFrom('leave_types')
      .selectAll()
      .where('id', '=', id)
      .where('branch_id', '=', a.branchId)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new AppError(404, 'NOT_FOUND', 'leave type not found');
    const set: Record<string, unknown> = {};
    if (i.name !== undefined) set.name = i.name;
    if (i.nameUr !== undefined) set.name_ur = i.nameUr;
    if (i.paid !== undefined) set.paid = i.paid;
    if (i.allowanceHalfDays !== undefined) set.allowance_half_days = i.allowanceHalfDays;
    if (i.allowNegative !== undefined) set.allow_negative = i.allowNegative;
    if (i.isActive !== undefined) set.is_active = i.isActive;
    const row =
      Object.keys(set).length === 0
        ? before
        : await trx
            .updateTable('leave_types')
            .set(set as never)
            .where('id', '=', id)
            .returningAll()
            .executeTakeFirstOrThrow();
    await writeAudit(trx, {
      ...act(a),
      action: 'LEAVE_TYPE_UPDATE',
      entity: 'leave_type',
      entityId: id,
      before: presentType(before),
      after: presentType(row),
    });
    return presentType(row);
  });
}

// ─────────────────────────────── balances ───────────────────────────────

const yearRange = (year: number): { from: string; to: string } => ({
  from: `${year}-01-01`,
  to: `${year}-12-31`,
});

/** Balances of one calendar year for the given people and every active kind of leave. */
export async function leaveBalances(
  ctx: AppContext,
  branchId: string,
  year: number,
  employeeId?: string,
) {
  await withTx(ctx.db, (trx) => ensureTypes(trx, branchId));
  const range = yearRange(year);
  const types = await ctx.db
    .selectFrom('leave_types')
    .selectAll()
    .where('branch_id', '=', branchId)
    .where('is_active', '=', true)
    .orderBy('created_at')
    .orderBy('code')
    .execute();
  let empQ = ctx.db
    .selectFrom('employees')
    .select(['id', 'code', 'full_name', 'full_name_ur'])
    .where('branch_id', '=', branchId)
    .where('status', '!=', 'LEFT')
    .orderBy('code');
  if (employeeId) empQ = empQ.where('id', '=', employeeId);
  const [emps, adj, reqs] = await Promise.all([
    empQ.execute(),
    ctx.db
      .selectFrom('leave_adjustments')
      .select(['employee_id', 'leave_type_id', 'half_days'])
      .where('branch_id', '=', branchId)
      .where('year', '=', year)
      .execute(),
    ctx.db
      .selectFrom('leave_requests')
      .select(['employee_id', 'leave_type_id', 'half_days', 'status'])
      .where('branch_id', '=', branchId)
      .where('status', 'in', ['PENDING', 'APPROVED'])
      .where('from_date', '>=', range.from)
      .where('from_date', '<=', range.to)
      .execute(),
  ]);
  const sum = <T extends { employee_id: string; leave_type_id: string; half_days: number }>(
    rows: T[],
    e: string,
    t: string,
  ): number =>
    rows
      .filter((r) => r.employee_id === e && r.leave_type_id === t)
      .reduce((n, r) => n + r.half_days, 0);
  return {
    year,
    types: types.map(presentType),
    employees: emps.map((e) => ({
      id: e.id,
      code: e.code,
      fullName: e.full_name,
      fullNameUr: e.full_name_ur,
      balances: Object.fromEntries(
        types.map((t) => [
          t.id,
          leaveBalance({
            allowance: t.allowance_half_days,
            adjustments: sum(adj, e.id, t.id),
            used: sum(
              reqs.filter((r) => r.status === 'APPROVED'),
              e.id,
              t.id,
            ),
            pending: sum(
              reqs.filter((r) => r.status === 'PENDING'),
              e.id,
              t.id,
            ),
          }),
        ]),
      ) as Record<string, LeaveBalance>,
    })),
  };
}

async function balanceOf(
  q: Queryable,
  branchId: string,
  employeeId: string,
  type: { id: string; allowance_half_days: number | null },
  year: number,
  exceptRequest?: string,
): Promise<LeaveBalance> {
  const range = yearRange(year);
  const adj = await q
    .selectFrom('leave_adjustments')
    .select('half_days')
    .where('employee_id', '=', employeeId)
    .where('leave_type_id', '=', type.id)
    .where('year', '=', year)
    .execute();
  let rq = q
    .selectFrom('leave_requests')
    .select(['half_days', 'status'])
    .where('employee_id', '=', employeeId)
    .where('leave_type_id', '=', type.id)
    .where('status', 'in', ['PENDING', 'APPROVED'])
    .where('from_date', '>=', range.from)
    .where('from_date', '<=', range.to);
  if (exceptRequest) rq = rq.where('id', '!=', exceptRequest);
  const reqs = await rq.execute();
  void branchId;
  return leaveBalance({
    allowance: type.allowance_half_days,
    adjustments: adj.reduce((n, r) => n + r.half_days, 0),
    used: reqs.filter((r) => r.status === 'APPROVED').reduce((n, r) => n + r.half_days, 0),
    pending: reqs.filter((r) => r.status === 'PENDING').reduce((n, r) => n + r.half_days, 0),
  });
}

export function adjustLeave(
  ctx: AppContext,
  a: Actor,
  i: { employeeId: string; leaveTypeId: string; year: number; halfDays: number; reason: string },
) {
  return withTx(ctx.db, async (trx) => {
    const emp = await getEmployee(trx, a.branchId, i.employeeId, true);
    const type = await trx
      .selectFrom('leave_types')
      .select('id')
      .where('id', '=', i.leaveTypeId)
      .where('branch_id', '=', a.branchId)
      .executeTakeFirst();
    if (!type) throw new AppError(404, 'NOT_FOUND', 'leave type not found');
    const row = await trx
      .insertInto('leave_adjustments')
      .values({
        branch_id: a.branchId,
        employee_id: i.employeeId,
        leave_type_id: i.leaveTypeId,
        year: i.year,
        half_days: i.halfDays,
        reason: i.reason,
        created_by: a.userId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await writeAudit(trx, {
      ...act(a),
      action: 'LEAVE_ADJUST',
      entity: 'leave_adjustment',
      entityId: row.id,
      reason: i.reason,
      after: { employee: emp.code, year: i.year, halfDays: i.halfDays },
    });
    return { id: row.id };
  });
}

// ─────────────────────────────── requests ───────────────────────────────

type RequestRow = {
  id: string;
  employee_id: string;
  leave_type_id: string;
  from_date: string;
  to_date: string;
  is_half_day: boolean;
  half_days: number;
  status: string;
  reason: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  created_at: Date;
  employee_name: string;
  employee_code: string;
  type_name: string;
  type_code: string;
  paid: boolean;
};

const presentRequest = (r: RequestRow) => ({
  id: r.id,
  employeeId: r.employee_id,
  employeeName: r.employee_name,
  employeeCode: r.employee_code,
  leaveTypeId: r.leave_type_id,
  typeName: r.type_name,
  typeCode: r.type_code,
  paid: r.paid,
  from: r.from_date,
  to: r.to_date,
  isHalfDay: r.is_half_day,
  halfDays: r.half_days,
  status: r.status,
  reason: r.reason,
  decidedAt: r.decided_at,
  decisionNote: r.decision_note,
  createdAt: r.created_at,
});

function requestQuery(q: Queryable, branchId: string) {
  return q
    .selectFrom('leave_requests as r')
    .innerJoin('employees as e', 'e.id', 'r.employee_id')
    .innerJoin('leave_types as t', 't.id', 'r.leave_type_id')
    .select([
      'r.id',
      'r.employee_id',
      'r.leave_type_id',
      'r.from_date',
      'r.to_date',
      'r.is_half_day',
      'r.half_days',
      'r.status',
      'r.reason',
      'r.decided_at',
      'r.decision_note',
      'r.created_at',
      'e.full_name as employee_name',
      'e.code as employee_code',
      't.name as type_name',
      't.code as type_code',
      't.paid',
    ])
    .where('r.branch_id', '=', branchId);
}

export async function listLeaveRequests(
  ctx: AppContext,
  branchId: string,
  f: {
    status?: string | undefined;
    employeeId?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
  },
) {
  let q = requestQuery(ctx.db, branchId);
  if (f.status) q = q.where('r.status', '=', f.status);
  if (f.employeeId) q = q.where('r.employee_id', '=', f.employeeId);
  if (f.from) q = q.where('r.to_date', '>=', f.from);
  if (f.to) q = q.where('r.from_date', '<=', f.to);
  const rows = await q
    .orderBy('r.from_date', 'desc')
    .orderBy('r.created_at', 'desc')
    .limit(500)
    .execute();
  return rows.map((r) => presentRequest(r as unknown as RequestRow));
}

async function holidaysIn(
  q: Queryable,
  branchId: string,
  from: string,
  to: string,
): Promise<Set<string>> {
  const rows = await q
    .selectFrom('holidays')
    .select('holiday_date')
    .where('branch_id', '=', branchId)
    .where('holiday_date', '>=', from)
    .where('holiday_date', '<=', to)
    .execute();
  return new Set(rows.map((r) => r.holiday_date));
}

export interface LeaveRequestInput {
  employeeId: string;
  leaveTypeId: string;
  from: string;
  to: string;
  half?: boolean | undefined;
  reason?: string | null | undefined;
  /** the manager entering it can approve it in the same step (the usual case: the staff member asks in person) */
  approve?: boolean | undefined;
}

export function createLeaveRequest(ctx: AppContext, a: Actor, i: LeaveRequestInput) {
  return withTx(ctx.db, async (trx) => {
    const emp = await getEmployee(trx, a.branchId, i.employeeId, true);
    await ensureTypes(trx, a.branchId);
    const type = await trx
      .selectFrom('leave_types')
      .selectAll()
      .where('id', '=', i.leaveTypeId)
      .where('branch_id', '=', a.branchId)
      .executeTakeFirst();
    if (!type || !type.is_active) throw new AppError(404, 'NOT_FOUND', 'leave type not found');
    if (i.from.slice(0, 4) !== i.to.slice(0, 4))
      throw bad('A leave cannot run across two years. Enter it as two requests (one per year).');
    if (emp.status === 'LEFT' || emp.join_date > i.from || (emp.left_date && emp.left_date < i.to))
      throw new AppError(
        409,
        'NOT_EMPLOYED_ON_DATE',
        'They are not employed for all of those days',
      );

    const holidays = await holidaysIn(trx, a.branchId, i.from, i.to);
    const half = i.half ?? false;
    const halfDays = asBad(() =>
      leaveHalfDays({ from: i.from, to: i.to, weeklyOff: emp.weekly_off, holidays, half }),
    );
    if (halfDays === 0)
      throw bad(
        'Those days are all days off or holidays for this person: nothing to take leave for.',
      );

    const clash = await trx
      .selectFrom('leave_requests')
      .select(['id', 'from_date', 'to_date'])
      .where('employee_id', '=', i.employeeId)
      .where('status', 'in', ['PENDING', 'APPROVED'])
      .where('from_date', '<=', i.to)
      .where('to_date', '>=', i.from)
      .execute();
    // two half-day requests on the same day are the one case that may share a date
    if (
      clash.length > 0 &&
      !(half && clash.every((c) => c.from_date === c.to_date && c.from_date === i.from))
    )
      throw new AppError(409, 'LEAVE_OVERLAP', 'They already have leave on some of those days', {
        from: clash[0]!.from_date,
        to: clash[0]!.to_date,
      });

    const year = Number(i.from.slice(0, 4));
    const bal = await balanceOf(trx, a.branchId, i.employeeId, type, year);
    if (
      bal.remainingAfterPending !== null &&
      bal.remainingAfterPending < halfDays &&
      !type.allow_negative
    )
      throw new AppError(409, 'LEAVE_BALANCE_EXCEEDED', 'Not enough leave left of this kind', {
        remainingHalfDays: bal.remainingAfterPending,
        requestedHalfDays: halfDays,
      });

    const row = await trx
      .insertInto('leave_requests')
      .values({
        branch_id: a.branchId,
        employee_id: i.employeeId,
        leave_type_id: i.leaveTypeId,
        from_date: i.from,
        to_date: i.to,
        is_half_day: half,
        half_days: halfDays,
        reason: i.reason ?? null,
        requested_by: a.userId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await writeAudit(trx, {
      ...act(a),
      action: 'LEAVE_REQUEST',
      entity: 'leave_request',
      entityId: row.id,
      reason: i.reason ?? null,
      after: { employee: emp.code, type: type.code, from: i.from, to: i.to, halfDays },
    });
    if (i.approve) await decide(trx, a, row.id, 'APPROVED', null);
    return (await loadRequest(trx, a.branchId, row.id))!;
  });
}

async function loadRequest(q: Queryable, branchId: string, id: string) {
  const r = await requestQuery(q, branchId).where('r.id', '=', id).executeTakeFirst();
  return r ? presentRequest(r as unknown as RequestRow) : null;
}

/** Approving writes the leave into attendance; rejecting just closes the request with a reason. */
async function decide(
  trx: Queryable,
  a: Actor,
  id: string,
  outcome: 'APPROVED' | 'REJECTED',
  note: string | null,
): Promise<void> {
  const req = await trx
    .selectFrom('leave_requests')
    .selectAll()
    .where('id', '=', id)
    .where('branch_id', '=', a.branchId)
    .forUpdate()
    .executeTakeFirst();
  if (!req) throw new AppError(404, 'NOT_FOUND', 'leave request not found');
  if (req.status !== 'PENDING')
    throw new AppError(409, 'CONFLICT', 'That request has already been decided');
  const emp = await getEmployee(trx, a.branchId, req.employee_id, true);

  if (outcome === 'APPROVED') {
    const type = await trx
      .selectFrom('leave_types')
      .selectAll()
      .where('id', '=', req.leave_type_id)
      .executeTakeFirstOrThrow();
    const bal = await balanceOf(
      trx,
      a.branchId,
      req.employee_id,
      type,
      Number(req.from_date.slice(0, 4)),
      id,
    );
    if (bal.remaining !== null && bal.remaining < req.half_days && !type.allow_negative)
      throw new AppError(409, 'LEAVE_BALANCE_EXCEEDED', 'Not enough leave left of this kind', {
        remainingHalfDays: bal.remaining,
        requestedHalfDays: req.half_days,
      });
    const holidays = await holidaysIn(trx, a.branchId, req.from_date, req.to_date);
    const dates = leaveDates({
      from: req.from_date,
      to: req.to_date,
      weeklyOff: emp.weekly_off,
      holidays,
    });
    const existing = await trx
      .selectFrom('attendance')
      .select(['id', 'work_date', 'status', 'leave_request_id'])
      .where('employee_id', '=', req.employee_id)
      .where('work_date', 'in', dates)
      .forUpdate()
      .execute();
    const worked = existing.find(
      (r) => r.status === 'PRESENT' || (r.status === 'HALF_DAY' && !req.is_half_day),
    );
    if (worked)
      throw new AppError(
        409,
        'LEAVE_OVERLAPS_ATTENDANCE',
        'They are marked present on a day of this leave',
        {
          date: worked.work_date,
        },
      );
    // a half-day leave is written as a HALF_DAY (they work the other half); full days as LEAVE
    const status = req.is_half_day ? 'HALF_DAY' : 'LEAVE';
    for (const d of dates) {
      await trx
        .insertInto('attendance')
        .values({
          branch_id: a.branchId,
          employee_id: req.employee_id,
          work_date: d,
          status,
          source: 'MANUAL',
          note: 'leave',
          marked_by: a.userId,
          leave_request_id: id,
        })
        .onConflict((oc) =>
          oc.columns(['employee_id', 'work_date']).doUpdateSet({
            status,
            note: 'leave',
            marked_by: a.userId,
            leave_request_id: id,
            late_minutes: 0,
            overtime_minutes: 0,
            worked_minutes: null,
            clock_in: null,
            clock_out: null,
          }),
        )
        .execute();
    }
  }

  await trx
    .updateTable('leave_requests')
    .set({
      status: outcome,
      decided_by: a.userId,
      decided_at: sql<Date>`now()`,
      decision_note: note,
    })
    .where('id', '=', id)
    .execute();
  await writeAudit(trx, {
    ...act(a),
    action: outcome === 'APPROVED' ? 'LEAVE_APPROVE' : 'LEAVE_REJECT',
    entity: 'leave_request',
    entityId: id,
    reason: note,
    after: { employee: emp.code, from: req.from_date, to: req.to_date, halfDays: req.half_days },
  });
}

export function decideLeave(
  ctx: AppContext,
  a: Actor,
  id: string,
  outcome: 'APPROVED' | 'REJECTED',
  note: string | null,
) {
  return withTx(ctx.db, async (trx) => {
    if (outcome === 'REJECTED' && !note?.trim()) throw bad('Say why it is refused');
    await decide(trx, a, id, outcome, note?.trim() || null);
    return (await loadRequest(trx, a.branchId, id))!;
  });
}

/** Cancelling an approved leave takes its days out of attendance again. A reason is required. */
export function cancelLeave(ctx: AppContext, a: Actor, id: string, note: string) {
  return withTx(ctx.db, async (trx) => {
    if (!note.trim()) throw bad('Say why it is cancelled');
    const req = await trx
      .selectFrom('leave_requests')
      .selectAll()
      .where('id', '=', id)
      .where('branch_id', '=', a.branchId)
      .forUpdate()
      .executeTakeFirst();
    if (!req) throw new AppError(404, 'NOT_FOUND', 'leave request not found');
    if (req.status !== 'PENDING' && req.status !== 'APPROVED')
      throw new AppError(409, 'CONFLICT', 'Only a waiting or approved leave can be cancelled');
    let removed = 0;
    if (req.status === 'APPROVED') {
      const gone = await trx
        .deleteFrom('attendance')
        .where('leave_request_id', '=', id)
        .returning('id')
        .execute();
      removed = gone.length;
    }
    await trx
      .updateTable('leave_requests')
      .set({
        status: 'CANCELLED',
        decided_by: a.userId,
        decided_at: sql<Date>`now()`,
        decision_note: note.trim(),
      })
      .where('id', '=', id)
      .execute();
    await writeAudit(trx, {
      ...act(a),
      action: 'LEAVE_CANCEL',
      entity: 'leave_request',
      entityId: id,
      reason: note.trim(),
      before: { status: req.status },
      after: { attendanceDaysRemoved: removed },
    });
    return (await loadRequest(trx, a.branchId, id))!;
  });
}
