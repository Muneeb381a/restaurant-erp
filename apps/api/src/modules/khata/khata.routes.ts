import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/async-handler';
import type { AppContext } from '../../http/context';
import { AppError } from '../../http/errors';
import { idParam } from '../admin/crud';
import { authenticate, requirePermission, resolveBranch } from '../auth/middleware';
import type { Actor } from '../orders/orders.service';
import {
  adjustBalance,
  createAccount,
  getAccount,
  receivePayment,
  searchAccounts,
  updateAccount,
} from './khata.service';

const money = z.number().int().min(0).max(1_000_000_000_000);
const text = (max: number) => z.string().trim().min(1).max(max);

export function khataRouter(ctx: AppContext): Router {
  const r = Router();
  const read = [authenticate(ctx), resolveBranch(ctx)];
  const collect = [...read, requirePermission(ctx, 'khata.collect')];
  const manage = [...read, requirePermission(ctx, 'customer.manage')];
  const actor = async (req: Request): Promise<Actor> => ({
    branchId: req.branchId!,
    userId: req.principal!.userId,
    deviceId: req.principal!.deviceId,
    ip: req.ip,
    permissions: await ctx.permissions.get(req.principal!.roleId),
  });

  r.get(
    '/khata/accounts',
    ...collect,
    asyncHandler(async (req, res) => {
      const q = z
        .object({
          search: z.string().trim().max(100).optional(),
          owing: z.enum(['true', 'false']).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(req.query);
      res.json({
        items: await searchAccounts(ctx, req.branchId!, {
          search: q.search,
          onlyOwing: q.owing === 'true',
          limit: q.limit,
        }),
      });
    }),
  );

  r.get(
    '/khata/accounts/:id',
    ...collect,
    asyncHandler(async (req, res) => {
      const limit = z.coerce.number().int().min(1).max(500).default(100).parse(req.query.limit);
      res.json(await getAccount(ctx.db, req.branchId!, idParam.parse(req.params).id, limit));
    }),
  );

  r.post(
    '/khata/accounts',
    ...manage,
    asyncHandler(async (req, res) => {
      const body = z
        .object({
          name: text(120),
          phone: z.string().trim().max(30).optional(),
          notes: z.string().trim().max(500).optional(),
          creditLimitPaisa: money,
        })
        .strict()
        .parse(req.body);
      res.status(201).json(await createAccount(ctx, await actor(req), body));
    }),
  );

  r.patch(
    '/khata/accounts/:id',
    ...manage,
    asyncHandler(async (req, res) => {
      const body = z
        .object({
          name: text(120).optional(),
          phone: z.string().trim().max(30).nullable().optional(),
          notes: z.string().trim().max(500).nullable().optional(),
          creditLimitPaisa: money.optional(),
          isActive: z.boolean().optional(),
        })
        .strict()
        .refine((b) => Object.keys(b).length > 0, 'Nothing to change')
        .parse(req.body);
      res.json(await updateAccount(ctx, await actor(req), idParam.parse(req.params).id, body));
    }),
  );

  r.post(
    '/khata/accounts/:id/payments',
    ...collect,
    asyncHandler(async (req, res) => {
      const key = req.header('idempotency-key');
      if (!key || !/^[A-Za-z0-9._:-]{8,80}$/.test(key))
        throw new AppError(
          400,
          'VALIDATION_FAILED',
          'Send an Idempotency-Key header (8–80 characters: letters, digits, . _ : -)',
        );
      const body = z
        .object({
          methodId: z.string().uuid(),
          amountPaisa: money.refine((n) => n > 0, 'must be positive'),
          reference: z.string().trim().max(100).optional(),
        })
        .strict()
        .parse(req.body);
      const out = await receivePayment(
        ctx,
        await actor(req),
        idParam.parse(req.params).id,
        body,
        key,
      );
      res.status(out.replayed ? 200 : 201).json(out);
    }),
  );

  r.post(
    '/khata/accounts/:id/adjustments',
    ...manage,
    asyncHandler(async (req, res) => {
      const body = z
        .object({
          direction: z.enum(['UP', 'DOWN']),
          amountPaisa: money.refine((n) => n > 0, 'must be positive'),
          reason: z.string().trim().min(3).max(300),
        })
        .strict()
        .parse(req.body);
      res
        .status(201)
        .json(await adjustBalance(ctx, await actor(req), idParam.parse(req.params).id, body));
    }),
  );

  return r;
}
