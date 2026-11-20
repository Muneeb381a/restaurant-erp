import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/async-handler';
import type { AppContext } from '../../http/context';
import { AppError } from '../../http/errors';
import { idParam } from '../admin/crud';
import { authenticate, requirePermission, resolveBranch } from '../auth/middleware';
import type { Actor } from '../orders/orders.service';
import { createCreditNote, refundableView } from './credit.service';
import {
  applyDiscount,
  createBill,
  getBillForOrder,
  getBillView,
  listBills,
  quoteBill,
  browserReceipt,
  printBillForOrder,
  printPreBill,
  printTokenSlip,
  reprintBill,
  settleBill,
  voidBill,
} from './billing.service';

const uuid = z.string().uuid();
const reason = z.string().trim().min(3).max(300);
const money = z.number().int().min(0).max(1_000_000_000_000);

const tenderSchema = z
  .object({
    methodId: uuid,
    amountPaisa: money.refine((n) => n > 0, 'must be positive'),
    tenderedPaisa: money.optional(),
    tipPaisa: money.optional(),
    reference: z.string().trim().max(100).optional(),
    khataAccountId: uuid.optional(),
  })
  .strict();

function ifMatch(req: Request): number | undefined {
  const raw = req.header('if-match');
  if (raw === undefined) return undefined;
  const n = Number(raw.replace(/^W\//, '').replace(/"/g, '').trim());
  if (!Number.isInteger(n) || n < 1)
    throw new AppError(400, 'VALIDATION_FAILED', 'If-Match must be the order version number');
  return n;
}

export function billingRouter(ctx: AppContext): Router {
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
    '/orders/:id/bill',
    ...read,
    requirePermission(ctx, 'bill.create'),
    asyncHandler(async (req, res) => {
      res
        .status(201)
        .json(await createBill(ctx, await actor(req), idParam.parse(req.params).id, ifMatch(req)));
    }),
  );
  r.get(
    '/bills',
    ...read,
    requirePermission(ctx, 'report.view'),
    asyncHandler(async (req, res) => {
      const q = z
        .object({
          businessDate: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
          billNo: z.coerce.number().int().positive().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(req.query);
      res.json({ items: await listBills(ctx.db, req.branchId!, q) });
    }),
  );
  r.get(
    '/bills/:id/quotes',
    ...read,
    asyncHandler(async (req, res) => {
      res.json(await quoteBill(ctx, req.branchId!, idParam.parse(req.params).id));
    }),
  );
  r.get(
    '/bills/:id/refundable',
    ...read,
    requirePermission(ctx, 'bill.refund'),
    asyncHandler(async (req, res) => {
      res.json(await refundableView(ctx, req.branchId!, idParam.parse(req.params).id));
    }),
  );
  r.post(
    '/bills/:id/credit-notes',
    ...read,
    requirePermission(ctx, 'bill.refund'),
    asyncHandler(async (req, res) => {
      const body = z
        .object({
          all: z.boolean().optional(),
          lines: z
            .array(z.object({ billLineId: uuid, qty: z.number().positive().max(100000) }).strict())
            .max(100)
            .optional(),
          reason,
          methodId: uuid,
          reference: z.string().trim().max(100).optional(),
        })
        .strict()
        .refine(
          (b) => (b.all === true) !== (b.lines !== undefined),
          'Give either all: true or lines',
        )
        .parse(req.body);
      const dryRun = req.query.dryRun === 'true';
      const key = req.header('idempotency-key');
      if (!dryRun && (!key || !/^[A-Za-z0-9._:-]{8,80}$/.test(key)))
        throw new AppError(
          400,
          'VALIDATION_FAILED',
          'Send an Idempotency-Key header (8–80 characters: letters, digits, . _ : -)',
        );
      const out = await createCreditNote(
        ctx,
        await actor(req),
        idParam.parse(req.params).id,
        body,
        dryRun ? null : key!,
      );
      res.status(dryRun || out.replayed ? 200 : 201).json(out);
    }),
  );
  r.post(
    '/orders/:id/print-token',
    ...read,
    requirePermission(ctx, 'order.create'),
    asyncHandler(async (req, res) => {
      const k = req.header('idempotency-key');
      if (!k || !/^[A-Za-z0-9._:-]{8,80}$/.test(k))
        throw new AppError(
          400,
          'VALIDATION_FAILED',
          'Send an Idempotency-Key header (8–80 characters: letters, digits, . _ : -)',
        );
      res
        .status(201)
        .json(await printTokenSlip(ctx, await actor(req), idParam.parse(req.params).id, k));
    }),
  );
  r.post(
    '/orders/:id/print-bill',
    ...read,
    requirePermission(ctx, 'bill.create'),
    asyncHandler(async (req, res) => {
      const k = req.header('idempotency-key');
      if (!k || !/^[A-Za-z0-9._:-]{8,80}$/.test(k))
        throw new AppError(
          400,
          'VALIDATION_FAILED',
          'Send an Idempotency-Key header (8–80 characters: letters, digits, . _ : -)',
        );
      res
        .status(201)
        .json(
          await printBillForOrder(
            ctx,
            await actor(req),
            idParam.parse(req.params).id,
            k,
            ifMatch(req),
          ),
        );
    }),
  );
  r.get(
    '/orders/:id/bill',
    ...read,
    asyncHandler(async (req, res) => {
      const bill = await getBillForOrder(ctx.db, req.branchId!, idParam.parse(req.params).id);
      if (!bill) throw new AppError(404, 'NOT_FOUND', 'This order has no bill');
      res.json(bill);
    }),
  );
  r.get(
    '/bills/:id',
    ...read,
    asyncHandler(async (req, res) => {
      res.json(await getBillView(ctx.db, req.branchId!, idParam.parse(req.params).id));
    }),
  );

  r.post(
    '/bills/:id/discount',
    ...read,
    requirePermission(ctx, 'bill.discount'),
    asyncHandler(async (req, res) => {
      const body = z
        .object({
          percentBps: z.number().int().min(0).max(10_000).optional(),
          amountPaisa: money.optional(),
          reason: reason.optional(),
          approver: z
            .object({
              username: z.string().trim().min(1).max(100),
              pin: z.string().regex(/^\d{4,8}$/),
            })
            .strict()
            .optional(),
        })
        .strict()
        .parse(req.body);
      res.json(await applyDiscount(ctx, await actor(req), idParam.parse(req.params).id, body));
    }),
  );

  r.post(
    '/bills/:id/settle',
    ...read,
    requirePermission(ctx, 'bill.settle'),
    asyncHandler(async (req, res) => {
      const key = req.header('idempotency-key');
      if (!key || !/^[A-Za-z0-9._:-]{8,80}$/.test(key)) {
        throw new AppError(
          400,
          'VALIDATION_FAILED',
          'Send an Idempotency-Key header (8–80 characters: letters, digits, . _ : -)',
        );
      }
      const body = z
        .object({ tenders: z.array(tenderSchema).min(1).max(10) })
        .strict()
        .parse(req.body);
      const result = await settleBill(
        ctx,
        await actor(req),
        idParam.parse(req.params).id,
        body.tenders,
        key,
      );
      res.status(result.replayed ? 200 : 201).json(result);
    }),
  );

  r.post(
    '/bills/:id/void',
    ...read,
    requirePermission(ctx, 'bill.void'),
    asyncHandler(async (req, res) => {
      const body = z.object({ reason }).strict().parse(req.body);
      res.json(await voidBill(ctx, await actor(req), idParam.parse(req.params).id, body.reason));
    }),
  );

  r.post(
    '/bills/:id/reprint',
    ...read,
    requirePermission(ctx, 'bill.reprint'),
    asyncHandler(async (req, res) => {
      const body = z.object({ reason }).strict().parse(req.body);
      res
        .status(201)
        .json(await reprintBill(ctx, await actor(req), idParam.parse(req.params).id, body.reason));
    }),
  );

  r.post(
    '/bills/:id/print-bill',
    ...read,
    requirePermission(ctx, 'bill.create'),
    asyncHandler(async (req, res) => {
      const k = req.header('idempotency-key');
      if (!k || !/^[A-Za-z0-9._:-]{8,80}$/.test(k))
        throw new AppError(
          400,
          'VALIDATION_FAILED',
          'Send an Idempotency-Key header (8–80 characters: letters, digits, . _ : -)',
        );
      res
        .status(201)
        .json(await printPreBill(ctx, await actor(req), idParam.parse(req.params).id, k));
    }),
  );

  r.post(
    '/bills/:id/browser-print',
    ...read,
    asyncHandler(async (req, res) => {
      const body = z
        .object({ reason: z.string().trim().max(300).optional() })
        .strict()
        .parse(req.body ?? {});
      res
        .status(201)
        .json(
          await browserReceipt(ctx, await actor(req), idParam.parse(req.params).id, body.reason),
        );
    }),
  );

  return r;
}
