import {
  addDays,
  autoStatus,
  computeSlip,
  DEFAULT_PAYROLL_SETTINGS,
  monthDays,
  normalizeShift,
  PayrollError,
  shiftMinutes,
  slipTotals,
  tallyDays,
  type AttendanceStatus,
  dueBalance,
  recoveryAmount,
  type DayFacts,
  type PayrollSettings,
  type SlipLine,
} from '@erp/domain';
import type { AppContext } from '../../http/context';
import { AppError } from '../../http/errors';
import { withTx, type Queryable } from '../../shared/tx';
import { writeAudit } from '../audit/audit.service';
import { createExpenseTx } from '../inventory/inventory.service';
import type { Actor as OrdersActor } from '../orders/orders.service';
import { localParts, type Actor } from './hr.service';

const act = (a: Actor) => ({
  branchId: a.branchId,
  userId: a.userId,
  deviceId: a.deviceId ?? null,
  ip: a.ip ?? null,
});
const bad = (m: string): AppError => new AppError(400, 'VALIDATION_FAILED', m);
const isUnique = (e: unknown): boolean => (e as { code?: string }).code === '23505';

// ─────────────────────────────── settings ───────────────────────────────

/** The owner's payroll settings. Every one defaults to the safe, "do nothing legal" choice. */
export async function payrollSettings(q: Queryable, branchId: string): Promise<PayrollSettings> {
  const rows = await q
    .selectFrom('settings')
    .select(['key', 'value'])
    .where('branch_id', '=', branchId)
    .where('key', 'like', 'payroll.%')
    .execute();
  const get = (k: string): unknown => rows.find((r) => r.key === k)?.value;
  const d = DEFAULT_PAYROLL_SETTINGS;
  const num = (k: string, dflt: number): number => {
    const v = get(k);
    return typeof v === 'number' ? v : dflt;
  };
  const bool = (k: string, dflt: boolean): boolean => {
    const v = get(k);
    return typeof v === 'boolean' ? v : dflt;
  };
  const div = get('payroll.divisor');
  return {
    divisor: div === 'CALENDAR' || div === 'THIRTY' ? div : d.divisor,
    overtimeEnabled: bool('payroll.overtime_enabled', d.overtimeEnabled),
    overtimeMultiplierBps: num('payroll.overtime_multiplier_bps', d.overtimeMultiplierBps),
    latesPerDeductionDay: num('payroll.lates_per_deduction_day', d.latesPerDeductionDay),
    dailyPaidOffDays: bool('payroll.daily_paid_off_days', d.dailyPaidOffDays),
    defaultShiftMinutes: num('payroll.default_shift_minutes', d.defaultShiftMinutes),
  };
}

// ─────────────────────────────── pay items ───────────────────────────────

export async function listPayItems(ctx: AppContext, branchId: string, employeeId: string) {
  const rows = await ctx.db
    .selectFrom('employee_pay_items')
    .selectAll()
    .where('branch_id', '=', branchId)
    .where('employee_id', '=', employeeId)
    .orderBy('created_at')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    amountPaisa: r.amount_paisa,
    isActive: r.is_active,
  }));
}

