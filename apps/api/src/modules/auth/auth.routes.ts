import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/async-handler';
import type { AppContext } from '../../http/context';
import { authenticate } from './middleware';
import { login, logout, refresh, type TokenPair } from './auth.service';
import { pinSchema } from './password';

const username = z.string().trim().min(1).max(100);
const deviceHeader = 'x-device-token';

const passwordBody = z.object({ username, password: z.string().min(1).max(200) });
const pinBody = z.object({ username, pin: pinSchema });
const refreshBody = z.object({ refreshToken: z.string().min(1).max(300) });

const present = (t: TokenPair) => ({
  accessToken: t.accessToken,
  accessExpiresAt: t.accessExpiresAt.toISOString(),
  refreshToken: t.refreshToken,
  refreshExpiresAt: t.refreshExpiresAt.toISOString(),
});

export function authRouter(ctx: AppContext): Router {
  const r = Router();

  r.post(
    '/login',
    asyncHandler(async (req, res) => {
      const b = passwordBody.parse(req.body);
      const tokens = await login(ctx, {
        username: b.username,
        secret: b.password,
        kind: 'password',
        deviceToken: req.header(deviceHeader),
        ip: req.ip,
      });
      res.json(present(tokens));
    }),
  );

  // PIN lookup needs the username: PINs are argon2id-hashed (not searchable) and not unique.
  r.post(
    '/login-pin',
    asyncHandler(async (req, res) => {
      const b = pinBody.parse(req.body);
      const tokens = await login(ctx, {
        username: b.username,
        secret: b.pin,
        kind: 'pin',
        deviceToken: req.header(deviceHeader),
        ip: req.ip,
      });
      res.json(present(tokens));
    }),
  );

  r.post(
    '/refresh',
    asyncHandler(async (req, res) => {
      const b = refreshBody.parse(req.body);
      res.json(present(await refresh(ctx, b.refreshToken, req.ip)));
    }),
  );

  r.post(
    '/logout',
    authenticate(ctx),
    asyncHandler(async (req, res) => {
      await logout(ctx, req.principal!, req.ip);
      res.status(204).end();
    }),
  );

  r.get(
    '/me',
    authenticate(ctx),
    asyncHandler(async (req, res) => {
      const p = req.principal!;
      const perms = [...(await ctx.permissions.get(p.roleId))].sort();
      res.json({
        id: p.userId,
        username: p.username,
        fullName: p.fullName,
        role: p.roleCode,
        branchId: p.userBranchId,
        discountLimitBps: p.discountLimitBps,
        permissions: perms,
      });
    }),
  );

  return r;
}
