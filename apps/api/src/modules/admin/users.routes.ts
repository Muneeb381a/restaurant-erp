import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/async-handler';
import type { AppContext } from '../../http/context';
import { AppError } from '../../http/errors';
import { withTx, type Queryable } from '../../shared/tx';
import { writeAudit } from '../audit/audit.service';
import { revokeAllSessions } from '../auth/auth.service';
import { authenticate, requirePermission, resolveBranch } from '../auth/middleware';
import { passwordSchema, pinSchema } from '../auth/password';
import { idParam } from './crud';

const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{3,50}$/, '3-50 chars: a-z 0-9 . _ -');
const limit = z.number().int().min(0).max(10_000);

const createBody = z
  .object({
    username: usernameSchema,
    fullName: z.string().trim().min(1).max(200),
    roleId: z.string().uuid(),
    /** Omit for the request's branch; `null` = owner-level (all branches), only an owner-level actor may do that. */
    branchId: z.string().uuid().nullable().optional(),
    discountLimitBps: limit.optional(),
    password: passwordSchema.optional(),
    pin: pinSchema.optional(),
  })
  .strict()
  .refine((b) => b.password || b.pin, { message: 'Provide a password and/or a PIN' });

const patchBody = z
  .object({
    fullName: z.string().trim().min(1).max(200),
    roleId: z.string().uuid(),
    isActive: z.boolean(),
    discountLimitBps: limit,
  })
  .partial()
  .strict();

const credentialsBody = z
  .object({ password: passwordSchema.optional(), pin: pinSchema.optional() })
  .strict()
  .refine((b) => b.password || b.pin, { message: 'Provide a password and/or a PIN' });

// Never select hashes for responses.
const SAFE_COLUMNS = [
  'users.id as id',
  'users.branch_id as branch_id',
  'users.role_id as role_id',
  'roles.code as role_code',
  'users.username as username',
  'users.full_name as full_name',
  'users.discount_limit_bps as discount_limit_bps',
  'users.is_active as is_active',
  'users.locked_until as locked_until',
  'users.created_at as created_at',
] as const;

async function loadUser(q: Queryable, id: string) {
  return q
    .selectFrom('users')
    .innerJoin('roles', 'roles.id', 'users.role_id')
    .select([...SAFE_COLUMNS, 'users.pin_hash as pin_hash', 'users.password_hash as password_hash'])
    .where('users.id', '=', id)
    .forUpdate('users')
    .executeTakeFirst();
}

const present = <T extends { pin_hash?: string | null; password_hash?: string | null }>(u: T) => {
  const { pin_hash, password_hash, ...rest } = u;
  return { ...rest, has_pin: !!pin_hash, has_password: !!password_hash };
};

