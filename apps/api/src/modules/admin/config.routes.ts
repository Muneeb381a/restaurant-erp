import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/async-handler';
import type { AppContext } from '../../http/context';
import { AppError } from '../../http/errors';
import { withTx } from '../../shared/tx';
import { writeAudit } from '../audit/audit.service';
import { authenticate, requirePermission, resolveBranch } from '../auth/middleware';
import { crudRouter, idParam } from './crud';

const text = (max = 200) => z.string().trim().min(1).max(max);
const code = z.string().trim().min(1).max(40);

/** Floor, kitchen, payment-method and price-list configuration (permission: settings.manage). */
export function configRouters(ctx: AppContext): Record<string, Router> {
  const perm = 'settings.manage';
  return {
    '/areas': crudRouter(ctx, {
      table: 'areas',
      entity: 'area',
      permission: perm,
      deletable: true,
      orderBy: ['sort', 'name'],
      create: z.object({ name: text(), sort: z.number().int().min(0).max(10_000).optional() }),
    }),
    '/tables': crudRouter(ctx, {
      table: 'dining_tables',
      entity: 'dining_table',
      permission: perm,
      deletable: true,
      archivable: {
        liveCheck: async (trx, id) => {
          const open = await trx
            .selectFrom('orders')
            .select('order_no')
            .where('table_id', '=', id)
            .where('status', 'in', ['OPEN', 'BILLED'])
            .executeTakeFirst();
          if (open)
            throw new AppError(
              409,
              'IN_USE',
              `This table has an open order (#${open.order_no}) right now. Finish or cancel it first.`,
            );
        },
      },
      orderBy: ['code'],
      create: z.object({
        area_id: z.string().uuid().nullable().optional(),
        code,
        seats: z.number().int().min(1).max(100).optional(),
        pos_x: z.number().int().nullable().optional(),
        pos_y: z.number().int().nullable().optional(),
        is_active: z.boolean().optional(),
      }),
    }),
    '/stations': crudRouter(ctx, {
      table: 'stations',
      entity: 'station',
      permission: perm,
      deletable: true,
      orderBy: ['code'],
      create: z.object({ code, name: text() }),
    }),
    '/printers': crudRouter(ctx, {
      table: 'printers',
      entity: 'printer',
      permission: perm,
      deletable: true,
      orderBy: ['name'],
      create: z.object({
        name: text(),
        kind: z.enum(['RECEIPT', 'KOT']),
        conn_type: z.enum(['NETWORK', 'USB', 'SERIAL']),
        host: z.string().trim().min(1).max(253).nullable().optional(),
        port: z.number().int().min(1).max(65535).optional(),
        paper_mm: z.union([z.literal(58), z.literal(80)]).optional(),
        is_active: z.boolean().optional(),
      }),
    }),
    '/payment-methods': crudRouter(ctx, {
      table: 'payment_methods',
      entity: 'payment_method',
      permission: perm,
      orderBy: ['code'],
      create: z.object({
        code,
        name: text(),
        tender_class: z.enum(['CASH_OTHER', 'DIGITAL']),
        opens_drawer: z.boolean().optional(),
        needs_reference: z.boolean().optional(),
        is_active: z.boolean().optional(),
      }),
    }),
    '/price-lists': crudRouter(ctx, {
      table: 'price_lists',
      entity: 'price_list',
      permission: perm,
      orderBy: ['code'],
      create: z.object({ code, name: text() }),
    }),
  };
}

/** Which printers print a station's KOTs. */
export function stationPrintersRouter(ctx: AppContext): Router {
  const r = Router();
  const body = z.object({ printerIds: z.array(z.string().uuid()).max(20) }).strict();

  r.get(
    '/:id/printers',
    authenticate(ctx),
    resolveBranch(ctx),
    asyncHandler(async (req, res) => {
      const { id } = idParam.parse(req.params);
      const rows = await ctx.db
        .selectFrom('station_printers')
        .innerJoin('stations', 'stations.id', 'station_printers.station_id')
        .select('station_printers.printer_id as printer_id')
        .where('stations.id', '=', id)
        .where('stations.branch_id', '=', req.branchId!)
        .execute();
      res.json({ printerIds: rows.map((x) => x.printer_id) });
    }),
  );

  r.put(
    '/:id/printers',
    authenticate(ctx),
    resolveBranch(ctx),
    requirePermission(ctx, 'settings.manage'),
    asyncHandler(async (req, res) => {
      const { id } = idParam.parse(req.params);
      const { printerIds } = body.parse(req.body);
      await withTx(ctx.db, async (trx) => {
        const station = await trx
          .selectFrom('stations')
          .select('id')
          .where('id', '=', id)
          .where('branch_id', '=', req.branchId!)
          .forUpdate()
          .executeTakeFirst();
        if (!station) throw new AppError(404, 'NOT_FOUND', 'station not found');
        const unique = [...new Set(printerIds)];
        if (unique.length) {
          const ok = await trx
            .selectFrom('printers')
            .select('id')
            .where('branch_id', '=', req.branchId!)
            .where('id', 'in', unique)
            .execute();
          if (ok.length !== unique.length)
            throw new AppError(400, 'VALIDATION_FAILED', 'Unknown printer id for this branch');
        }
        const before = (
          await trx
            .selectFrom('station_printers')
            .select('printer_id')
            .where('station_id', '=', id)
            .execute()
        ).map((x) => x.printer_id);
        await trx.deleteFrom('station_printers').where('station_id', '=', id).execute();
        if (unique.length)
          await trx
            .insertInto('station_printers')
            .values(unique.map((printer_id) => ({ station_id: id, printer_id })))
            .execute();
        await writeAudit(trx, {
          branchId: req.branchId,
          userId: req.principal!.userId,
          deviceId: req.principal!.deviceId,
          action: 'STATION_PRINTERS_SET',
          entity: 'station',
          entityId: id,
          before: { printerIds: before },
          after: { printerIds: unique },
          ip: req.ip,
        });
      });
      res.json({ printerIds: [...new Set(printerIds)] });
    }),
  );

  return r;
}
