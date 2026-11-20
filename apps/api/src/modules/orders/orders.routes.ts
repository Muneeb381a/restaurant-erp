import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/async-handler';
import type { AppContext } from '../../http/context';
import { AppError } from '../../http/errors';
import { idParam } from '../admin/crud';
import { authenticate, requirePermission, resolveBranch } from '../auth/middleware';
import * as day from '../day/day.service';
import { getFloor, listOrders } from './floor.service';
import { getOrderFull, type OrderView } from './orders.repo';
import * as svc from './orders.service';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const reason = z.string().trim().min(3).max(300);

const createBody = z
  .object({
    type: z.enum(['DINE_IN', 'TAKEAWAY', 'DELIVERY']),
    tableId: uuid.optional(),
    guests: z.number().int().min(1).max(500).optional(),
    customerId: uuid.optional(),
    notes: z.string().trim().max(500).optional(),
    customerName: z.string().trim().max(80).optional(),
    customerPhone: z.string().trim().max(30).optional(),
    deliveryAddress: z.string().trim().max(300).optional(),
    externalRef: z.string().trim().max(40).optional(),
    channel: z.enum(['POS', 'PHONE', 'WHATSAPP', 'FOODPANDA', 'WEB', 'OTHER']).optional(),
    priceList: z.string().trim().min(1).max(40).optional(),
  })
  .strict();

const patchBody = z
  .object({
    guests: z.number().int().min(1).max(500).nullable(),
    notes: z.string().trim().max(500).nullable(),
    customerName: z.string().trim().max(80).nullable(),
    customerPhone: z.string().trim().max(30).nullable(),
    deliveryAddress: z.string().trim().max(300).nullable(),
    externalRef: z.string().trim().max(40).nullable(),
    channel: z.enum(['POS', 'PHONE', 'WHATSAPP', 'FOODPANDA', 'WEB', 'OTHER']),
    customerId: uuid.nullable(),
  })
  .partial()
  .strict();

const pickSchema = z
  .object({ slotId: uuid, optionId: uuid, count: z.number().int().min(1).max(100) })
  .strict();
const addItemBody = z
  .object({
    itemId: uuid,
    variantId: uuid,
    qty: z.number().int().min(1).max(1000).optional(),
    weightG: z.number().int().min(1).max(1_000_000).optional(),
    modifierIds: z.array(uuid).max(50).optional(),
    dealPicks: z.array(pickSchema).max(100).optional(),
    note: z.string().trim().max(300).optional(),
    course: z.number().int().min(1).max(10).optional(),
  })
  .strict();
const updateItemBody = z
  .object({
    qty: z.number().int().min(1).max(1000),
    weightG: z.number().int().min(1).max(1_000_000),
    modifierIds: z.array(uuid).max(50),
    note: z.string().trim().max(300).nullable(),
    course: z.number().int().min(1).max(10),
  })
  .partial()
  .strict();

/** `Idempotency-Key` (8-80 characters) of a command that may be repeated after a lost answer. */
function commandKey(req: Request): string | undefined {
  const key = req.header('idempotency-key');
  if (key === undefined) return undefined;
  if (!/^[A-Za-z0-9._:-]{8,80}$/.test(key))
    throw new AppError(
      400,
      'VALIDATION_FAILED',
      'Idempotency-Key must be 8-80 characters: letters, digits . _ : -',
    );
  return key;
}

