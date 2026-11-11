import { assertCanTakeOut, asPaisa, cashVariance } from '@erp/domain';
import { renderDrawerKick, renderReport, type PaperMm } from '@erp/printing';
import type { AppContext } from '../../http/context';
import { AppError } from '../../http/errors';
import { withTx, type Queryable } from '../../shared/tx';
import { writeAudit } from '../audit/audit.service';
import { openBusinessDay } from '../orders/orders.repo';
import { enqueuePrintJob } from '../printing/print.service';
import { dayReport, dayReportDoc, shiftReport, shiftReportDoc } from '../reports/cash-report';
import type { Actor } from './day.service';

const bad = (message: string): AppError => new AppError(400, 'VALIDATION_FAILED', message);

type Perms = { has(p: string): boolean };
export interface PrivilegedActor extends Actor {
  permissions: Perms;
}

const audit = (
  q: Queryable,
  a: Actor,
  action: string,
  entity: string,
  id: string,
  before: unknown,
  after: unknown,
  reason?: string,
) =>
  writeAudit(q, {
    branchId: a.branchId,
    userId: a.userId,
    deviceId: a.deviceId,
    action,
    entity,
    entityId: id,
    before,
    after,
    reason,
    ip: a.ip,
  });

async function printOnReceiptPrinters(
  q: Queryable,
  a: Actor,
  job: { kind: 'REPORT' | 'DRAWER'; refType: string; refId: string; title: string; key: string },
  render: (paper: PaperMm) => Uint8Array,
  at: Date,
): Promise<number> {
  const printers = await q
    .selectFrom('printers')
    .select(['id', 'paper_mm'])
    .where('branch_id', '=', a.branchId)
    .where('kind', '=', 'RECEIPT')
    .where('is_active', '=', true)
    .orderBy('name')
    .execute();
  let n = 0;
  for (const p of printers) {
    const ok = await enqueuePrintJob(q, {
      branchId: a.branchId,
      printerId: p.id,
      kind: job.kind,
      refType: job.refType,
      refId: job.refId,
      title: job.title,
      payload: render(p.paper_mm as PaperMm),
      idempotencyKey: `${job.key}:${p.id}`,
      createdBy: a.userId,
      at,
    });
    if (ok) n++;
  }
  return n;
}

async function branchInfo(q: Queryable, branchId: string) {
  return q
    .selectFrom('branches')
    .select(['name', 'timezone'])
    .where('id', '=', branchId)
    .executeTakeFirstOrThrow();
}

async function lockShift(q: Queryable, branchId: string, shiftId: string) {
  const s = await q
    .selectFrom('shifts')
    .selectAll()
    .where('id', '=', shiftId)
    .where('branch_id', '=', branchId)
    .forUpdate()
    .executeTakeFirst();
  if (!s) throw new AppError(404, 'NOT_FOUND', 'shift not found');
  return s;
}

// ───────────────────────────────── reads ─────────────────────────────────

/**
 * A shift's report. While the shift is open, the expected cash and variance are hidden from users
 * who may not close other people's shifts: a cashier counts the drawer blind, so the count cannot be
 * bent to match the system.
 */
export async function getShiftReport(ctx: AppContext, a: PrivilegedActor, shiftId: string) {
  const r = await shiftReport(ctx.db, a.branchId, shiftId);
  const own =
    (
      await ctx.db
        .selectFrom('shifts')
        .select('opened_by')
        .where('id', '=', shiftId)
        .executeTakeFirstOrThrow()
    ).opened_by === a.userId;
  if (!own && !a.permissions.has('report.view') && !a.permissions.has('day.close'))
    throw new AppError(403, 'PERMISSION_DENIED', 'You can only see your own shift', {
      permission: 'report.view',
    });
  if (
    r.shift.status === 'OPEN' &&
    !a.permissions.has('day.close') &&
    !a.permissions.has('report.financial')
  ) {
    return { ...r, expectedCashPaisa: null, variancePaisa: null };
  }
  return r;
}

