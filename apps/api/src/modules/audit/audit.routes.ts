import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/async-handler';
import type { AppContext } from '../../http/context';
import { authenticate, requirePermission, resolveBranch } from '../auth/middleware';

const query = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Keyset cursor: return rows with id < before (newest first). */
  before: z.coerce.number().int().positive().optional(),
  entity: z.string().min(1).max(60).optional(),
  entityId: z.string().uuid().optional(),
  action: z.string().min(1).max(60).optional(),
  userId: z.string().uuid().optional(),
});

/** Read-only audit viewer. There is intentionally no write/delete endpoint. */
export function auditRouter(ctx: AppContext): Router {
  const r = Router();
  r.get(
    '/',
    authenticate(ctx),
    resolveBranch(ctx),
    requirePermission(ctx, 'audit.view'),
    asyncHandler(async (req, res) => {
      const q = query.parse(req.query);
      const ownerLevel = req.principal!.userBranchId === null;
      let sel = ctx.db
        .selectFrom('audit_log')
        .selectAll()
        .orderBy('id', 'desc')
        .limit(q.limit + 1);
      // Branch users see their branch only; owner-level users also see global rows (e.g. failed logins).
      sel = ownerLevel
        ? sel.where((eb) =>
            eb.or([eb('branch_id', '=', req.branchId!), eb('branch_id', 'is', null)]),
          )
        : sel.where('branch_id', '=', req.branchId!);
      if (q.before) sel = sel.where('id', '<', q.before);
      if (q.entity) sel = sel.where('entity', '=', q.entity);
      if (q.entityId) sel = sel.where('entity_id', '=', q.entityId);
      if (q.action) sel = sel.where('action', '=', q.action);
      if (q.userId) sel = sel.where('user_id', '=', q.userId);
      const rows = await sel.execute();
      const items = rows.slice(0, q.limit);
      res.json({ items, nextBefore: rows.length > q.limit ? items[items.length - 1]!.id : null });
    }),
  );
  return r;
}
