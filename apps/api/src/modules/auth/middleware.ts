import type { RequestHandler } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/async-handler';
import type { AppContext } from '../../http/context';
import { AppError } from '../../http/errors';
import { verifyAccessToken } from './tokens';

/** Verifies the bearer token AND that its session is live and the user still active. */
export function authenticate(ctx: AppContext): RequestHandler {
  return asyncHandler(async (req, _res, next) => {
    const header = req.header('authorization') ?? '';
    const m = /^Bearer (.+)$/.exec(header);
    if (!m) throw new AppError(401, 'UNAUTHENTICATED', 'Missing bearer token');
    const now = ctx.clock.now();
    const claims = await verifyAccessToken(ctx.auth.jwtSecret, m[1]!, now);

    const row = await ctx.db
      .selectFrom('sessions')
      .innerJoin('users', 'users.id', 'sessions.user_id')
      .innerJoin('roles', 'roles.id', 'users.role_id')
      .select([
        'users.id as user_id',
        'users.username as username',
        'users.full_name as full_name',
        'users.role_id as role_id',
        'roles.code as role_code',
        'users.branch_id as branch_id',
        'users.discount_limit_bps as discount_limit_bps',
        'users.is_active as is_active',
        'users.must_change_password as must_change_password',
        'sessions.id as session_id',
        'sessions.device_id as device_id',
        'sessions.revoked_at as revoked_at',
        'sessions.expires_at as expires_at',
      ])
      .where('sessions.id', '=', claims.sessionId)
      .where('sessions.user_id', '=', claims.userId)
      .executeTakeFirst();

    if (!row || row.revoked_at || !row.is_active || row.expires_at.getTime() <= now.getTime()) {
      throw new AppError(401, 'UNAUTHENTICATED', 'Session is no longer valid');
    }
    if (
      row.must_change_password &&
      !/\/auth\/(me|change-password|logout)$/.test(req.originalUrl.split('?')[0]!)
    ) {
      throw new AppError(
        403,
        'PASSWORD_CHANGE_REQUIRED',
        'Change your temporary password before continuing',
      );
    }
    req.principal = {
      userId: row.user_id,
      username: row.username,
      fullName: row.full_name,
      roleId: row.role_id,
      roleCode: row.role_code,
      userBranchId: row.branch_id,
      sessionId: row.session_id,
      deviceId: row.device_id,
      discountLimitBps: row.discount_limit_bps,
      mustChangePassword: row.must_change_password,
    };
    next();
  });
}

/** Permission checks live in the API, never only in the UI (CLAUDE.md DoD). */
export function requirePermission(ctx: AppContext, code: string): RequestHandler {
  return asyncHandler(async (req, _res, next) => {
    const p = req.principal;
    if (!p) throw new AppError(401, 'UNAUTHENTICATED', 'Not authenticated');
    const perms = await ctx.permissions.get(p.roleId);
    if (!perms.has(code)) {
      throw new AppError(403, 'PERMISSION_DENIED', 'You do not have permission for this action', {
        permission: code,
      });
    }
    next();
  });
}

const uuid = z.string().uuid();

/**
 * Effective branch: the user's own branch; owner-level users (branch NULL) use `x-branch-id`,
 * or the only active branch when there is exactly one.
 */
export function resolveBranch(ctx: AppContext): RequestHandler {
  return asyncHandler(async (req, _res, next) => {
    const p = req.principal;
    if (!p) throw new AppError(401, 'UNAUTHENTICATED', 'Not authenticated');
    if (p.userBranchId) {
      req.branchId = p.userBranchId;
      return next();
    }
    const header = req.header('x-branch-id');
    if (header) {
      const id = uuid.safeParse(header);
      const found = id.success
        ? await ctx.db
            .selectFrom('branches')
            .select('id')
            .where('id', '=', id.data)
            .where('is_active', '=', true)
            .executeTakeFirst()
        : undefined;
      if (!found)
        throw new AppError(400, 'BRANCH_REQUIRED', 'x-branch-id does not match an active branch');
      req.branchId = found.id;
      return next();
    }
    const branches = await ctx.db
      .selectFrom('branches')
      .select('id')
      .where('is_active', '=', true)
      .limit(2)
      .execute();
    if (branches.length !== 1) {
      throw new AppError(
        400,
        'BRANCH_REQUIRED',
        'Send x-branch-id (several or no active branches)',
      );
    }
    req.branchId = branches[0]!.id;
    next();
  });
}