/** `If-Match: 3` or `If-Match: "3"` → 3 */
function ifMatch(req: Request): number | undefined {
  const raw = req.header('if-match');
  if (raw === undefined) return undefined;
  const n = Number(raw.replace(/^W\//, '').replace(/"/g, '').trim());
  if (!Number.isInteger(n) || n < 1)
    throw new AppError(400, 'VALIDATION_FAILED', 'If-Match must be the order version number');
  return n;
}

export function ordersRouter(ctx: AppContext): Router {
  const r = Router();
  const read = [authenticate(ctx), resolveBranch(ctx)];
  const edit = [...read, requirePermission(ctx, 'order.create')];
  const transfer = [...read, requirePermission(ctx, 'order.transfer')];

  const actor = async (req: Request): Promise<svc.Actor> => ({
    branchId: req.branchId!,
    userId: req.principal!.userId,
    deviceId: req.principal!.deviceId,
    ip: req.ip,
    permissions: await ctx.permissions.get(req.principal!.roleId),
  });
  const dayActor = (req: Request): day.Actor => ({
    branchId: req.branchId!,
    userId: req.principal!.userId,
    deviceId: req.principal!.deviceId,
    ip: req.ip,
  });
  const send = (res: Response, order: OrderView, status = 200, extra: object = {}): void => {
    res.setHeader('ETag', `"${order.version}"`);
    res.status(status).json({ ...order, ...extra });
  };

  // ───────── business day + shift
  r.get(
    '/business-days/current',
    ...read,
    asyncHandler(async (req, res) => {
      res.json({ day: await day.getCurrentDay(ctx, req.branchId!) });
    }),
  );
  r.post(
    '/business-days/open',
    ...read,
    requirePermission(ctx, 'day.open'),
    asyncHandler(async (req, res) => {
      const { businessDate } = z
        .object({ businessDate: isoDate.optional() })
        .strict()
        .parse(req.body);
      res.status(201).json(await day.openDay(ctx, dayActor(req), businessDate));
    }),
  );
  r.get(
    '/shifts/current',
    ...read,
    asyncHandler(async (req, res) => {
      res.json({ shift: await day.getMyShift(ctx, req.principal!.userId) });
    }),
  );
  r.post(
    '/shifts/open',
    ...read,
    requirePermission(ctx, 'shift.open'),
    asyncHandler(async (req, res) => {
      const body = z
        .object({
          openingFloatPaisa: z.number().int().min(0).max(1_000_000_000),
          deviceId: uuid.optional(),
        })
        .strict()
        .parse(req.body);
      res.status(201).json(await day.openShift(ctx, dayActor(req), body));
    }),
  );

  // ───────── floor + lists
  r.get(
    '/floor',
    ...read,
    asyncHandler(async (req, res) => {
      res.json(await getFloor(ctx, req.branchId!));
    }),
  );
  r.get(
    '/orders',
    ...read,
    asyncHandler(async (req, res) => {
      const q = z
        .object({
          status: z
            .enum(['active', 'OPEN', 'BILLED', 'SETTLED', 'CANCELLED', 'all'])
            .default('active'),
          type: z.enum(['DINE_IN', 'TAKEAWAY', 'DELIVERY']).optional(),
          held: z.enum(['true', 'false']).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        })
        .parse(req.query);
      res.json({
        items: await listOrders(ctx, req.branchId!, {
          status: q.status,
          type: q.type,
          held: q.held === undefined ? undefined : q.held === 'true',
          limit: q.limit,
        }),
      });
    }),
  );
  // the token printed on the ticket and the bill: before /orders/:id so it is not read as an id
  r.get(
    '/orders/by-token/:token',
    ...read,
    asyncHandler(async (req, res) => {
      const token = z.coerce.number().int().min(1).max(99_999).parse(req.params.token);
      res.json(await svc.findOrderByToken(ctx, req.branchId!, token));
    }),
  );
  r.get(
    '/orders/:id',
    ...read,
    asyncHandler(async (req, res) => {
      send(res, await getOrderFull(ctx.db, req.branchId!, idParam.parse(req.params).id));
    }),
  );

  // ───────── commands
  r.post(
    '/orders',
    ...edit,
    asyncHandler(async (req, res) => {
      send(res, await svc.createOrder(ctx, await actor(req), createBody.parse(req.body)), 201);
    }),
  );
  r.patch(
    '/orders/:id',
    ...edit,
    asyncHandler(async (req, res) => {
      const body = patchBody.parse(req.body);
      if (Object.keys(body).length === 0)
        throw new AppError(400, 'VALIDATION_FAILED', 'No fields to update');
      send(
        res,
        await svc.updateOrder(
          ctx,
          await actor(req),
          idParam.parse(req.params).id,
          body,
          ifMatch(req),
        ),
      );
    }),
  );
  r.post(
    '/orders/:id/hold',
    ...edit,
    asyncHandler(async (req, res) => {
      send(
        res,
        await svc.setHeld(ctx, await actor(req), idParam.parse(req.params).id, true, ifMatch(req)),
      );
    }),
  );
  r.post(
    '/orders/:id/resume',
    ...edit,
    asyncHandler(async (req, res) => {
      send(
        res,
        await svc.setHeld(ctx, await actor(req), idParam.parse(req.params).id, false, ifMatch(req)),
      );
    }),
  );

  r.post(
    '/orders/:id/items',
    ...edit,
    asyncHandler(async (req, res) => {
      const out = await svc.addItem(
        ctx,
        await actor(req),
        idParam.parse(req.params).id,
        addItemBody.parse(req.body),
        ifMatch(req),
        commandKey(req),
      );
      send(res, out.order, 201, { addedLineId: out.lineId });
    }),
  );
  r.patch(
    '/orders/:id/items/:lineId',
    ...edit,
    asyncHandler(async (req, res) => {
      const p = z.object({ id: uuid, lineId: uuid }).parse(req.params);
      const body = updateItemBody.parse(req.body);
      if (Object.keys(body).length === 0)
        throw new AppError(400, 'VALIDATION_FAILED', 'No fields to update');
      send(res, await svc.updateItem(ctx, await actor(req), p.id, p.lineId, body, ifMatch(req)));
    }),
  );
  // The permission for voiding depends on the line's state (free while NEW), so it is checked in the service.
  r.post(
    '/orders/:id/items/:lineId/void',
    ...edit,
    asyncHandler(async (req, res) => {
      const p = z.object({ id: uuid, lineId: uuid }).parse(req.params);
      const body = z.object({ reason: reason.optional() }).strict().parse(req.body);
      send(
        res,
        await svc.voidItem(ctx, await actor(req), p.id, p.lineId, body.reason, ifMatch(req)),
      );
    }),
  );

  r.post(
    '/orders/:id/transfer',
    ...transfer,
    asyncHandler(async (req, res) => {
      const { tableId } = z.object({ tableId: uuid }).strict().parse(req.body);
      send(
        res,
        await svc.transferTable(
          ctx,
          await actor(req),
          idParam.parse(req.params).id,
          tableId,
          ifMatch(req),
        ),
      );
    }),
  );
  r.post(
    '/orders/:id/merge',
    ...transfer,
    asyncHandler(async (req, res) => {
      const { sourceOrderId } = z.object({ sourceOrderId: uuid }).strict().parse(req.body);
      send(
        res,
        await svc.mergeOrders(
          ctx,
          await actor(req),
          idParam.parse(req.params).id,
          sourceOrderId,
          ifMatch(req),
        ),
      );
    }),
  );
  r.post(
    '/orders/:id/cancel',
    ...read,
    requirePermission(ctx, 'order.cancel'),
    asyncHandler(async (req, res) => {
      const body = z.object({ reason }).strict().parse(req.body);
      send(
        res,
        await svc.cancelOrder(
          ctx,
          await actor(req),
          idParam.parse(req.params).id,
          body.reason,
          ifMatch(req),
        ),
      );
    }),
  );

  return r;
}
