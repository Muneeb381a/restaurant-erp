import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../http/async-handler';
import { AppError } from '../http/errors';
import { verifyAccessToken } from '../modules/auth/tokens';
import { recentErrors } from './error-log';
import {
  activateTenant,
  archiveTenant,
  auditTrail,
  getTenant,
  listTenants,
  loginAdmin,
  logoutAdmin,
  migrateTenant,
  publicTenantInfo,
  refreshAdmin,
  resetOwner,
  retryProvisioning,
  suspendTenant,
  tenantHealth,
  updateTenant,
  createTenant,
  type AdminPrincipal,
  type PlatformDeps,
} from './platform.service';

const id = z.object({ id: z.string().uuid() });
const text = (max: number) => z.string().trim().min(1).max(max);
const phone = z.string().trim().max(30);

/** The platform admin's own sign-in: a different secret and a different table from any restaurant's. */
function guard(d: PlatformDeps): RequestHandler {
  return asyncHandler(async (req, _res, next) => {
    const m = /^Bearer (.+)$/.exec(req.header('authorization') ?? '');
    if (!m) throw new AppError(401, 'UNAUTHENTICATED', 'Missing bearer token');
    const now = d.now ? d.now() : new Date();
    const claims = await verifyAccessToken(d.platformJwtSecret, m[1]!, now);
    const row = await d.control
      .selectFrom('platform_sessions')
      .innerJoin('platform_admins', 'platform_admins.id', 'platform_sessions.admin_id')
      .select([
        'platform_admins.id as id',
        'platform_admins.username as username',
        'platform_admins.full_name as full_name',
        'platform_admins.is_active as is_active',
        'platform_sessions.id as session_id',
        'platform_sessions.revoked_at as revoked_at',
        'platform_sessions.expires_at as expires_at',
      ])
      .where('platform_sessions.id', '=', claims.sessionId)
      .where('platform_sessions.admin_id', '=', claims.userId)
      .executeTakeFirst();
    if (!row || row.revoked_at || !row.is_active || row.expires_at.getTime() <= now.getTime())
      throw new AppError(401, 'UNAUTHENTICATED', 'Session is no longer valid');
    req.platformAdmin = {
      id: row.id,
      username: row.username,
      fullName: row.full_name,
      sessionId: row.session_id,
    } satisfies AdminPrincipal;
    next();
  });
}

