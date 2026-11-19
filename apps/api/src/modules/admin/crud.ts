import { Router } from 'express';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { asyncHandler } from '../../http/async-handler';
import type { AppContext } from '../../http/context';
import { AppError } from '../../http/errors';
import { orInUse } from '../../shared/in-use';
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
  /** Allow DELETE of a row that nothing refers to. A referenced row answers 409 IN_USE (switch it off). */
  deletable?: boolean;
  /**
   * Rows that history points at are ARCHIVED instead of refused (the table needs `is_active` and
   * `archived_at`): they are switched off and hidden for good. `liveCheck` throws when the row is in use
   * right now (for a table: an open order), which no archive may hide.
   */
  archivable?: {
    /** the table has no `is_active` column (areas, stations): archiving only sets `archived_at` */
    noActiveColumn?: boolean;
    liveCheck: (trx: Kysely<Record<string, Record<string, unknown>>>, id: string) => Promise<void>;
  };
}

/**
 * Minimal branch-scoped CRUD with audit. DELETE exists only where `deletable` is set, and only
 * succeeds for a row nothing refers to: configuration rows that history points at stay and are
 * deactivated (`is_active`) instead (CLAUDE.md rule 2, ADR 0022).
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
      if (o.archivable) q = q.where('archived_at', 'is', null); // archived rows are gone from every list
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

  if (o.deletable) {
    r.delete(
      '/:id',
      ...write,
      asyncHandler(async (req, res) => {
        const { id } = idParam.parse(req.params);
        await withTx(ctx.db, async (trx) => {
          const t = trx as unknown as typeof db;
          const before = await t
            .selectFrom(o.table)
            .selectAll()
            .where('id', '=', id)
            .where('branch_id', '=', req.branchId!)
            .forUpdate()
            .executeTakeFirst();
          if (!before) throw new AppError(404, 'NOT_FOUND', `${o.entity} not found`);
          if (o.archivable) await o.archivable.liveCheck(t, id);
          let archived = false;
          if (o.archivable) {
            // try the real delete; if history points at the row, archive it instead
            await sql`savepoint try_delete`.execute(trx);
            try {
              await t.deleteFrom(o.table).where('id', '=', id).execute();
            } catch (e) {
              if ((e as { code?: string }).code !== '23503') throw e;
              await sql`rollback to savepoint try_delete`.execute(trx);
              await t
                .updateTable(o.table)
                .set(
                  o.archivable.noActiveColumn
                    ? { archived_at: new Date() }
                    : { is_active: false, archived_at: new Date() },
                )
                .where('id', '=', id)
                .execute();
              archived = true;
            }
          } else {
            await orInUse(`This ${o.entity.replace('_', ' ')}`, () =>
              t.deleteFrom(o.table).where('id', '=', id).execute(),
            );
          }
          await writeAudit(trx, {
            branchId: req.branchId,
            userId: req.principal!.userId,
            deviceId: req.principal!.deviceId,
            action: `${o.entity.toUpperCase()}_${archived ? 'ARCHIVE' : 'DELETE'}`,
            entity: o.entity,
            entityId: id,
            before,
            ip: req.ip,
          });
          res.setHeader('X-Archived', String(archived));
        });
        res.status(204).end();
      }),
    );
  }

  return r;
}