export function usersRouter(ctx: AppContext): Router {
  const r = Router();
  const guard = [authenticate(ctx), resolveBranch(ctx), requirePermission(ctx, 'user.manage')];

  /** A manager may never hand out more power than they hold (no privilege escalation). */
  async function assertCanAssign(
    actorRoleId: string,
    targetRoleId: string,
    q: Queryable,
  ): Promise<void> {
    const role = await q
      .selectFrom('roles')
      .select(['id', 'code'])
      .where('id', '=', targetRoleId)
      .executeTakeFirst();
    if (!role) throw new AppError(400, 'VALIDATION_FAILED', 'Unknown roleId');
    const [actor, target] = await Promise.all([
      ctx.permissions.get(actorRoleId),
      q
        .selectFrom('role_permissions')
        .select('permission_code')
        .where('role_id', '=', targetRoleId)
        .execute(),
    ]);
    const missing = target.map((t) => t.permission_code).filter((p) => !actor.has(p));
    if (missing.length)
      throw new AppError(
        403,
        'PERMISSION_DENIED',
        'Cannot assign a role with more permissions than your own',
        { missing },
      );
  }

  /** Target must belong to this branch (owner-level actors may also manage owner-level users). */
  function assertInScope(
    target: { branch_id: string | null },
    branchId: string,
    actorBranch: string | null,
  ): void {
    const ok = target.branch_id === branchId || (target.branch_id === null && actorBranch === null);
    if (!ok) throw new AppError(404, 'NOT_FOUND', 'user not found');
  }

  async function otherActiveOwners(q: Queryable, excludeId: string): Promise<number> {
    const row = await q
      .selectFrom('users')
      .innerJoin('roles', 'roles.id', 'users.role_id')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('roles.code', '=', 'OWNER')
      .where('users.is_active', '=', true)
      .where('users.id', '!=', excludeId)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  r.get(
    '/',
    ...guard,
    asyncHandler(async (req, res) => {
      const actorBranch = req.principal!.userBranchId;
      let q = ctx.db
        .selectFrom('users')
        .innerJoin('roles', 'roles.id', 'users.role_id')
        .leftJoin('user_avatars', 'user_avatars.user_id', 'users.id')
        .select([
          ...SAFE_COLUMNS,
          'users.pin_hash as pin_hash',
          'users.password_hash as password_hash',
          'user_avatars.updated_at as avatar_at',
        ])
        .orderBy('users.username');
      q =
        actorBranch === null
          ? q.where((eb) =>
              eb.or([eb('users.branch_id', '=', req.branchId!), eb('users.branch_id', 'is', null)]),
            )
          : q.where('users.branch_id', '=', req.branchId!);
      res.json({
        items: (await q.execute()).map(({ avatar_at, ...u }) => ({
          ...present(u),
          avatar_version: avatar_at ? avatar_at.getTime() : null,
        })),
      });
    }),
  );

  r.post(
    '/',
    ...guard,
    asyncHandler(async (req, res) => {
      const b = createBody.parse(req.body);
      const actor = req.principal!;
      const branchId = b.branchId === undefined ? req.branchId! : b.branchId;
      if (branchId === null && actor.userBranchId !== null) {
        throw new AppError(
          403,
          'PERMISSION_DENIED',
          'Only an owner-level user can create owner-level users',
        );
      }
      if (branchId !== null && branchId !== req.branchId)
        throw new AppError(400, 'VALIDATION_FAILED', 'branchId must be the current branch');

      const password_hash = b.password ? await ctx.hasher.hash(b.password) : null;
      const pin_hash = b.pin ? await ctx.hasher.hash(b.pin) : null;
      const created = await withTx(ctx.db, async (trx) => {
        await assertCanAssign(actor.roleId, b.roleId, trx);
        const { id } = await trx
          .insertInto('users')
          .values({
            branch_id: branchId,
            role_id: b.roleId,
            username: b.username,
            full_name: b.fullName,
            password_hash,
            pin_hash,
            discount_limit_bps: b.discountLimitBps ?? 0,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        const row = present((await loadUser(trx, id))!);
        await writeAudit(trx, {
          branchId: req.branchId,
          userId: actor.userId,
          deviceId: actor.deviceId,
          action: 'USER_CREATE',
          entity: 'user',
          entityId: id,
          after: row,
          ip: req.ip,
        });
        return row;
      });
      res.status(201).json(created);
    }),
  );

  r.patch(
    '/:id',
    ...guard,
    asyncHandler(async (req, res) => {
      const { id } = idParam.parse(req.params);
      const b = patchBody.parse(req.body);
      if (Object.keys(b).length === 0)
        throw new AppError(400, 'VALIDATION_FAILED', 'No fields to update');
      const actor = req.principal!;

      const after = await withTx(ctx.db, async (trx) => {
        const before = await loadUser(trx, id);
        if (!before) throw new AppError(404, 'NOT_FOUND', 'user not found');
        assertInScope(before, req.branchId!, actor.userBranchId);

        // You can only modify accounts whose role is no more powerful than your own.
        if (id !== actor.userId) await assertCanAssign(actor.roleId, before.role_id, trx);

        const losingOwner =
          before.role_code === 'OWNER' &&
          before.is_active &&
          (b.isActive === false || (b.roleId !== undefined && b.roleId !== before.role_id));
        if (losingOwner && (await otherActiveOwners(trx, id)) === 0) {
          throw new AppError(
            409,
            'LAST_OWNER',
            'The last active owner cannot be deactivated or demoted',
          );
        }
        if (b.isActive === false && id === actor.userId)
          throw new AppError(409, 'CONFLICT', 'You cannot deactivate your own account');
        if (b.roleId && b.roleId !== before.role_id)
          await assertCanAssign(actor.roleId, b.roleId, trx);

        await trx
          .updateTable('users')
          .set({
            ...(b.fullName !== undefined && { full_name: b.fullName }),
            ...(b.roleId !== undefined && { role_id: b.roleId }),
            ...(b.isActive !== undefined && { is_active: b.isActive }),
            ...(b.discountLimitBps !== undefined && { discount_limit_bps: b.discountLimitBps }),
          })
          .where('id', '=', id)
          .execute();

        // Role change or deactivation must cut live sessions immediately.
        if (b.isActive === false || (b.roleId && b.roleId !== before.role_id))
          await revokeAllSessions(trx, id, ctx.clock.now());

        const row = present((await loadUser(trx, id))!);
        await writeAudit(trx, {
          branchId: req.branchId,
          userId: actor.userId,
          deviceId: actor.deviceId,
          action: 'USER_UPDATE',
          entity: 'user',
          entityId: id,
          before: present(before),
          after: row,
          ip: req.ip,
        });
        return row;
      });
      res.json(after);
    }),
  );

  r.post(
    '/:id/credentials',
    ...guard,
    asyncHandler(async (req, res) => {
      const { id } = idParam.parse(req.params);
      const b = credentialsBody.parse(req.body);
      const actor = req.principal!;
      const password_hash = b.password ? await ctx.hasher.hash(b.password) : undefined;
      const pin_hash = b.pin ? await ctx.hasher.hash(b.pin) : undefined;

      await withTx(ctx.db, async (trx) => {
        const user = await loadUser(trx, id);
        if (!user) throw new AppError(404, 'NOT_FOUND', 'user not found');
        assertInScope(user, req.branchId!, actor.userBranchId);
        // Resetting someone else's credentials must not be a way to take over a more powerful account.
        if (id !== actor.userId) await assertCanAssign(actor.roleId, user.role_id, trx);
        await trx
          .updateTable('users')
          .set({
            ...(password_hash && { password_hash }),
            ...(pin_hash && { pin_hash }),
            failed_attempts: 0,
            last_failed_at: null,
            locked_until: null,
          })
          .where('id', '=', id)
          .execute();
        await revokeAllSessions(trx, id, ctx.clock.now());
        await writeAudit(trx, {
          branchId: req.branchId,
          userId: actor.userId,
          deviceId: actor.deviceId,
          action: 'USER_CREDENTIALS_RESET',
          entity: 'user',
          entityId: id,
          after: { passwordChanged: !!b.password, pinChanged: !!b.pin },
          ip: req.ip,
        });
      });
      res.status(204).end();
    }),
  );

  r.post(
    '/:id/unlock',
    ...guard,
    asyncHandler(async (req, res) => {
      const { id } = idParam.parse(req.params);
      const actor = req.principal!;
      await withTx(ctx.db, async (trx) => {
        const user = await loadUser(trx, id);
        if (!user) throw new AppError(404, 'NOT_FOUND', 'user not found');
        assertInScope(user, req.branchId!, actor.userBranchId);
        await trx
          .updateTable('users')
          .set({ failed_attempts: 0, last_failed_at: null, locked_until: null })
          .where('id', '=', id)
          .execute();
        await writeAudit(trx, {
          branchId: req.branchId,
          userId: actor.userId,
          deviceId: actor.deviceId,
          action: 'USER_UNLOCK',
          entity: 'user',
          entityId: id,
          before: { lockedUntil: user.locked_until },
          ip: req.ip,
        });
      });
      res.status(204).end();
    }),
  );

  return r;
}
