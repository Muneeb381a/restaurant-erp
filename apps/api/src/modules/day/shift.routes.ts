import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/async-handler';
import type { AppContext } from '../../http/context';
import { AppError } from '../../http/errors';
import { idParam } from '../admin/crud';
import { authenticate, requirePermission, resolveBranch } from '../auth/middleware';
import {
  addCashMovement,
  closeDay,
  closeShift,
  getDayReport,
  getShiftReport,
  listDays,
  noSale,
  reopenShift,
  reprintReport,
  type PrivilegedActor,
} from './shift.service';

const reason = z.string().trim().min(3).max(300);
const money = z.number().int().min(0).max(1_000_000_000_000);

function idempotencyKey(req: Request): string {
  const key = req.header('idempotency-key');
  if (!key || !/^[A-Za-z0-9._:-]{8,80}$/.test(key))
    throw new AppError(
      400,
      'VALIDATION_FAILED',
      'Send an Idempotency-Key header (8–80 characters: letters, digits, . _ : -)',
    );
  return key;
}

export function shiftRouter(ctx: AppContext): Router {
  const r = Router();
  const read = [authenticate(ctx), resolveBranch(ctx)];
  const actor = async (req: Request): Promise<PrivilegedActor> => ({
    branchId: req.branchId!,
    userId: req.principal!.userId,
    deviceId: req.principal!.deviceId,
    ip: req.ip,
    permissions: await ctx.permissions.get(req.principal!.roleId),
  });

  r.get(
    '/shifts/:id/report',
    ...read,
    asyncHandler(async (req, res) => {
      res.json(await getShiftReport(ctx, await actor(req), idParam.parse(req.params).id));
    }),
  );

  r.post(
    '/shifts/:id/close',
    ...read,
    requirePermission(ctx, 'shift.close'),
    asyncHandler(async (req, res) => {
      const body = z
        .object({ countedCashPaisa: money, notes: z.string().trim().max(500).optional() })
        .strict()
        .parse(req.body);
      res.json(await closeShift(ctx, await actor(req), idParam.parse(req.params).id, body));
    }),
  );

  r.post(
    '/shifts/:id/reopen',
    ...read,
    requirePermission(ctx, 'shift.reopen'),
    asyncHandler(async (req, res) => {
      const body = z.object({ reason }).strict().parse(req.body);
      res.json(await reopenShift(ctx, await actor(req), idParam.parse(req.params).id, body.reason));
    }),
  );

  r.post(
    '/cash-movements',
    ...read,
    requirePermission(ctx, 'cash.paid_out'),
    asyncHandler(async (req, res) => {
      const body = z
        .object({ kind: z.enum(['PAID_OUT', 'CASH_IN', 'DROP']), amountPaisa: money, reason })
        .strict()
        .parse(req.body);
      const out = await addCashMovement(ctx, await actor(req), body, idempotencyKey(req));
      res.status(out.replayed ? 200 : 201).json(out);
    }),
  );

  r.post(
    '/drawer/open',
    ...read,
    requirePermission(ctx, 'drawer.open'),
    asyncHandler(async (req, res) => {
      const body = z.object({ reason }).strict().parse(req.body);
      const out = await noSale(ctx, await actor(req), body.reason, idempotencyKey(req));
      res.status(out.replayed ? 200 : 201).json(out);
    }),
  );

  r.post(
    '/business-days/close',
    ...read,
    requirePermission(ctx, 'day.close'),
    asyncHandler(async (req, res) => {
      res.json(await closeDay(ctx, await actor(req)));
    }),
  );
  r.get(
    '/business-days',
    ...read,
    requirePermission(ctx, 'report.financial'),
    asyncHandler(async (req, res) => {
      const limit = z.coerce.number().int().min(1).max(100).default(30).parse(req.query.limit);
      res.json({ items: await listDays(ctx, req.branchId!, limit) });
    }),
  );
  r.get(
    '/business-days/:id/report',
    ...read,
    requirePermission(ctx, 'report.financial'),
    asyncHandler(async (req, res) => {
      res.json(await getDayReport(ctx, await actor(req), idParam.parse(req.params).id));
    }),
  );

  // Reprint a closed shift's slip (shift.close) or a closed day's Z-report (day.close).
  r.post(
    '/reports/reprint',
    ...read,
    asyncHandler(async (req, res) => {
      const body = z
        .object({
          shiftId: z.string().uuid().optional(),
          dayId: z.string().uuid().optional(),
          reason,
        })
        .strict()
        .refine(
          (b) => (b.shiftId === undefined) !== (b.dayId === undefined),
          'Give shiftId or dayId',
        )
        .parse(req.body);
      const a = await actor(req);
      const needed = body.shiftId ? 'shift.close' : 'day.close';
      if (!a.permissions.has(needed))
        throw new AppError(403, 'PERMISSION_DENIED', 'You do not have permission for this action', {
          permission: needed,
        });
      res
        .status(201)
        .json(
          await reprintReport(
            ctx,
            a,
            { shiftId: body.shiftId, dayId: body.dayId } as never,
            body.reason,
          ),
        );
    }),
  );

  return r;
}
