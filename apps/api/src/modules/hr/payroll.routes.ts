import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/async-handler';
import type { AppContext } from '../../http/context';
import { AppError } from '../../http/errors';
import { idParam } from '../admin/crud';
import { authenticate, requirePermission, resolveBranch } from '../auth/middleware';
import type { Actor as OrdersActor } from '../orders/orders.service';
import type { Actor } from './hr.service';
import { createDue, listDues, setDuePaused, writeOffDue } from './dues.service';
import { hrOverview } from './overview.service';
import {
  addManualLine,
  addPayItem,
  approveRun,
  cancelRun,
  createRun,
  getRun,
  listPayItems,
  listRuns,
  paySlip,
  recalculateRun,
  removeManualLine,
  updatePayItem,
} from './payroll.service';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const paisa = z.number().int().min(1).max(1_000_000_000_000);

export function payrollRouter(ctx: AppContext): Router {
  const r = Router();
  const read = [authenticate(ctx), resolveBranch(ctx)];
  const view = [...read, requirePermission(ctx, 'payroll.view')];
  const manage = [...read, requirePermission(ctx, 'payroll.manage')];
  const approve = [...read, requirePermission(ctx, 'payroll.approve')];
  const pay = [...read, requirePermission(ctx, 'payroll.pay')];
  const items = [...read, requirePermission(ctx, 'employee.manage')];
  const actor = (req: Request): Actor => ({
    branchId: req.branchId!,
    userId: req.principal!.userId,
    deviceId: req.principal!.deviceId,
    ip: req.ip,
  });
  const key = (req: Request): string => {
    const k = req.header('idempotency-key');
    if (!k || !/^[A-Za-z0-9._:-]{8,80}$/.test(k))
      throw new AppError(
        400,
        'VALIDATION_FAILED',
        'Send an Idempotency-Key header (8–80 characters: letters, digits, . _ : -)',
      );
    return k;
  };

  // ── recurring allowances and deductions of one person
  r.get(
    '/employees/:id/pay-items',
    ...view,
    asyncHandler(async (req, res) => {
      res.json({ items: await listPayItems(ctx, req.branchId!, idParam.parse(req.params).id) });
    }),
  );
  r.post(
    '/employees/:id/pay-items',
    ...items,
    asyncHandler(async (req, res) => {
      const b = z
        .object({
          kind: z.enum(['ALLOWANCE', 'DEDUCTION']),
          name: z.string().trim().min(1).max(60),
          amountPaisa: paisa,
        })
        .strict()
        .parse(req.body);
      res.status(201).json(await addPayItem(ctx, actor(req), idParam.parse(req.params).id, b));
    }),
  );
  r.patch(
    '/pay-items/:id',
    ...items,
    asyncHandler(async (req, res) => {
      const b = z
        .object({
          name: z.string().trim().min(1).max(60),
          amountPaisa: paisa,
          isActive: z.boolean(),
        })
        .partial()
        .strict()
        .parse(req.body);
      await updatePayItem(ctx, actor(req), idParam.parse(req.params).id, b);
      res.status(204).end();
    }),
  );

  // ── pay runs
  r.get(
    '/payroll-runs',
    ...view,
    asyncHandler(async (req, res) => {
      res.json({ items: await listRuns(ctx, req.branchId!) });
    }),
  );
  r.post(
    '/payroll-runs',
    ...manage,
    asyncHandler(async (req, res) => {
      const b = z
        .object({
          frequency: z.enum(['MONTHLY', 'WEEKLY', 'DAILY']),
          month: z
            .string()
            .regex(/^\d{4}-\d{2}$/)
            .optional(),
          from: isoDate.optional(),
          note: z.string().trim().max(200).nullable().optional(),
        })
        .strict()
        .parse(req.body);
      res.status(201).json(await createRun(ctx, actor(req), b));
    }),
  );
  r.get(
    '/payroll-runs/:id',
    ...view,
    asyncHandler(async (req, res) => {
      res.json(await getRun(ctx, req.branchId!, idParam.parse(req.params).id));
    }),
  );
  r.post(
    '/payroll-runs/:id/recalculate',
    ...manage,
    asyncHandler(async (req, res) => {
      res.json(await recalculateRun(ctx, actor(req), idParam.parse(req.params).id));
    }),
  );
  r.post(
    '/payroll-runs/:id/cancel',
    ...manage,
    asyncHandler(async (req, res) => {
      const b = z
        .object({ reason: z.string().trim().min(1).max(200) })
        .strict()
        .parse(req.body);
      await cancelRun(ctx, actor(req), idParam.parse(req.params).id, b.reason);
      res.status(204).end();
    }),
  );
  r.post(
    '/payroll-runs/:id/approve',
    ...approve,
    asyncHandler(async (req, res) => {
      res.json(await approveRun(ctx, actor(req), idParam.parse(req.params).id));
    }),
  );

  // ── manual lines (a bonus, a fine, last month's correction) on a draft payslip
  r.post(
    '/payslips/:id/lines',
    ...manage,
    asyncHandler(async (req, res) => {
      const b = z
        .object({
          kind: z.enum(['EARNING', 'DEDUCTION']),
          label: z.string().trim().min(1).max(80),
          amountPaisa: paisa,
        })
        .strict()
        .parse(req.body);
      res.status(201).json(await addManualLine(ctx, actor(req), idParam.parse(req.params).id, b));
    }),
  );
  r.delete(
    '/payslip-lines/:id',
    ...manage,
    asyncHandler(async (req, res) => {
      await removeManualLine(ctx, actor(req), idParam.parse(req.params).id);
      res.status(204).end();
    }),
  );

  // ── paying
  r.post(
    '/payslips/:id/pay',
    ...pay,
    asyncHandler(async (req, res) => {
      const b = z
        .object({
          amountPaisa: paisa.optional(),
          paidFrom: z.enum(['DRAWER_CASH', 'OWNER_CASH', 'BANK']),
          note: z.string().trim().max(120).optional(),
        })
        .strict()
        .parse(req.body);
      const a: OrdersActor = {
        branchId: req.branchId!,
        userId: req.principal!.userId,
        deviceId: req.principal!.deviceId,
        ip: req.ip,
        permissions: await ctx.permissions.get(req.principal!.roleId),
      };
      const out = await paySlip(ctx, a, idParam.parse(req.params).id, b, key(req));
      res.status(out.replayed ? 200 : 201).json(out);
    }),
  );

  // ── advances, loans and fines owed by staff (recovered from pay)
  r.get(
    '/staff-dues',
    ...view,
    asyncHandler(async (req, res) => {
      const q = z
        .object({
          employeeId: z.string().uuid().optional(),
          open: z.enum(['true', 'false']).optional(),
        })
        .parse(req.query);
      res.json({
        items: await listDues(ctx, req.branchId!, {
          employeeId: q.employeeId,
          open: q.open === 'true',
        }),
      });
    }),
  );
  r.post(
    '/staff-dues',
    ...manage,
    asyncHandler(async (req, res) => {
      const b = z
        .object({
          employeeId: z.string().uuid(),
          kind: z.enum(['ADVANCE', 'LOAN', 'FINE']),
          amountPaisa: paisa,
          installmentPaisa: paisa.optional(),
          reason: z.string().trim().min(1).max(120),
          paidFrom: z.enum(['DRAWER_CASH', 'OWNER_CASH', 'BANK']).optional(),
        })
        .strict()
        .parse(req.body);
      const a: OrdersActor = {
        branchId: req.branchId!,
        userId: req.principal!.userId,
        deviceId: req.principal!.deviceId,
        ip: req.ip,
        permissions: await ctx.permissions.get(req.principal!.roleId),
      };
      const out = await createDue(ctx, a, b, key(req));
      res.status(out.replayed ? 200 : 201).json(out);
    }),
  );
  r.patch(
    '/staff-dues/:id',
    ...manage,
    asyncHandler(async (req, res) => {
      const b = z.object({ paused: z.boolean() }).strict().parse(req.body);
      await setDuePaused(ctx, actor(req), idParam.parse(req.params).id, b.paused);
      res.status(204).end();
    }),
  );
  r.post(
    '/staff-dues/:id/write-off',
    ...approve,
    asyncHandler(async (req, res) => {
      const b = z
        .object({ reason: z.string().trim().min(1).max(200) })
        .strict()
        .parse(req.body);
      res.json(await writeOffDue(ctx, actor(req), idParam.parse(req.params).id, b.reason));
    }),
  );

  // ── the HR overview: who is here, attendance of the month, what staff cost
  r.get(
    '/hr/overview',
    ...read,
    requirePermission(ctx, 'employee.view'),
    asyncHandler(async (req, res) => {
      const q = z
        .object({ date: isoDate, month: z.string().regex(/^\d{4}-\d{2}$/) })
        .parse(req.query);
      const perms = await ctx.permissions.get(req.principal!.roleId);
      res.json(await hrOverview(ctx, req.branchId!, q, perms.has('payroll.view')));
    }),
  );

  return r;
}
