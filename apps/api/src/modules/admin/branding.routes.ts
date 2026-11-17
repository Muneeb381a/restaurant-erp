import { sniffImage } from '@erp/domain';
import express, { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/async-handler';
import type { AppContext } from '../../http/context';
import { AppError } from '../../http/errors';
import { withTx } from '../../shared/tx';
import { writeAudit } from '../audit/audit.service';
import { authenticate, requirePermission, resolveBranch } from '../auth/middleware';
import { idParam } from './crud';

/**
 * The restaurant's logo (printed on every bill, shown in the top bar) and each person's photo.
 * Pictures live in the database (no file server, no internet). The browser prepares them; the server
 * stores them and checks the numbers add up. It never decodes an image.
 */

const raster = z
  .object({
    height: z.number().int().min(1).max(600),
    /** Packed 1-bit rows, base64. */
    data: z.string().min(4).max(120_000),
  })
  .strict();
const logoBody = z
  .object({
    /** The picture to show on screen (PNG/JPEG/WebP), base64 without a data: prefix. */
    image: z.string().min(20).max(450_000),
    /** Black-and-white versions for 58 mm (384 dots) and 80 mm (576 dots) paper. */
    raster58: raster,
    raster80: raster,
  })
  .strict();

const fromBase64 = (s: string, what: string): Buffer => {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s))
    throw new AppError(400, 'VALIDATION_FAILED', `${what} is not valid base64`);
  return Buffer.from(s, 'base64');
};

export function logoRouter(ctx: AppContext): Router {
  const r = Router();
  const read = [authenticate(ctx), resolveBranch(ctx)];
  const manage = [...read, requirePermission(ctx, 'settings.manage')];

  r.get(
    '/branch/logo',
    ...read,
    asyncHandler(async (req, res) => {
      const row = await ctx.db
        .selectFrom('branch_logo')
        .select(['content_type', 'display'])
        .where('branch_id', '=', req.branchId!)
        .executeTakeFirst();
      if (!row) throw new AppError(404, 'NOT_FOUND', 'No logo');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-cache');
      res.type(row.content_type).send(row.display);
    }),
  );

  r.put(
    '/branch/logo',
    ...manage,
    asyncHandler(async (req, res) => {
      const b = logoBody.parse(req.body);
      const display = fromBase64(b.image, 'The picture');
      const type = sniffImage(display);
      if (!type)
        throw new AppError(400, 'VALIDATION_FAILED', 'The logo must be a JPEG, PNG or WebP image');
      if (display.length > 300_000)
        throw new AppError(400, 'VALIDATION_FAILED', 'The logo picture is too large');
      const r58 = fromBase64(b.raster58.data, 'The 58 mm print version');
      const r80 = fromBase64(b.raster80.data, 'The 80 mm print version');
      if (r58.length !== 48 * b.raster58.height || r80.length !== 72 * b.raster80.height)
        throw new AppError(
          400,
          'VALIDATION_FAILED',
          'The print versions do not match their size (58 mm = 384 dots wide, 80 mm = 576)',
        );
      const p = req.principal!;
      await withTx(ctx.db, async (trx) => {
        const values = {
          content_type: type,
          display,
          raster_58: r58,
          raster_58_height: b.raster58.height,
          raster_80: r80,
          raster_80_height: b.raster80.height,
        };
        await trx
          .insertInto('branch_logo')
          .values({ branch_id: req.branchId!, ...values })
          .onConflict((oc) =>
            oc.column('branch_id').doUpdateSet({ ...values, updated_at: new Date() }),
          )
          .execute();
        await writeAudit(trx, {
          branchId: req.branchId,
          userId: p.userId,
          deviceId: p.deviceId,
          action: 'BRANCH_LOGO_SET',
          entity: 'branch',
          entityId: req.branchId!,
          after: { contentType: type, bytes: display.length },
          ip: req.ip,
        });
      });
      res.json({ hasLogo: true });
    }),
  );

  r.delete(
    '/branch/logo',
    ...manage,
    asyncHandler(async (req, res) => {
      const p = req.principal!;
      await withTx(ctx.db, async (trx) => {
        const gone = await trx
          .deleteFrom('branch_logo')
          .where('branch_id', '=', req.branchId!)
          .executeTakeFirst();
        if (gone.numDeletedRows === 0n) return;
        await writeAudit(trx, {
          branchId: req.branchId,
          userId: p.userId,
          deviceId: p.deviceId,
          action: 'BRANCH_LOGO_CLEAR',
          entity: 'branch',
          entityId: req.branchId!,
          ip: req.ip,
        });
      });
      res.json({ hasLogo: false });
    }),
  );

  return r;
}

/** `/users/me/avatar` (own photo) and `/users/:id/avatar` (to show anyone in the same branch). */
export function avatarRouter(ctx: AppContext): Router {
  const r = Router();
  const read = [authenticate(ctx), resolveBranch(ctx)];

  r.get(
    '/:id/avatar',
    ...read,
    asyncHandler(async (req, res) => {
      const { id } = idParam.parse(req.params);
      const row = await ctx.db
        .selectFrom('user_avatars')
        .innerJoin('users', 'users.id', 'user_avatars.user_id')
        .select(['user_avatars.content_type as contentType', 'user_avatars.data as data'])
        .where('user_avatars.user_id', '=', id)
        // someone from another branch is not visible
        .where((eb) =>
          eb.or([eb('users.branch_id', '=', req.branchId!), eb('users.branch_id', 'is', null)]),
        )
        .executeTakeFirst();
      if (!row) throw new AppError(404, 'NOT_FOUND', 'No photo');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-cache');
      res.type(row.contentType).send(row.data);
    }),
  );

  r.put(
    '/me/avatar',
    ...read,
    express.raw({ type: () => true, limit: '200kb' }),
    asyncHandler(async (req, res) => {
      const data: unknown = req.body;
      if (!Buffer.isBuffer(data) || data.length === 0)
        throw new AppError(400, 'VALIDATION_FAILED', 'Send the photo as the request body');
      const type = sniffImage(data);
      if (!type)
        throw new AppError(400, 'VALIDATION_FAILED', 'The photo must be a JPEG, PNG or WebP image');
      if (data.length > 150_000)
        throw new AppError(400, 'VALIDATION_FAILED', 'The photo is too large');
      const p = req.principal!;
      await withTx(ctx.db, async (trx) => {
        await trx
          .insertInto('user_avatars')
          .values({ user_id: p.userId, content_type: type, data })
          .onConflict((oc) =>
            oc.column('user_id').doUpdateSet({
              content_type: type,
              data,
              updated_at: new Date(),
            }),
          )
          .execute();
        await writeAudit(trx, {
          branchId: req.branchId,
          userId: p.userId,
          deviceId: p.deviceId,
          action: 'USER_AVATAR_SET',
          entity: 'user',
          entityId: p.userId,
          after: { contentType: type, bytes: data.length },
          ip: req.ip,
        });
      });
      res.json({ hasPhoto: true });
    }),
  );

  r.delete(
    '/me/avatar',
    ...read,
    asyncHandler(async (req, res) => {
      await ctx.db
        .deleteFrom('user_avatars')
        .where('user_id', '=', req.principal!.userId)
        .execute();
      res.json({ hasPhoto: false });
    }),
  );

  return r;
}
