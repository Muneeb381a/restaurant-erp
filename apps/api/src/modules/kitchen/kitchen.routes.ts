import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/async-handler';
import type { AppContext } from '../../http/context';
import { AppError } from '../../http/errors';
import { writeAudit } from '../audit/audit.service';
import { idParam } from '../admin/crud';
import { authenticate, requirePermission, resolveBranch } from '../auth/middleware';
import type { Actor } from '../orders/orders.service';
import { getPrinterHealth } from '../printing/print.service';
import { getKot, listKots, reprintKot, sendToKitchen } from './kitchen.service';

const uuid = z.string().uuid();

function ifMatch(req: Request): number | undefined {
  const raw = req.header('if-match');
  if (raw === undefined) return undefined;
  const n = Number(raw.replace(/^W\//, '').replace(/"/g, '').trim());
  if (!Number.isInteger(n) || n < 1)
    throw new AppError(400, 'VALIDATION_FAILED', 'If-Match must be the order version number');
  return n;
}

export function kitchenRouter(ctx: AppContext): Router {
  const r = Router();
  const read = [authenticate(ctx), resolveBranch(ctx)];
  const actor = async (req: Request): Promise<Actor> => ({
    branchId: req.branchId!,
    userId: req.principal!.userId,
    deviceId: req.principal!.deviceId,
    ip: req.ip,
    permissions: await ctx.permissions.get(req.principal!.roleId),
  });

  r.post(
    '/orders/:id/send',
    ...read,
    requirePermission(ctx, 'order.create'),
    asyncHandler(async (req, res) => {
      const body = z
        .object({
          rush: z.boolean().optional(),
          course: z.number().int().min(1).max(10).optional(),
        })
        .strict()
        .parse(req.body);
      const out = await sendToKitchen(
        ctx,
        await actor(req),
        idParam.parse(req.params).id,
        body,
        ifMatch(req),
      );
      res.setHeader('ETag', `"${out.order.version}"`);
      res.status(201).json(out);
    }),
  );

  r.get(
    '/kots',
    ...read,
    asyncHandler(async (req, res) => {
      const q = z.object({ orderId: uuid.optional() }).parse(req.query);
      res.json({ items: await listKots(ctx, req.branchId!, q.orderId) });
    }),
  );
  r.get(
    '/kots/:id',
    ...read,
    asyncHandler(async (req, res) => {
      res.json(await getKot(ctx, req.branchId!, idParam.parse(req.params).id));
    }),
  );
  r.post(
    '/kots/:id/reprint',
    ...read,
    requirePermission(ctx, 'kot.reprint'),
    asyncHandler(async (req, res) => {
      const { reason } = z
        .object({ reason: z.string().trim().min(3).max(300) })
        .strict()
        .parse(req.body);
      res
        .status(201)
        .json(await reprintKot(ctx, await actor(req), idParam.parse(req.params).id, reason));
    }),
  );

  // ── printers: health for everyone (the counter must see "kitchen printer offline"), jobs for admins
  r.get(
    '/printers/health',
    ...read,
    asyncHandler(async (req, res) => {
      res.json({ items: await getPrinterHealth(ctx, req.branchId!) });
    }),
  );
  r.get(
    '/print-jobs',
    ...read,
    requirePermission(ctx, 'settings.manage'),
    asyncHandler(async (req, res) => {
      const q = z
        .object({
          status: z.enum(['PENDING', 'IN_FLIGHT', 'DONE', 'FAILED', 'DEAD']).optional(),
          printerId: uuid.optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(req.query);
      let sel = ctx.db
        .selectFrom('print_jobs')
        .select([
          'id',
          'printer_id',
          'kind',
          'title',
          'status',
          'attempts',
          'next_attempt_at',
          'last_error',
          'created_at',
          'printed_at',
        ])
        .where('branch_id', '=', req.branchId!)
        .orderBy('created_at', 'desc')
        .limit(q.limit);
      if (q.status) sel = sel.where('status', '=', q.status);
      if (q.printerId) sel = sel.where('printer_id', '=', q.printerId);
      res.json({ items: await sel.execute() });
    }),
  );
  /** Puts a parked (DEAD) or waiting job back in the queue — e.g. after fixing the printer's address. */
  r.post(
    '/print-jobs/:id/retry',
    ...read,
    requirePermission(ctx, 'settings.manage'),
    asyncHandler(async (req, res) => {
      const id = idParam.parse(req.params).id;
      const a = await actor(req);
      const job = await ctx.db
        .updateTable('print_jobs')
        .set({
          status: 'PENDING',
          attempts: 0,
          next_attempt_at: ctx.clock.now(),
          lease_until: null,
        })
        .where('id', '=', id)
        .where('branch_id', '=', a.branchId)
        .where('status', 'in', ['DEAD', 'FAILED'])
        .returning(['id', 'status', 'title'])
        .executeTakeFirst();
      if (!job) throw new AppError(404, 'NOT_FOUND', 'No failed or dead print job with that id');
      await writeAudit(ctx.db, {
        branchId: a.branchId,
        userId: a.userId,
        deviceId: a.deviceId,
        action: 'PRINT_JOB_RETRY',
        entity: 'print_job',
        entityId: id,
        after: { title: job.title },
        ip: a.ip,
      });
      res.json(job);
    }),
  );

  return r;
}