export function addPayItem(
  ctx: AppContext,
  a: Actor,
  employeeId: string,
  i: { kind: 'ALLOWANCE' | 'DEDUCTION'; name: string; amountPaisa: number },
) {
  return withTx(ctx.db, async (trx) => {
    const emp = await trx
      .selectFrom('employees')
      .select('code')
      .where('id', '=', employeeId)
      .where('branch_id', '=', a.branchId)
      .executeTakeFirst();
    if (!emp) throw new AppError(404, 'NOT_FOUND', 'employee not found');
    const row = await trx
      .insertInto('employee_pay_items')
      .values({
        branch_id: a.branchId,
        employee_id: employeeId,
        kind: i.kind,
        name: i.name,
        amount_paisa: i.amountPaisa,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await writeAudit(trx, {
      ...act(a),
      action: 'PAY_ITEM_ADD',
      entity: 'employee_pay_item',
      entityId: row.id,
      after: { employee: emp.code, ...i },
    });
    return { id: row.id };
  });
}

export function updatePayItem(
  ctx: AppContext,
  a: Actor,
  id: string,
  i: {
    name?: string | undefined;
    amountPaisa?: number | undefined;
    isActive?: boolean | undefined;
  },
) {
  return withTx(ctx.db, async (trx) => {
    const before = await trx
      .selectFrom('employee_pay_items')
      .selectAll()
      .where('id', '=', id)
      .where('branch_id', '=', a.branchId)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new AppError(404, 'NOT_FOUND', 'pay item not found');
    const set: Record<string, unknown> = {};
    if (i.name !== undefined) set.name = i.name;
    if (i.amountPaisa !== undefined) set.amount_paisa = i.amountPaisa;
    if (i.isActive !== undefined) set.is_active = i.isActive;
    if (Object.keys(set).length)
      await trx
        .updateTable('employee_pay_items')
        .set(set as never)
        .where('id', '=', id)
        .execute();
    await writeAudit(trx, {
      ...act(a),
      action: 'PAY_ITEM_UPDATE',
      entity: 'employee_pay_item',
      entityId: id,
      before: { name: before.name, amountPaisa: before.amount_paisa, isActive: before.is_active },
      after: i,
    });
  });
}

// ─────────────────────────────── building a payslip ───────────────────────────────

interface RunPeriod {
  id?: string;
  frequency: 'MONTHLY' | 'WEEKLY' | 'DAILY';
  from: string;
  to: string;
}

type Emp = {
  id: string;
  code: string;
  full_name: string;
  pay_type: string;
  base_pay_paisa: number;
  pay_frequency: string;
  weekly_off: number[];
  shift_start: string | null;
  shift_end: string | null;
  join_date: string;
  left_date: string | null;
};

const toMin = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

function datesOf(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

interface Built {
  lines: (SlipLine & { source: 'COMPUTED' | 'ITEM' | 'RECOVERY'; dueId?: string })[];
  tally: Record<string, number>;
  workedMinutes: number;
  lateCount: number;
  lateMinutes: number;
  overtimeMinutes: number;
  warnings: string[];
}

async function buildSlip(
  q: Queryable,
  branchId: string,
  emp: Emp,
  period: RunPeriod,
  settings: PayrollSettings,
  holidays: ReadonlySet<string>,
): Promise<Built> {
  const rows = await q
    .selectFrom('attendance as a')
    .leftJoin('leave_requests as lr', 'lr.id', 'a.leave_request_id')
    .leftJoin('leave_types as lt', 'lt.id', 'lr.leave_type_id')
    .select([
      'a.work_date',
      'a.status',
      'a.worked_minutes',
      'a.late_minutes',
      'a.overtime_minutes',
      'a.leave_request_id',
      'lt.paid as leave_paid',
      'lr.is_half_day as leave_half',
    ])
    .where('a.employee_id', '=', emp.id)
    .where('a.work_date', '>=', period.from)
    .where('a.work_date', '<=', period.to)
    .execute();
  const byDate = new Map(rows.map((r) => [r.work_date, r]));
  const facts: DayFacts[] = datesOf(period.from, period.to).map((d) => {
    const r = byDate.get(d);
    return {
      status: (r?.status as AttendanceStatus | undefined) ?? null,
      leave: r?.leave_request_id
        ? { paid: r.leave_paid ?? true, half: r.leave_half ?? false }
        : null,
      calendarOff: autoStatus(d, emp.weekly_off, holidays) !== null,
      employed: emp.join_date <= d && (emp.left_date === null || emp.left_date >= d),
    };
  });
  const tally = tallyDays(facts);
  const workedMinutes = rows.reduce((n, r) => n + (r.worked_minutes ?? 0), 0);
  const lateMinutes = rows.reduce((n, r) => n + r.late_minutes, 0);
  const lateCount = rows.filter((r) => r.late_minutes > 0).length;
  const overtimeMinutes = rows.reduce((n, r) => n + r.overtime_minutes, 0);
  const shift =
    emp.shift_start && emp.shift_end
      ? shiftMinutes(
          normalizeShift({ startMin: toMin(emp.shift_start), endMin: toMin(emp.shift_end) }),
        )
      : null;

  const out = computeSlip({
    payType: emp.pay_type as 'MONTHLY' | 'DAILY' | 'HOURLY',
    ratePaisa: emp.base_pay_paisa,
    monthDays: monthDays(period.from.slice(0, 7)).length,
    tally,
    workedMinutes,
    lateCount,
    overtimeMinutes,
    shiftMinutes: shift,
    settings,
  });
  const lines: Built['lines'] = out.lines.map((l) => ({ ...l, source: 'COMPUTED' as const }));

  const items = await q
    .selectFrom('employee_pay_items')
    .selectAll()
    .where('employee_id', '=', emp.id)
    .where('is_active', '=', true)
    .orderBy('created_at')
    .execute();
  for (const it of items)
    lines.push({
      kind: it.kind === 'ALLOWANCE' ? 'EARNING' : 'DEDUCTION',
      code: it.kind === 'ALLOWANCE' ? 'ALLOWANCE' : 'DEDUCTION',
      label: it.name,
      amountPaisa: it.amount_paisa,
      source: 'ITEM',
    });
  // money the person owes (advance, loan, fine): the agreed instalment, never more than is owed or than the pay left
  const dues = await q
    .selectFrom('staff_dues')
    .select(['id', 'kind', 'reason', 'installment_paisa', 'paused', 'closed_at'])
    .where('employee_id', '=', emp.id)
    .where('closed_at', 'is', null)
    .orderBy('created_at')
    .execute();
  for (const d of dues) {
    const ents = await q
      .selectFrom('staff_due_entries')
      .select(['kind', 'amount_paisa'])
      .where('due_id', '=', d.id)
      .execute();
    const balance = dueBalance(
      ents.map((e) => ({
        kind: e.kind as 'DISBURSE' | 'FINE' | 'RECOVERY' | 'WRITE_OFF',
        amountPaisa: e.amount_paisa,
      })),
    );
    const net = slipTotals(lines).netPaisa;
    const take = recoveryAmount({
      balancePaisa: balance,
      installmentPaisa: d.installment_paisa,
      netBeforePaisa: net,
      paused: d.paused,
      closed: d.closed_at !== null,
    });
    if (take > 0)
      lines.push({
        kind: 'DEDUCTION',
        code: 'RECOVERY',
        label: `${d.kind === 'FINE' ? 'Fine' : d.kind === 'LOAN' ? 'Loan' : 'Advance'}: ${d.reason}`,
        detail: `still owed after this: ${((balance - take) / 100).toLocaleString('en-US')} Rs`,
        amountPaisa: take,
        source: 'RECOVERY',
        dueId: d.id,
      });
  }
  void branchId;
  return {
    lines,
    tally: { ...tally },
    workedMinutes,
    lateCount,
    lateMinutes,
    overtimeMinutes,
    warnings: out.warnings,
  };
}

async function refreshTotals(q: Queryable, slipId: string): Promise<void> {
  const lines = await q
    .selectFrom('payslip_lines')
    .select(['kind', 'amount_paisa'])
    .where('payslip_id', '=', slipId)
    .execute();
  const t = slipTotals(
    lines.map((l) => ({ kind: l.kind as 'EARNING' | 'DEDUCTION', amountPaisa: l.amount_paisa })),
  );
  await q
    .updateTable('payslips')
    .set({ gross_paisa: t.grossPaisa, deductions_paisa: t.deductionsPaisa, net_paisa: t.netPaisa })
    .where('id', '=', slipId)
    .execute();
}

async function insertLines(
  q: Queryable,
  slipId: string,
  lines: Built['lines'],
  startAt: number,
): Promise<void> {
  let n = startAt;
  for (const l of lines)
    await q
      .insertInto('payslip_lines')
      .values({
        payslip_id: slipId,
        kind: l.kind,
        code: l.code,
        label: l.label,
        detail: l.detail ?? null,
        amount_paisa: l.amountPaisa,
        source: l.source,
        due_id: l.dueId ?? null,
        sort_no: n++,
      })
      .execute();
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

/** Who belongs in a run: employed during the period, paid with this frequency. A monthly salary only fits a monthly run. */
async function eligible(
  q: Queryable,
  branchId: string,
  p: RunPeriod,
): Promise<{ emps: Emp[]; skipped: string[] }> {
  const all = (await q
    .selectFrom('employees')
    .selectAll()
    .where('branch_id', '=', branchId)
    .where('join_date', '<=', p.to)
    .where((eb) => eb.or([eb('left_date', 'is', null), eb('left_date', '>=', p.from)]))
    .orderBy('code')
    .execute()) as unknown as Emp[];
  const emps: Emp[] = [];
  const skipped: string[] = [];
  for (const e of all) {
    if (e.pay_frequency !== p.frequency) continue;
    if (e.pay_type === 'MONTHLY' && p.frequency !== 'MONTHLY') {
      skipped.push(e.code);
      continue;
    }
    emps.push(e);
  }
  return { emps, skipped };
}

// ─────────────────────────────── runs ───────────────────────────────

export function periodFor(
  frequency: 'MONTHLY' | 'WEEKLY' | 'DAILY',
  i: { month?: string | undefined; from?: string | undefined },
): { from: string; to: string } {
  if (frequency === 'MONTHLY') {
    if (!i.month) throw bad('Choose the month');
    const d = monthDays(i.month);
    return { from: d[0]!, to: d[d.length - 1]! };
  }
  if (!i.from) throw bad('Choose the first day');
  return { from: i.from, to: frequency === 'DAILY' ? i.from : addDays(i.from, 6) };
}

export function createRun(
  ctx: AppContext,
  a: Actor,
  i: {
    frequency: 'MONTHLY' | 'WEEKLY' | 'DAILY';
    month?: string | undefined;
    from?: string | undefined;
    note?: string | null | undefined;
  },
) {
  return withTx(ctx.db, async (trx) => {
    let per: { from: string; to: string };
    try {
      per = periodFor(i.frequency, i);
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw bad((e as Error).message);
    }
    const period: RunPeriod = { frequency: i.frequency, ...per };
    const last = await trx
      .selectFrom('payroll_runs')
      .select('run_no')
      .where('branch_id', '=', a.branchId)
      .orderBy('run_no', 'desc')
      .limit(1)
      .forUpdate()
      .executeTakeFirst();
    let run;
    try {
      run = await trx
        .insertInto('payroll_runs')
        .values({
          branch_id: a.branchId,
          run_no: (last?.run_no ?? 0) + 1,
          frequency: i.frequency,
          period_from: per.from,
          period_to: per.to,
          note: i.note ?? null,
          created_by: a.userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
    } catch (e) {
      if (isUnique(e))
        throw new AppError(409, 'PAYROLL_RUN_EXISTS', 'There is already a pay run for that period');
      throw e;
    }
    const { skipped } = await fillRun(trx, a.branchId, run.id, period);
    await writeAudit(trx, {
      ...act(a),
      action: 'PAYROLL_RUN_CREATE',
      entity: 'payroll_run',
      entityId: run.id,
      after: { ...per, frequency: i.frequency },
    });
    return { id: run.id, skippedMonthlyPaid: skipped };
  });
}

/** Adds a draft payslip for everybody in the period who does not have one yet. */
async function fillRun(
  trx: Queryable,
  branchId: string,
  runId: string,
  period: RunPeriod,
): Promise<{ skipped: string[] }> {
  const settings = await payrollSettings(trx, branchId);
  const holidays = await holidaysIn(trx, branchId, period.from, period.to);
  const { emps, skipped } = await eligible(trx, branchId, period);
  const have = new Set(
    (
      await trx.selectFrom('payslips').select('employee_id').where('run_id', '=', runId).execute()
    ).map((r) => r.employee_id),
  );
  for (const e of emps) {
    if (have.has(e.id)) continue;
    const b = await buildSlip(trx, branchId, e, period, settings, holidays);
    const slip = await trx
      .insertInto('payslips')
      .values({
        branch_id: branchId,
        run_id: runId,
        employee_id: e.id,
        pay_type: e.pay_type,
        rate_paisa: e.base_pay_paisa,
        tally: b.tally as never,
        worked_minutes: b.workedMinutes,
        late_count: b.lateCount,
        late_minutes: b.lateMinutes,
        overtime_minutes: b.overtimeMinutes,
        warnings: b.warnings,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await insertLines(trx, slip.id, b.lines, 0);
    await refreshTotals(trx, slip.id);
  }
  return { skipped };
}

async function lockRun(trx: Queryable, branchId: string, id: string) {
  const run = await trx
    .selectFrom('payroll_runs')
    .selectAll()
    .where('id', '=', id)
    .where('branch_id', '=', branchId)
    .forUpdate()
    .executeTakeFirst();
  if (!run) throw new AppError(404, 'NOT_FOUND', 'pay run not found');
  return run;
}

const draftOnly = (status: string): void => {
  if (status !== 'DRAFT')
    throw new AppError(
      409,
      'PAYROLL_NOT_EDITABLE',
      'This pay run is no longer a draft and cannot change',
    );
};

/** Re-reads attendance, leave, holidays, rates and recurring items; keeps the manual lines. Draft only. */
async function recalc(
  trx: Queryable,
  branchId: string,
  run: { id: string; frequency: string; period_from: string; period_to: string },
): Promise<void> {
  const period: RunPeriod = {
    frequency: run.frequency as RunPeriod['frequency'],
    from: run.period_from,
    to: run.period_to,
  };
  const settings = await payrollSettings(trx, branchId);
  const holidays = await holidaysIn(trx, branchId, period.from, period.to);
  const slips = await trx
    .selectFrom('payslips')
    .select(['id', 'employee_id'])
    .where('run_id', '=', run.id)
    .execute();
  for (const s of slips) {
    const e = (await trx
      .selectFrom('employees')
      .selectAll()
      .where('id', '=', s.employee_id)
      .executeTakeFirstOrThrow()) as unknown as Emp;
    const b = await buildSlip(trx, branchId, e, period, settings, holidays);
    await trx
      .deleteFrom('payslip_lines')
      .where('payslip_id', '=', s.id)
      .where('source', 'in', ['COMPUTED', 'ITEM', 'RECOVERY'])
      .execute();
    const manual = await trx
      .selectFrom('payslip_lines')
      .select(({ fn }) => fn.max('sort_no').as('m'))
      .where('payslip_id', '=', s.id)
      .executeTakeFirst();
    await insertLines(trx, s.id, b.lines, (manual?.m ?? -1) + 1);
    await trx
      .updateTable('payslips')
      .set({
        pay_type: e.pay_type,
        rate_paisa: e.base_pay_paisa,
        tally: b.tally as never,
        worked_minutes: b.workedMinutes,
        late_count: b.lateCount,
        late_minutes: b.lateMinutes,
        overtime_minutes: b.overtimeMinutes,
        warnings: b.warnings,
      })
      .where('id', '=', s.id)
      .execute();
    await refreshTotals(trx, s.id);
  }
  await fillRun(trx, branchId, run.id, period);
}

export function recalculateRun(ctx: AppContext, a: Actor, id: string) {
  return withTx(ctx.db, async (trx) => {
    const run = await lockRun(trx, a.branchId, id);
    draftOnly(run.status);
    await recalc(trx, a.branchId, run);
    await writeAudit(trx, {
      ...act(a),
      action: 'PAYROLL_RUN_RECALC',
      entity: 'payroll_run',
      entityId: id,
    });
    return { id };
  });
}

export function cancelRun(ctx: AppContext, a: Actor, id: string, reason: string) {
  return withTx(ctx.db, async (trx) => {
    const run = await lockRun(trx, a.branchId, id);
    draftOnly(run.status);
    await trx
      .updateTable('payroll_runs')
      .set({ status: 'CANCELLED', cancel_reason: reason })
      .where('id', '=', id)
      .execute();
    await writeAudit(trx, {
      ...act(a),
      action: 'PAYROLL_RUN_CANCEL',
      entity: 'payroll_run',
      entityId: id,
      reason,
    });
  });
}

export function addManualLine(
  ctx: AppContext,
  a: Actor,
  slipId: string,
  i: { kind: 'EARNING' | 'DEDUCTION'; label: string; amountPaisa: number },
) {
  return withTx(ctx.db, async (trx) => {
    const slip = await trx
      .selectFrom('payslips')
      .select(['id', 'run_id', 'employee_id'])
      .where('id', '=', slipId)
      .where('branch_id', '=', a.branchId)
      .executeTakeFirst();
    if (!slip) throw new AppError(404, 'NOT_FOUND', 'payslip not found');
    const run = await lockRun(trx, a.branchId, slip.run_id);
    draftOnly(run.status);
    const max = await trx
      .selectFrom('payslip_lines')
      .select(({ fn }) => fn.max('sort_no').as('m'))
      .where('payslip_id', '=', slipId)
      .executeTakeFirst();
    const row = await trx
      .insertInto('payslip_lines')
      .values({
        payslip_id: slipId,
        kind: i.kind,
        code: 'MANUAL',
        label: i.label,
        amount_paisa: i.amountPaisa,
        source: 'MANUAL',
        sort_no: (max?.m ?? -1) + 1,
        created_by: a.userId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await refreshTotals(trx, slipId);
    await writeAudit(trx, {
      ...act(a),
      action: 'PAYROLL_LINE_ADD',
      entity: 'payslip_line',
      entityId: row.id,
      reason: i.label,
      after: { kind: i.kind, amountPaisa: i.amountPaisa, slip: slipId },
    });
    return { id: row.id };
  });
}

export function removeManualLine(ctx: AppContext, a: Actor, lineId: string) {
  return withTx(ctx.db, async (trx) => {
    const line = await trx
      .selectFrom('payslip_lines as l')
      .innerJoin('payslips as s', 's.id', 'l.payslip_id')
      .select([
        'l.id',
        'l.source',
        'l.label',
        'l.kind',
        'l.amount_paisa',
        's.id as slip_id',
        's.run_id',
      ])
      .where('l.id', '=', lineId)
      .where('s.branch_id', '=', a.branchId)
      .executeTakeFirst();
    if (!line) throw new AppError(404, 'NOT_FOUND', 'line not found');
    const run = await lockRun(trx, a.branchId, line.run_id);
    draftOnly(run.status);
    if (line.source !== 'MANUAL')
      throw bad(
        'Only a line you added yourself can be removed. The others are worked out from attendance and pay terms.',
      );
    await trx.deleteFrom('payslip_lines').where('id', '=', lineId).execute();
    await refreshTotals(trx, line.slip_id);
    await writeAudit(trx, {
      ...act(a),
      action: 'PAYROLL_LINE_REMOVE',
      entity: 'payslip_line',
      entityId: lineId,
      before: { label: line.label, kind: line.kind, amountPaisa: line.amount_paisa },
    });
  });
}

// ─────────────────────────────── approval ───────────────────────────────

export function approveRun(ctx: AppContext, a: Actor, id: string) {
  return withTx(ctx.db, async (trx) => {
    const run = await lockRun(trx, a.branchId, id);
    draftOnly(run.status);
    // no recovery may change while this approval reads the balances
    await trx
      .selectFrom('staff_dues')
      .select('id')
      .where('branch_id', '=', a.branchId)
      .forUpdate()
      .execute();
    await recalc(trx, a.branchId, run);
    const slips = await trx
      .selectFrom('payslips as s')
      .innerJoin('employees as e', 'e.id', 's.employee_id')
      .select(['s.id', 's.net_paisa', 's.tally', 's.warnings', 'e.code', 'e.full_name'])
      .where('s.run_id', '=', id)
      .execute();
    const problems: { employee: string; issue: string; days?: number }[] = [];
    if (slips.length === 0) problems.push({ employee: '', issue: 'NO_PAYSLIPS' });
    const tz = (
      await trx
        .selectFrom('branches')
        .select('timezone')
        .where('id', '=', a.branchId)
        .executeTakeFirstOrThrow()
    ).timezone;
    if (localParts(ctx.clock.now(), tz).date < run.period_to)
      problems.push({ employee: '', issue: 'PERIOD_NOT_FINISHED' });
    for (const s of slips) {
      const t = s.tally as unknown as Record<string, number>;
      if ((t.unmarkedHalf ?? 0) > 0)
        problems.push({
          employee: `${s.code} ${s.full_name}`,
          issue: 'UNMARKED_DAYS',
          days: (t.unmarkedHalf ?? 0) / 2,
        });
      if (s.net_paisa < 0)
        problems.push({ employee: `${s.code} ${s.full_name}`, issue: 'NEGATIVE_NET' });
    }
    if (problems.length)
      throw new AppError(
        409,
        'PAYROLL_NOT_READY',
        'This pay run cannot be approved yet: ' +
          problems
            .map((p) =>
              p.issue === 'UNMARKED_DAYS'
                ? `${p.employee} has ${p.days} unmarked working day(s)`
                : p.issue === 'NEGATIVE_NET'
                  ? `${p.employee} would be paid less than nothing`
                  : p.issue === 'PERIOD_NOT_FINISHED'
                    ? 'the period has not ended yet'
                    : 'nobody is in it',
            )
            .join('; ') +
          '.',
        { problems },
      );
    const totals = slips.reduce((n, s) => n + s.net_paisa, 0);
    // the recoveries on these payslips become ledger entries now: once per payslip, never again
    const recoveries = await trx
      .selectFrom('payslip_lines as l')
      .innerJoin('payslips as s', 's.id', 'l.payslip_id')
      .select(['l.due_id', 'l.amount_paisa', 'l.label', 's.id as slip_id'])
      .where('s.run_id', '=', id)
      .where('l.source', '=', 'RECOVERY')
      .execute();
    for (const r of recoveries)
      await trx
        .insertInto('staff_due_entries')
        .values({
          due_id: r.due_id!,
          kind: 'RECOVERY',
          amount_paisa: r.amount_paisa,
          payslip_id: r.slip_id,
          note: r.label,
          created_by: a.userId,
        })
        .execute();
    await trx
      .updateTable('payroll_runs')
      .set({ status: 'APPROVED', approved_by: a.userId, approved_at: ctx.clock.now() })
      .where('id', '=', id)
      .execute();
    await writeAudit(trx, {
      ...act(a),
      action: 'PAYROLL_RUN_APPROVE',
      entity: 'payroll_run',
      entityId: id,
      after: {
        from: run.period_from,
        to: run.period_to,
        people: slips.length,
        netPaisa: totals,
        recoveredPaisa: recoveries.reduce((n, r) => n + r.amount_paisa, 0),
      },
    });
    return { id, people: slips.length, netPaisa: totals };
  });
}

// ─────────────────────────────── reading ───────────────────────────────

export async function listRuns(ctx: AppContext, branchId: string) {
  const runs = await ctx.db
    .selectFrom('payroll_runs')
    .selectAll()
    .where('branch_id', '=', branchId)
    .orderBy('period_from', 'desc')
    .orderBy('run_no', 'desc')
    .limit(200)
    .execute();
  const ids = runs.map((r) => r.id);
  const slips = ids.length
    ? await ctx.db
        .selectFrom('payslips')
        .select(['id', 'run_id', 'net_paisa', 'gross_paisa', 'deductions_paisa'])
        .where('run_id', 'in', ids)
        .execute()
    : [];
  const pays = slips.length
    ? await ctx.db
        .selectFrom('payroll_payments')
        .select(['payslip_id', 'amount_paisa'])
        .where(
          'payslip_id',
          'in',
          slips.map((s) => s.id),
        )
        .execute()
    : [];
  return runs.map((r) => {
    const mine = slips.filter((s) => s.run_id === r.id);
    const mineIds = new Set(mine.map((s) => s.id));
    return {
      id: r.id,
      runNo: r.run_no,
      frequency: r.frequency,
      from: r.period_from,
      to: r.period_to,
      status: r.status,
      people: mine.length,
      grossPaisa: mine.reduce((n, s) => n + s.gross_paisa, 0),
      netPaisa: mine.reduce((n, s) => n + s.net_paisa, 0),
      paidPaisa: pays
        .filter((p) => mineIds.has(p.payslip_id))
        .reduce((n, p) => n + p.amount_paisa, 0),
      approvedAt: r.approved_at,
    };
  });
}

export async function getRun(ctx: AppContext, branchId: string, id: string) {
  const run = await ctx.db
    .selectFrom('payroll_runs')
    .selectAll()
    .where('id', '=', id)
    .where('branch_id', '=', branchId)
    .executeTakeFirst();
  if (!run) throw new AppError(404, 'NOT_FOUND', 'pay run not found');
  const slips = await ctx.db
    .selectFrom('payslips as s')
    .innerJoin('employees as e', 'e.id', 's.employee_id')
    .select([
      's.id',
      's.employee_id',
      's.pay_type',
      's.rate_paisa',
      's.tally',
      's.worked_minutes',
      's.late_count',
      's.late_minutes',
      's.overtime_minutes',
      's.warnings',
      's.gross_paisa',
      's.deductions_paisa',
      's.net_paisa',
      'e.code',
      'e.full_name',
      'e.full_name_ur',
      'e.designation',
      'e.payout_method',
    ])
    .where('s.run_id', '=', id)
    .orderBy('e.code')
    .execute();
  const ids = slips.map((s) => s.id);
  const lines = ids.length
    ? await ctx.db
        .selectFrom('payslip_lines')
        .selectAll()
        .where('payslip_id', 'in', ids)
        .orderBy('sort_no')
        .execute()
    : [];
  const pays = ids.length
    ? await ctx.db
        .selectFrom('payroll_payments')
        .select(['payslip_id', 'amount_paisa'])
        .where('payslip_id', 'in', ids)
        .execute()
    : [];
  return {
    id: run.id,
    runNo: run.run_no,
    frequency: run.frequency,
    from: run.period_from,
    to: run.period_to,
    status: run.status,
    note: run.note,
    approvedAt: run.approved_at,
    cancelReason: run.cancel_reason,
    slips: slips.map((s) => ({
      id: s.id,
      employeeId: s.employee_id,
      code: s.code,
      fullName: s.full_name,
      fullNameUr: s.full_name_ur,
      designation: s.designation,
      payoutMethod: s.payout_method,
      payType: s.pay_type,
      ratePaisa: s.rate_paisa,
      tally: s.tally,
      workedMinutes: s.worked_minutes,
      lateCount: s.late_count,
      lateMinutes: s.late_minutes,
      overtimeMinutes: s.overtime_minutes,
      warnings: s.warnings,
      grossPaisa: s.gross_paisa,
      deductionsPaisa: s.deductions_paisa,
      netPaisa: s.net_paisa,
      paidPaisa: pays.filter((p) => p.payslip_id === s.id).reduce((n, p) => n + p.amount_paisa, 0),
      lines: lines
        .filter((l) => l.payslip_id === s.id)
        .map((l) => ({
          id: l.id,
          kind: l.kind,
          code: l.code,
          label: l.label,
          detail: l.detail,
          amountPaisa: l.amount_paisa,
          source: l.source,
        })),
    })),
  };
}

// ─────────────────────────────── paying ───────────────────────────────

/** Records a salary payment (all or part of the net pay) through the expenses ledger. Idempotent on the key. */
export function paySlip(
  ctx: AppContext,
  a: OrdersActor,
  slipId: string,
  i: {
    amountPaisa?: number | undefined;
    paidFrom: 'DRAWER_CASH' | 'OWNER_CASH' | 'BANK';
    note?: string | undefined;
  },
  key: string,
) {
  return withTx(ctx.db, async (trx) => {
    const dup = await trx
      .selectFrom('payroll_payments')
      .select(['id', 'payslip_id'])
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
    if (dup) {
      if (dup.payslip_id !== slipId)
        throw new AppError(
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'That Idempotency-Key was used for another payment',
        );
      return { id: dup.id, replayed: true as const };
    }
    const slip = await trx
      .selectFrom('payslips as s')
      .innerJoin('employees as e', 'e.id', 's.employee_id')
      .innerJoin('payroll_runs as r', 'r.id', 's.run_id')
      .select([
        's.id',
        's.net_paisa',
        'e.code',
        'e.full_name',
        'r.status',
        'r.period_from',
        'r.period_to',
      ])
      .where('s.id', '=', slipId)
      .where('s.branch_id', '=', a.branchId)
      .forUpdate('s')
      .executeTakeFirst();
    if (!slip) throw new AppError(404, 'NOT_FOUND', 'payslip not found');
    if (slip.status !== 'APPROVED')
      throw new AppError(409, 'PAYROLL_NOT_EDITABLE', 'Approve the pay run before paying');
    const paid = (
      await trx
        .selectFrom('payroll_payments')
        .select('amount_paisa')
        .where('payslip_id', '=', slipId)
        .execute()
    ).reduce((n, p) => n + p.amount_paisa, 0);
    const remaining = slip.net_paisa - paid;
    const amount = i.amountPaisa ?? remaining;
    if (amount <= 0)
      throw new AppError(409, 'PAYROLL_OVERPAYMENT', 'Nothing is left to pay on this payslip');
    if (amount > remaining)
      throw new AppError(
        409,
        'PAYROLL_OVERPAYMENT',
        'That is more than is still owed on this payslip',
        {
          remainingPaisa: remaining,
        },
      );
    const expense = await createExpenseTx(
      trx,
      ctx,
      a,
      {
        category: 'SALARY',
        amountPaisa: amount,
        paidFrom: i.paidFrom,
        note: `Salary ${slip.code} ${slip.full_name} (${slip.period_from} to ${slip.period_to})${i.note ? `: ${i.note}` : ''}`,
      },
      `${key}:expense`,
    );
    const row = await trx
      .insertInto('payroll_payments')
      .values({
        branch_id: a.branchId,
        payslip_id: slipId,
        amount_paisa: amount,
        paid_from: i.paidFrom,
        expense_id: expense.id,
        note: i.note ?? null,
        paid_by: a.userId,
        idempotency_key: key,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await writeAudit(trx, {
      branchId: a.branchId,
      userId: a.userId,
      deviceId: a.deviceId ?? null,
      ip: a.ip ?? null,
      action: 'PAYROLL_PAY',
      entity: 'payroll_payment',
      entityId: row.id,
      after: {
        employee: slip.code,
        amountPaisa: amount,
        paidFrom: i.paidFrom,
        remainingPaisa: remaining - amount,
      },
    });
    return { id: row.id, replayed: false as const, remainingPaisa: remaining - amount };
  });
}

export { PayrollError };
