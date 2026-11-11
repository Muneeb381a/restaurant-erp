import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/async-handler';
import type { AppContext } from '../../http/context';
import { authenticate, requirePermission, resolveBranch } from '../auth/middleware';
import { dashboard } from './dashboard.service';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export function reportsRouter(ctx: AppContext): Router {
  const r = Router();
  const money = [authenticate(ctx), resolveBranch(ctx), requirePermission(ctx, 'report.financial')];

  /** Owner dashboard: sales, payments, costs, profit, trends and controls for a range of business dates. */
  r.get(
    '/reports/dashboard',
    ...money,
    asyncHandler(async (req, res) => {
      const q = z.object({ from: isoDate, to: isoDate }).parse(req.query);
      res.json(await dashboard(ctx, req.branchId!, q.from, q.to));
    }),
  );
  return r;
}
