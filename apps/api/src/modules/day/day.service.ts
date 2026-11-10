import type { AppContext } from '../../http/context';
import { AppError } from '../../http/errors';
import { withTx } from '../../shared/tx';
import { writeAudit } from '../audit/audit.service';
import { currentBusinessDate } from '../menu/menu.repo';
import { openBusinessDay } from '../orders/orders.repo';

export interface Actor {
  branchId: string;
  userId: string;
  deviceId: string | null;
  ip?: string | undefined;
}

const present = (d: {
  id: string;
  business_date: string;
  status: string;
  opened_at: Date;
  opened_by: string | null;
}) => ({
  id: d.id,
  businessDate: d.business_date,
  status: d.status,
  openedAt: d.opened_at,
  openedBy: d.opened_by,
});

export async function getCurrentDay(ctx: AppContext, branchId: string) {
  const day = await openBusinessDay(ctx.db, branchId);
  return day ? present(day) : null;
}

/**
 * Opens a business day (the restaurant's trading day — it can run past midnight). Dates only move
 * forward: a day cannot be opened for a date at or before one that already exists.
 */
export async function openDay(ctx: AppContext, a: Actor, businessDate?: string) {
  try {
    return await withTx(ctx.db, async (trx) => {
      if (await openBusinessDay(trx, a.branchId)) {
        throw new AppError(
          409,
          'DAY_ALREADY_OPEN',
          'A business day is already open; close it first',
        );
      }
      const date = businessDate ?? (await currentBusinessDate(trx, a.branchId, ctx.clock.now()));
      const latest = await trx
        .selectFrom('business_days')
        .select((eb) => eb.fn.max('business_date').as('d'))
        .where('branch_id', '=', a.branchId)
        .executeTakeFirst();
      if (latest?.d && date <= latest.d) {
        throw new AppError(
          400,
          'VALIDATION_FAILED',
          `Business date ${date} must be after the last day on record (${latest.d})`,
        );
      }
      const row = await trx
        .insertInto('business_days')
        .values({ branch_id: a.branchId, business_date: date, opened_by: a.userId })
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(trx, {
        branchId: a.branchId,
        userId: a.userId,
        deviceId: a.deviceId,
        action: 'DAY_OPEN',
        entity: 'business_day',
        entityId: row.id,
        after: { businessDate: date },
        ip: a.ip,
      });
      return present(row);
    });
  } catch (e) {
    if ((e as { constraint?: string }).constraint === 'one_open_day_per_branch') {
      throw new AppError(409, 'DAY_ALREADY_OPEN', 'A business day is already open; close it first');
    }
    throw e;
  }
}

const presentShift = (s: {
  id: string;
  business_day_id: string;
  opened_by: string;
  opened_at: Date;
  opening_float_paisa: number;
  status: string;
  device_id: string | null;
}) => ({
  id: s.id,
  businessDayId: s.business_day_id,
  openedBy: s.opened_by,
  openedAt: s.opened_at,
  openingFloatPaisa: s.opening_float_paisa,
  status: s.status,
  deviceId: s.device_id,
});

export async function getMyShift(ctx: AppContext, userId: string) {
  const s = await ctx.db
    .selectFrom('shifts')
    .selectAll()
    .where('opened_by', '=', userId)
    .where('status', '=', 'OPEN')
    .executeTakeFirst();
  return s ? presentShift(s) : null;
}

/** A cashier opens a shift with a counted float. One open shift per cashier and per till. */
export async function openShift(
  ctx: AppContext,
  a: Actor,
  input: { openingFloatPaisa: number; deviceId?: string | undefined },
) {
  try {
    return await withTx(ctx.db, async (trx) => {
      const day = await openBusinessDay(trx, a.branchId);
      if (!day)
        throw new AppError(409, 'DAY_NOT_OPEN', 'Open the business day before opening a shift');
      const deviceId = input.deviceId ?? a.deviceId;
      if (deviceId) {
        const d = await trx
          .selectFrom('devices')
          .select('id')
          .where('id', '=', deviceId)
          .where('branch_id', '=', a.branchId)
          .where('is_active', '=', true)
          .executeTakeFirst();
        if (!d) throw new AppError(404, 'NOT_FOUND', 'device not found');
      }
      const row = await trx
        .insertInto('shifts')
        .values({
          branch_id: a.branchId,
          business_day_id: day.id,
          device_id: deviceId,
          opened_by: a.userId,
          opening_float_paisa: input.openingFloatPaisa,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(trx, {
        branchId: a.branchId,
        userId: a.userId,
        deviceId: a.deviceId,
        action: 'SHIFT_OPEN',
        entity: 'shift',
        entityId: row.id,
        after: { openingFloatPaisa: input.openingFloatPaisa, deviceId },
        ip: a.ip,
      });
      return presentShift(row);
    });
  } catch (e) {
    const c = (e as { constraint?: string }).constraint;
    if (c === 'one_open_shift_per_user' || c === 'one_open_shift_per_device') {
      throw new AppError(
        409,
        'SHIFT_ALREADY_OPEN',
        c === 'one_open_shift_per_user'
          ? 'You already have an open shift'
          : 'This till already has an open shift',
      );
    }
    throw e;
  }
}
