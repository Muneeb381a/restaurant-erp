import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/async-handler';
import type { AppContext } from '../../http/context';
import { AppError } from '../../http/errors';
import { withTx } from '../../shared/tx';
import { writeAudit } from '../audit/audit.service';
import { authenticate, requirePermission, resolveBranch } from '../auth/middleware';
import { idParam } from './crud';

const createBody = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z][A-Z0-9_]{1,29}$/, 'UPPER_SNAKE, 2-30 chars'),
    name: z.string().trim().min(1).max(100),
  })
  .strict();
const setPermsBody = z
  .object({ permissions: z.array(z.string().min(1).max(60)).max(200) })
  .strict();

export function rolesRouter(ctx: AppContext): Router {
  const r = Router();
  const guard = [authenticate(ctx), resolveBranch(ctx), requirePermission(ctx, 'user.manage')];

  r.get(
    '/permissions',
    ...guard,
    asyncHandler(async (_req, res) => {
      res.json({
        items: await ctx.db.selectFrom('permissions').selectAll().orderBy('code').execute(),
      });
    }),
  );

  r.get(
    '/roles',
    ...guard,
    asyncHandler(async (_req, res) => {
      const [roles, links] = await Promise.all([
        ctx.db.selectFrom('roles').selectAll().orderBy('code').execute(),
        ctx.db.selectFrom('role_permissions').selectAll().orderBy('permission_code').execute(),
      ]);
      res.json({
        items: roles.map((role) => ({
          ...role,
          permissions: links.filter((l) => l.role_id === role.id).map((l) => l.permission_code),
        })),
      });
    }),
  );

  r.post(
    '/roles',
    ...guard,
    asyncHandler(async (req, res) => {
      const b = createBody.parse(req.body);
      const row = await withTx(ctx.db, async (trx) => {
        const created = await trx
          .insertInto('roles')
          .values({ code: b.code, name: b.name })
          .returningAll()
          .executeTakeFirstOrThrow();
        await writeAudit(trx, {
          branchId: req.branchId,
          userId: req.principal!.userId,
          deviceId: req.principal!.deviceId,
          action: 'ROLE_CREATE',
          entity: 'role',
          entityId: created.id,
          after: created,
          ip: req.ip,
        });
        return created;
      });
      res.status(201).json({ ...row, permissions: [] });
    }),
  );

  /** Replaces a role's permission set. OWNER is fixed; you can only grant what you hold yourself. */
  r.put(
    '/roles/:id/permissions',
    ...guard,
    asyncHandler(async (req, res) => {
      const { id } = idParam.parse(req.params);
      const wanted = [...new Set(setPermsBody.parse(req.body).permissions)].sort();
      const actor = req.principal!;

      await withTx(ctx.db, async (trx) => {
        const role = await trx
          .selectFrom('roles')
          .selectAll()
          .where('id', '=', id)
          .forUpdate()
          .executeTakeFirst();
        if (!role) throw new AppError(404, 'NOT_FOUND', 'role not found');
        if (role.code === 'OWNER')
          throw new AppError(409, 'ROLE_PROTECTED', 'The OWNER role cannot be modified');

        const known = new Set(
          (await trx.selectFrom('permissions').select('code').execute()).map((p) => p.code),
        );
        const unknown = wanted.filter((p) => !known.has(p));
        if (unknown.length)
          throw new AppError(400, 'VALIDATION_FAILED', 'Unknown permission code(s)', { unknown });

        const actorPerms = await ctx.permissions.get(actor.roleId);
        const before = (
          await trx
            .selectFrom('role_permissions')
            .select('permission_code')
            .where('role_id', '=', id)
            .orderBy('permission_code')
            .execute()
        ).map((x) => x.permission_code);
        const escalation = wanted.filter((p) => !actorPerms.has(p) && !before.includes(p));
        if (escalation.length)
          throw new AppError(403, 'PERMISSION_DENIED', 'Cannot grant permissions you do not hold', {
            missing: escalation,
          });

        await trx.deleteFrom('role_permissions').where('role_id', '=', id).execute();
        if (wanted.length)
          await trx
            .insertInto('role_permissions')
            .values(wanted.map((permission_code) => ({ role_id: id, permission_code })))
            .execute();
        await writeAudit(trx, {
          branchId: req.branchId,
          userId: actor.userId,
          deviceId: actor.deviceId,
          action: 'ROLE_PERMISSIONS_SET',
          entity: 'role',
          entityId: id,
          before: { code: role.code, permissions: before },
          after: { code: role.code, permissions: wanted },
          ip: req.ip,
        });
      });
      ctx.permissions.invalidate(id); // take effect immediately on this node
      res.json({ id, permissions: wanted });
    }),
  );

  return r;
}