export async function getDayReport(ctx: AppContext, a: Actor, dayId: string) {
  return dayReport(ctx.db, a.branchId, dayId);
}

export async function listDays(ctx: AppContext, branchId: string, limit: number) {
  const rows = await ctx.db
    .selectFrom('business_days')
    .select(['id', 'business_date', 'status', 'opened_at', 'closed_at'])
    .where('branch_id', '=', branchId)
    .orderBy('business_date', 'desc')
    .limit(limit)
    .execute();
  return rows.map((d) => ({
    id: d.id,
    businessDate: d.business_date,
    status: d.status,
    openedAt: d.opened_at,
    closedAt: d.closed_at,
  }));
}

// ───────────────────────────── cash movements ─────────────────────────────

export type MovementKind = 'PAID_OUT' | 'CASH_IN' | 'DROP';

/** Paid-out, cash-in or a drop to the safe in the cashier's own open shift (needs cash.paid_out + reason). */
export function addCashMovement(
  ctx: AppContext,
  a: Actor,
  input: { kind: MovementKind; amountPaisa: number; reason: string },
  idempotencyKey: string,
) {
  return withTx(ctx.db, async (trx) => {
    const mine = await trx
      .selectFrom('shifts')
      .select('id')
      .where('opened_by', '=', a.userId)
      .where('status', '=', 'OPEN')
      .executeTakeFirst();
    if (!mine) throw new AppError(409, 'SHIFT_NOT_OPEN', 'Open your shift first');
    const shift = await lockShift(trx, a.branchId, mine.id); // serialises with payments and other movements

    const existing = await trx
      .selectFrom('cash_movements')
      .selectAll()
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
    if (existing) {
      if (existing.shift_id !== shift.id)
        throw new AppError(409, 'CONFLICT', 'That Idempotency-Key was used for another shift');
      return {
        id: existing.id,
        kind: existing.kind,
        amountPaisa: existing.amount_paisa,
        reason: existing.reason,
        replayed: true,
      };
    }

    const report = await shiftReport(trx, a.branchId, shift.id);
    if (input.kind !== 'CASH_IN') assertCanTakeOut(input.amountPaisa, report.expectedCashPaisa);
    else if (!Number.isSafeInteger(input.amountPaisa) || input.amountPaisa <= 0)
      throw bad('The amount must be greater than zero');

    const row = await trx
      .insertInto('cash_movements')
      .values({
        shift_id: shift.id,
        kind: input.kind,
        amount_paisa: input.amountPaisa,
        reason: input.reason,
        created_by: a.userId,
        created_at: ctx.clock.now(),
        idempotency_key: idempotencyKey,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();
    await audit(
      trx,
      a,
      `CASH_${input.kind}`,
      'shift',
      shift.id,
      { expectedCashPaisa: report.expectedCashPaisa },
      { amountPaisa: input.amountPaisa },
      input.reason,
    );
    return {
      id: row.id,
      kind: input.kind,
      amountPaisa: input.amountPaisa,
      reason: input.reason,
      replayed: false,
    };
  });
}

/** "No sale": opens the drawer without a bill. Recorded, audited, needs drawer.open + reason. */
export function noSale(ctx: AppContext, a: Actor, reason: string, idempotencyKey: string) {
  return withTx(ctx.db, async (trx) => {
    const mine = await trx
      .selectFrom('shifts')
      .select('id')
      .where('opened_by', '=', a.userId)
      .where('status', '=', 'OPEN')
      .executeTakeFirst();
    if (!mine) throw new AppError(409, 'SHIFT_NOT_OPEN', 'Open your shift first');
    const shift = await lockShift(trx, a.branchId, mine.id);
    const existing = await trx
      .selectFrom('cash_movements')
      .select('id')
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
    if (existing) return { id: existing.id, printers: 0, replayed: true };

    const now = ctx.clock.now();
    const row = await trx
      .insertInto('cash_movements')
      .values({
        shift_id: shift.id,
        kind: 'NO_SALE_OPEN',
        amount_paisa: 0,
        reason,
        created_by: a.userId,
        created_at: now,
        idempotency_key: idempotencyKey,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const printers = await printOnReceiptPrinters(
      trx,
      a,
      {
        kind: 'DRAWER',
        refType: 'cash_movement',
        refId: row.id,
        title: 'No sale',
        key: `drawer:${row.id}`,
      },
      () => renderDrawerKick(),
      now,
    );
    await audit(trx, a, 'DRAWER_NO_SALE', 'shift', shift.id, null, { movementId: row.id }, reason);
    return { id: row.id, printers, replayed: false };
  });
}

// ──────────────────────────── close / reopen a shift ────────────────────────────

/**
 * Closes a shift: counted cash vs the system's expected cash. Any variance needs a note. Own shift,
 * or any shift for a user with day.close. The slip is queued on the receipt printers.
 */
export function closeShift(
  ctx: AppContext,
  a: PrivilegedActor,
  shiftId: string,
  input: { countedCashPaisa: number; notes?: string | undefined },
) {
  return withTx(ctx.db, async (trx) => {
    const shift = await lockShift(trx, a.branchId, shiftId);
    if (shift.status !== 'OPEN')
      throw new AppError(409, 'SHIFT_NOT_OPEN', 'This shift is already closed');
    if (shift.opened_by !== a.userId && !a.permissions.has('day.close'))
      throw new AppError(
        403,
        'PERMISSION_DENIED',
        'Only the cashier or a manager can close this shift',
        { permission: 'day.close' },
      );

    const before = await shiftReport(trx, a.branchId, shiftId);
    const variance = cashVariance(input.countedCashPaisa, before.expectedCashPaisa);
    const notes = input.notes?.trim();
    if (variance !== 0 && (!notes || notes.length < 3))
      throw new AppError(
        400,
        'VARIANCE_NOTE_REQUIRED',
        'The drawer does not match: write a note explaining the difference',
        { variancePaisa: variance },
      );

    const now = ctx.clock.now();
    await trx
      .updateTable('shifts')
      .set({
        status: 'CLOSED',
        closed_by: a.userId,
        closed_at: now,
        expected_cash_paisa: before.expectedCashPaisa,
        counted_cash_paisa: asPaisa(input.countedCashPaisa),
        notes: notes ?? null,
      })
      .where('id', '=', shiftId)
      .execute();
    const report = await shiftReport(trx, a.branchId, shiftId);
    const branch = await branchInfo(trx, a.branchId);
    const printers = await printOnReceiptPrinters(
      trx,
      a,
      {
        kind: 'REPORT',
        refType: 'shift',
        refId: shiftId,
        title: 'Shift close',
        key: `shift-close:${shiftId}:0`,
      },
      (paper) => renderReport(shiftReportDoc(report, branch.name, branch.timezone), paper),
      now,
    );
    await audit(
      trx,
      a,
      'SHIFT_CLOSE',
      'shift',
      shiftId,
      { status: 'OPEN' },
      {
        expectedCashPaisa: report.expectedCashPaisa,
        countedCashPaisa: input.countedCashPaisa,
        variancePaisa: variance,
      },
      notes,
    );
    return { report, printers };
  });
}

/** Reopens a closed shift of the still-open business day (needs shift.reopen + reason; audited). */
export async function reopenShift(ctx: AppContext, a: Actor, shiftId: string, reason: string) {
  try {
    return await withTx(ctx.db, async (trx) => {
      const shift = await lockShift(trx, a.branchId, shiftId);
      if (shift.status !== 'CLOSED') throw new AppError(409, 'CONFLICT', 'The shift is not closed');
      const day = await openBusinessDay(trx, a.branchId);
      if (!day || day.id !== shift.business_day_id)
        throw new AppError(
          409,
          'DAY_NOT_OPEN',
          'Only a shift of the open business day can be reopened',
        );
      await trx
        .updateTable('shifts')
        .set({
          status: 'OPEN',
          closed_by: null,
          closed_at: null,
          expected_cash_paisa: null,
          counted_cash_paisa: null,
        })
        .where('id', '=', shiftId)
        .execute();
      await audit(
        trx,
        a,
        'SHIFT_REOPEN',
        'shift',
        shiftId,
        {
          status: 'CLOSED',
          expectedCashPaisa: shift.expected_cash_paisa,
          countedCashPaisa: shift.counted_cash_paisa,
          closedBy: shift.closed_by,
        },
        { status: 'OPEN' },
        reason,
      );
      return shiftReport(trx, a.branchId, shiftId);
    });
  } catch (e) {
    const c = (e as { constraint?: string }).constraint;
    if (c === 'one_open_shift_per_user' || c === 'one_open_shift_per_device')
      throw new AppError(
        409,
        'SHIFT_ALREADY_OPEN',
        'That cashier (or till) already has another open shift',
      );
    throw e;
  }
}

// ───────────────────────────────── day close ─────────────────────────────────

/**
 * Closes the business day. Refused while any shift is open or any order is still OPEN/BILLED
 * (nothing is silently abandoned). Prints the Z-report. A closed day can never be reopened.
 */
export function closeDay(ctx: AppContext, a: Actor) {
  return withTx(ctx.db, async (trx) => {
    // Lock the day first: in-flight order/shift inserts hold FOR SHARE and finish before we count.
    const open = await openBusinessDay(trx, a.branchId);
    if (!open) throw new AppError(409, 'DAY_NOT_OPEN', 'There is no open business day');
    const day = await trx
      .selectFrom('business_days')
      .selectAll()
      .where('id', '=', open.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (day.status !== 'OPEN')
      throw new AppError(409, 'DAY_NOT_OPEN', 'There is no open business day');

    const shifts = await trx
      .selectFrom('shifts')
      .innerJoin('users', 'users.id', 'shifts.opened_by')
      .select(['users.full_name as cashier'])
      .where('shifts.business_day_id', '=', day.id)
      .where('shifts.status', '=', 'OPEN')
      .execute();
    if (shifts.length)
      throw new AppError(409, 'SHIFTS_STILL_OPEN', 'Close every shift before closing the day', {
        cashiers: shifts.map((s) => s.cashier),
      });
    const orders = await trx
      .selectFrom('orders')
      .select(['order_no', 'status'])
      .where('business_day_id', '=', day.id)
      .where('status', 'in', ['OPEN', 'BILLED'])
      .orderBy('order_no')
      .execute();
    if (orders.length)
      throw new AppError(
        409,
        'ORDERS_STILL_OPEN',
        'Settle or cancel every open order before closing the day',
        { orders: orders.map((o) => ({ orderNo: o.order_no, status: o.status })) },
      );

    const now = ctx.clock.now();
    await trx
      .updateTable('business_days')
      .set({ status: 'CLOSED', closed_at: now, closed_by: a.userId })
      .where('id', '=', day.id)
      .execute();
    const report = await dayReport(trx, a.branchId, day.id);
    const branch = await branchInfo(trx, a.branchId);
    const printers = await printOnReceiptPrinters(
      trx,
      a,
      {
        kind: 'REPORT',
        refType: 'business_day',
        refId: day.id,
        title: 'Z-report',
        key: `z-report:${day.id}:0`,
      },
      (paper) => renderReport(dayReportDoc(report, branch.name, branch.timezone), paper),
      now,
    );
    await audit(
      trx,
      a,
      'DAY_CLOSE',
      'business_day',
      day.id,
      { status: 'OPEN' },
      {
        businessDate: day.business_date,
        totalPaisa: report.sales.totalPaisa,
        varianceTotalPaisa: report.varianceTotalPaisa,
      },
    );
    return { report, printers };
  });
}

/** Reprints the Z-report or a shift slip, marked REPRINT #n (needs bill.reprint-level trust: report.view + reason, audited). */
export function reprintReport(
  ctx: AppContext,
  a: Actor,
  target: { shiftId?: string; dayId?: string },
  reason: string,
) {
  return withTx(ctx.db, async (trx) => {
    const branch = await branchInfo(trx, a.branchId);
    const now = ctx.clock.now();
    const prior = await trx
      .selectFrom('audit_log')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('action', '=', 'REPORT_REPRINT')
      .where('entity_id', '=', (target.shiftId ?? target.dayId)!)
      .executeTakeFirstOrThrow();
    const copy = Number(prior.n) + 1; // the original print is #0, each audited reprint is #n
    let printers: number;
    if (target.shiftId) {
      const r = await shiftReport(trx, a.branchId, target.shiftId);
      if (r.shift.status !== 'CLOSED')
        throw new AppError(409, 'CONFLICT', 'Only a closed shift has a slip to reprint');
      printers = await printOnReceiptPrinters(
        trx,
        a,
        {
          kind: 'REPORT',
          refType: 'shift',
          refId: target.shiftId,
          title: `Shift close (reprint #${copy})`,
          key: `shift-close:${target.shiftId}:${copy}`,
        },
        (p) => renderReport(shiftReportDoc(r, branch.name, branch.timezone, copy), p),
        now,
      );
    } else {
      const r = await dayReport(trx, a.branchId, target.dayId!);
      if (r.day.status !== 'CLOSED')
        throw new AppError(409, 'CONFLICT', 'Only a closed day has a Z-report to reprint');
      printers = await printOnReceiptPrinters(
        trx,
        a,
        {
          kind: 'REPORT',
          refType: 'business_day',
          refId: target.dayId!,
          title: `Z-report (reprint #${copy})`,
          key: `z-report:${target.dayId}:${copy}`,
        },
        (p) => renderReport(dayReportDoc(r, branch.name, branch.timezone, copy), p),
        now,
      );
    }
    if (printers === 0) throw new AppError(409, 'NO_PRINTER', 'No receipt printer is configured');
    await audit(
      trx,
      a,
      'REPORT_REPRINT',
      target.shiftId ? 'shift' : 'business_day',
      (target.shiftId ?? target.dayId)!,
      null,
      { copy },
      reason,
    );
    return { copy, printers };
  });
}

/**
 * Takes cash out of the caller's own open drawer inside an existing transaction (a paid-out), for
 * purchases, supplier payments and expenses. Locks the shift, refuses more than the drawer holds,
 * and is idempotent per `key`. Returns the shift so the caller can record where the money came from.
 */
export async function drawerPayout(
  trx: Queryable,
  a: Actor,
  input: { amountPaisa: number; reason: string; key: string },
): Promise<{ shiftId: string }> {
  const mine = await trx
    .selectFrom('shifts')
    .select('id')
    .where('opened_by', '=', a.userId)
    .where('status', '=', 'OPEN')
    .executeTakeFirst();
  if (!mine) throw new AppError(409, 'SHIFT_NOT_OPEN', 'Open your shift to pay from the drawer');
  const shift = await lockShift(trx, a.branchId, mine.id);
  const existing = await trx
    .selectFrom('cash_movements')
    .select('id')
    .where('idempotency_key', '=', input.key)
    .executeTakeFirst();
  if (existing) return { shiftId: shift.id };
  const report = await shiftReport(trx, a.branchId, shift.id);
  assertCanTakeOut(input.amountPaisa, report.expectedCashPaisa);
  await trx
    .insertInto('cash_movements')
    .values({
      shift_id: shift.id,
      kind: 'PAID_OUT',
      amount_paisa: input.amountPaisa,
      reason: input.reason,
      created_by: a.userId,
      idempotency_key: input.key,
    })
    .execute();
  await audit(
    trx,
    a,
    'CASH_PAID_OUT',
    'shift',
    shift.id,
    { expectedCashPaisa: report.expectedCashPaisa },
    { amountPaisa: input.amountPaisa },
    input.reason,
  );
  return { shiftId: shift.id };
}
