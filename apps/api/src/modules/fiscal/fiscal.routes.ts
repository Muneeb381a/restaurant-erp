import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/async-handler';
import type { AppContext } from '../../http/context';
import { idParam } from '../admin/crud';
import { authenticate, requirePermission, resolveBranch } from '../auth/middleware';
import type { Actor } from '../orders/orders.service';
import {
  fiscalReconciliation,
  fiscalSummary,
  listFiscalJobs,
  retryFiscalJob,
} from './fiscal.service';

/** Fiscal queue status, retries and the day reconciliation. */
export function fiscalRouter(ctx: AppContext): Router {
  const r = Router();
  const read = [authenticate(ctx), resolveBranch(ctx)];
  const actor = async (req: Request): Promise<Actor> => ({
    branchId: req.branchId!,
    userId: req.principal!.userId,
    deviceId: req.principal!.deviceId,
    ip: req.ip,
    permissions: await ctx.permissions.get(req.principal!.roleId),
  });

  r.get(
    '/fiscal/summary',
    ...read,
    requirePermission(ctx, 'report.financial'),
    asyncHandler(async (req, res) => {
      res.json(await fiscalSummary(ctx.db, req.branchId!));
    }),
  );
  r.get(
    '/fiscal/jobs',
    ...read,
    requirePermission(ctx, 'report.financial'),
    asyncHandler(async (req, res) => {
      const q = z
        .object({
          status: z.enum(['open', 'rejected', 'all']).default('open'),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(req.query);
      res.json({ items: await listFiscalJobs(ctx.db, req.branchId!, q.status, q.limit) });
    }),
  );
  r.post(
    '/fiscal/jobs/:id/retry',
    ...read,
    requirePermission(ctx, 'tax.manage'),
    asyncHandler(async (req, res) => {
      res.json(await retryFiscalJob(ctx, await actor(req), idParam.parse(req.params).id));
    }),
  );
  r.get(
    '/fiscal/reconciliation',
    ...read,
    requirePermission(ctx, 'report.financial'),
    asyncHandler(async (req, res) => {
      const q = z
        .object({ businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
        .parse(req.query);
      res.json(await fiscalReconciliation(ctx.db, req.branchId!, q.businessDate));
    }),
  );
  return r;
}
