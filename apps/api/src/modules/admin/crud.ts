import { Router } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { asyncHandler } from '../../http/async-handler';
import type { AppContext } from '../../http/context';
import { AppError } from '../../http/errors';
import { withTx } from '../../shared/tx';
import { writeAudit } from '../audit/audit.service';
import { authenticate, requirePermission, resolveBranch } from '../auth/middleware';

export const idParam = z.object({ id: z.string().uuid() });

export interface CrudOptions {
  /** Physical table; must have `id uuid` and `branch_id uuid`. */
  table: string;
  /** e.g. `area` -> audit actions AREA_CREATE / AREA_UPDATE. */
  entity: string;
  /** Required for writes. Reads need only an authenticated user (POS needs floor/config). */
  permission: string;
  create: z.ZodObject<z.ZodRawShape>;
  orderBy: string[];
}

/**
 * Minimal branch-scoped CRUD with audit. Deliberately no DELETE: configuration rows are
 * referenced by history, so they are deactivated (`is_active`) instead (CLAUDE.md rule 2).
 * Column names come only from the Zod schemas below, never from the request.
 */
export function crudRouter(ctx: AppContext, o: CrudOptions): Router {
  const r = Router();
  // Kysely is statically typed per table; this helper is table-generic by design.
  const db = ctx.db as unknown as Kysely<Record<string, Record<string, unknown>>>;
  const update = o.create.partial().strict();
  const read = [authenticate(ctx), resolveBranch(ctx)];
  const write = [...read, requirePermission(ctx, o.permission)];

  r.get(
    '/',
    ...read,
    asyncHandler(async (req, res) => {
      let q = db.selectFrom(o.table).selectAll().where('branch_id', '=', req.branchId!);
      for (const col of o.orderBy) q = q.orderBy(col);
      res.json({ items: await q.execute() });
    }),
  );

  r.get(
    '/:id',
    ...read,
    asyncHandler(async (req, res) => {
      const { id } = idParam.parse(req.params);
      const row = await db
        .selectFrom(o.table)
        .selectAll()
        .where('id', '=', id)
        .where('branch_id', '=', req.branchId!)
        .executeTakeFirst();
      if (!row) throw new AppError(404, 'NOT_FOUND', `${o.entity} not found`);
      res.json(row);
    }),
  );

  r.post(
    '/',
    ...write,
    asyncHandler(async (req, res) => {
      const body = o.create.strict().parse(req.body);
      const row = await withTx(ctx.db, async (trx) => {
        const t = trx as unknown as typeof db;
        const created = await t
          .insertInto(o.table)
          .values({ ...body, branch_id: req.branchId! })
          .returningAll()
          .executeTakeFirstOrThrow();
        await writeAudit(trx, {
          branchId: req.branchId,
          userId: req.principal!.userId,
          deviceId: req.principal!.deviceId,
          action: `${o.entity.toUpperCase()}_CREATE`,
          entity: o.entity,
          entityId: created.id as string,
          after: created,
          ip: req.ip,
        });
        return created;
      });
      res.status(201).json(row);
    }),
  );

  r.patch(
    '/:id',
    ...write,
    asyncHandler(async (req, res) => {
      const { id } = idParam.parse(req.params);
      const body = update.parse(req.body);
      if (Object.keys(body).length === 0)
        throw new AppError(400, 'VALIDATION_FAILED', 'No fields to update');
      const row = await withTx(ctx.db, async (trx) => {
        const t = trx as unknown as typeof db;
        const before = await t
          .selectFrom(o.table)
          .selectAll()
          .where('id', '=', id)
          .where('branch_id', '=', req.branchId!)
          .forUpdate()
          .executeTakeFirst();
        if (!before) throw new AppError(404, 'NOT_FOUND', `${o.entity} not found`);
        const after = await t
          .updateTable(o.table)
          .set(body)
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await writeAudit(trx, {
          branchId: req.branchId,
          userId: req.principal!.userId,
          deviceId: req.principal!.deviceId,
          action: `${o.entity.toUpperCase()}_UPDATE`,
          entity: o.entity,
          entityId: id,
          before,
          after,
          ip: req.ip,
        });
        return after;
      });
      res.json(row);
    }),
  );

  return r;
}