export function platformRouter(d: PlatformDeps): Router {
  const r = Router();
  const auth = guard(d);
  const admin = (req: Express.Request): AdminPrincipal => req.platformAdmin!;

  // a restaurant code is looked up before anyone signs in (the login screen shows the name)
  r.get(
    '/public/tenants/:slug',
    asyncHandler(async (req, res) => {
      const slug = z.string().min(1).max(60).parse(req.params.slug);
      res.json(await publicTenantInfo(d, slug));
    }),
  );

  r.post(
    '/platform/auth/login',
    asyncHandler(async (req, res) => {
      const b = z
        .object({ username: text(60), password: z.string().min(1).max(200) })
        .strict()
        .parse(req.body);
      res.json(await loginAdmin(d, { ...b, ip: req.ip }));
    }),
  );
  r.post(
    '/platform/auth/refresh',
    asyncHandler(async (req, res) => {
      const b = z
        .object({ refreshToken: z.string().min(1).max(300) })
        .strict()
        .parse(req.body);
      res.json(await refreshAdmin(d, b.refreshToken));
    }),
  );
  r.post(
    '/platform/auth/logout',
    auth,
    asyncHandler(async (req, res) => {
      await logoutAdmin(d, admin(req).sessionId);
      res.status(204).end();
    }),
  );
  r.get('/platform/auth/me', auth, (req, res) => {
    res.json({ id: admin(req).id, username: admin(req).username, fullName: admin(req).fullName });
  });

  r.get(
    '/platform/tenants',
    auth,
    asyncHandler(async (_req, res) => {
      res.json({ items: await listTenants(d) });
    }),
  );
  r.get(
    '/platform/errors',
    auth,
    asyncHandler(async (req, res) => {
      const q = z
        .object({
          tenantId: z.string().uuid().optional(),
          hours: z.coerce.number().int().min(1).max(720).default(24),
        })
        .parse(req.query);
      res.json({
        items: await recentErrors(d.control, {
          hours: q.hours,
          ...(q.tenantId ? { tenantId: q.tenantId } : {}),
        }),
      });
    }),
  );
  r.post(
    '/platform/tenants',
    auth,
    asyncHandler(async (req, res) => {
      const b = z
        .object({
          name: text(120),
          slug: text(40),
          ownerName: text(120),
          ownerUsername: z
            .string()
            .trim()
            .regex(/^[a-z0-9._-]{3,40}$/, 'letters, digits . _ - (3 to 40)')
            .optional(),
          contactPhone: phone.optional(),
          notes: z.string().trim().max(500).optional(),
          plan: text(30).optional(),
        })
        .strict()
        .parse(req.body);
      res.status(201).json(await createTenant(d, admin(req), b, req.ip));
    }),
  );
  r.get(
    '/platform/tenants/:id',
    auth,
    asyncHandler(async (req, res) => {
      res.json(await getTenant(d, id.parse(req.params).id));
    }),
  );
  r.patch(
    '/platform/tenants/:id',
    auth,
    asyncHandler(async (req, res) => {
      const b = z
        .object({
          name: text(120).optional(),
          plan: text(30).optional(),
          notes: z.string().trim().max(500).nullable().optional(),
          contactPhone: phone.nullable().optional(),
        })
        .strict()
        .refine((v) => Object.keys(v).length > 0, 'Nothing to change')
        .parse(req.body);
      res.json(await updateTenant(d, admin(req), id.parse(req.params).id, b, req.ip));
    }),
  );
  r.post(
    '/platform/tenants/:id/suspend',
    auth,
    asyncHandler(async (req, res) => {
      const b = z
        .object({ reason: z.string().trim().min(3).max(300) })
        .strict()
        .parse(req.body);
      res.json(await suspendTenant(d, admin(req), id.parse(req.params).id, b.reason, req.ip));
    }),
  );
  r.post(
    '/platform/tenants/:id/activate',
    auth,
    asyncHandler(async (req, res) => {
      res.json(await activateTenant(d, admin(req), id.parse(req.params).id, req.ip));
    }),
  );
  r.post(
    '/platform/tenants/:id/archive',
    auth,
    asyncHandler(async (req, res) => {
      res.json(await archiveTenant(d, admin(req), id.parse(req.params).id, req.ip));
    }),
  );
  r.post(
    '/platform/tenants/:id/retry',
    auth,
    asyncHandler(async (req, res) => {
      res.json(await retryProvisioning(d, admin(req), id.parse(req.params).id, req.ip));
    }),
  );
  r.post(
    '/platform/tenants/:id/reset-owner',
    auth,
    asyncHandler(async (req, res) => {
      res.json(await resetOwner(d, admin(req), id.parse(req.params).id, req.ip));
    }),
  );
  r.post(
    '/platform/tenants/:id/migrate',
    auth,
    asyncHandler(async (req, res) => {
      res.json(await migrateTenant(d, admin(req), id.parse(req.params).id));
    }),
  );
  r.get(
    '/platform/tenants/:id/health',
    auth,
    asyncHandler(async (req, res) => {
      res.json(await tenantHealth(d, id.parse(req.params).id));
    }),
  );
  r.get(
    '/platform/audit',
    auth,
    asyncHandler(async (req, res) => {
      const q = z
        .object({
          tenantId: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        })
        .parse(req.query);
      res.json({ items: await auditTrail(d, q) });
    }),
  );
  return r;
}
