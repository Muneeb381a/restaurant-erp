import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/async-handler';
import type { AppContext } from '../../http/context';
import { idParam } from '../admin/crud';
import { authenticate, requirePermission, resolveBranch } from '../auth/middleware';
import type { Actor } from '../orders/orders.service';
import {
  createCategory,
  createRule,
  listCategories,
  listRules,
  taxReadiness,
  updateRule,
} from './tax.service';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const authority = z.enum(['PRA', 'SRB', 'KPRA', 'BRA', 'FBR']);

/** Tax master data and the "can tax be switched on" check. All of it needs `tax.manage`. */
export function taxRouter(ctx: AppContext): Router {
  const r = Router();
  const guard = [authenticate(ctx), resolveBranch(ctx), requirePermission(ctx, 'tax.manage')];
  const actor = async (req: Request): Promise<Actor> => ({
    branchId: req.branchId!,
    userId: req.principal!.userId,
    deviceId: req.principal!.deviceId,
    ip: req.ip,
    permissions: await ctx.permissions.get(req.principal!.roleId),
  });

  r.get(
    '/tax/categories',
    ...guard,
    asyncHandler(async (_req, res) => {
      res.json({ items: await listCategories(ctx.db) });
    }),
  );
  r.post(
    '/tax/categories',
    ...guard,
    asyncHandler(async (req, res) => {
      const body = z
        .object({
          code: z
            .string()
            .trim()
            .regex(/^[A-Z][A-Z0-9_]{1,40}$/, 'UPPER_CASE_CODE'),
          name: z.string().trim().min(1).max(120),
        })
        .strict()
        .parse(req.body);
      res.status(201).json(await createCategory(ctx, await actor(req), body));
    }),
  );

  r.get(
    '/tax/rules',
    ...guard,
    asyncHandler(async (req, res) => {
      const q = z.object({ authority: authority.optional() }).parse(req.query);
      res.json({ items: await listRules(ctx.db, q.authority) });
    }),
  );
  r.post(
    '/tax/rules',
    ...guard,
    asyncHandler(async (req, res) => {
      const body = z
        .object({
          authority,
          categoryId: z.string().uuid(),
          paymentClass: z.enum(['CASH_OTHER', 'DIGITAL', 'ANY']),
          rateBps: z.number().int().min(0).max(10_000),
          effectiveFrom: isoDate,
          effectiveTo: isoDate.nullable().optional(),
          sourceNote: z.string().trim().max(500).optional(),
          verifiedBy: z.string().trim().max(120).optional(),
          inputTaxAdjustable: z.boolean().optional(),
        })
        .strict()
        .refine(
          (b) => !b.effectiveTo || b.effectiveTo >= b.effectiveFrom,
          'effectiveTo is before effectiveFrom',
        )
        .parse(req.body);
      res.status(201).json(await createRule(ctx, await actor(req), body));
    }),
  );
  r.patch(
    '/tax/rules/:id',
    ...guard,
    asyncHandler(async (req, res) => {
      const body = z
        .object({
          effectiveTo: isoDate.nullable().optional(),
          verifiedBy: z.string().trim().max(120).nullable().optional(),
          sourceNote: z.string().trim().max(500).nullable().optional(),
        })
        .strict()
        .refine((b) => Object.keys(b).length > 0, 'Nothing to change')
        .parse(req.body);
      res.json(await updateRule(ctx, await actor(req), idParam.parse(req.params).id, body));
    }),
  );

  r.get(
    '/tax/readiness',
    ...guard,
    asyncHandler(async (req, res) => {
      res.json(await taxReadiness(ctx, req.branchId!));
    }),
  );
  return r;
}
