import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/async-handler';
import type { AppContext } from '../../http/context';
import { AppError } from '../../http/errors';
import { withTx } from '../../shared/tx';
import { writeAudit } from '../audit/audit.service';
import { authenticate, requirePermission, resolveBranch } from '../auth/middleware';
import { hashSecret, randomSecret } from '../auth/tokens';
import { idParam } from './crud';

const createBody = z
  .object({
    name: z.string().trim().min(1).max(100),
    kind: z.enum(['COUNTER', 'CAPTAIN', 'KDS', 'ADMIN']),
  })
  .strict();
const patchBody = z
  .object({ name: z.string().trim().min(1).max(100), isActive: z.boolean() })
  .partial()
  .strict();

const SAFE = ['id', 'branch_id', 'name', 'kind', 'last_seen_at', 'is_active'] as const;

export function devicesRouter(ctx: AppContext): Router {
  const r = Router();
  const guard = [authenticate(ctx), resolveBranch(ctx), requirePermission(ctx, 'device.manage')];

  r.get(
    '/',
    ...guard,
    asyncHandler(async (req, res) => {
      res.json({
        items: await ctx.db
          .selectFrom('devices')
          .select([...SAFE])
          .where('branch_id', '=', req.branchId!)
          .orderBy('name')
          .execute(),
      });
    }),
  );

  /** The raw device token is returned exactly once; only its hash is stored. */
  r.post(
    '/',
    ...guard,
    asyncHandler(async (req, res) => {
      const b = createBody.parse(req.body);
      const token = randomSecret();
      const device = await withTx(ctx.db, async (trx) => {
        const row = await trx
          .insertInto('devices')
          .values({
            branch_id: req.branchId!,
            name: b.name,
            kind: b.kind,
            token_hash: hashSecret(token),
          })
          .returning([...SAFE])
          .executeTakeFirstOrThrow();
        await writeAudit(trx, {
          branchId: req.branchId,
          userId: req.principal!.userId,
          deviceId: req.principal!.deviceId,
          action: 'DEVICE_REGISTER',
          entity: 'device',
          entityId: row.id,
          after: row,
          ip: req.ip,
        });
        return row;
      });
      res.status(201).json({ ...device, token });
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
      const after = await withTx(ctx.db, async (trx) => {
        const before = await trx
          .selectFrom('devices')
          .select([...SAFE])
          .where('id', '=', id)
          .where('branch_id', '=', req.branchId!)
          .forUpdate()
          .executeTakeFirst();
        if (!before) throw new AppError(404, 'NOT_FOUND', 'device not found');
        const row = await trx
          .updateTable('devices')
          .set({
            ...(b.name !== undefined && { name: b.name }),
            ...(b.isActive !== undefined && { is_active: b.isActive }),
          })
          .where('id', '=', id)
          .returning([...SAFE])
          .executeTakeFirstOrThrow();
        if (b.isActive === false) {
          // Revoking a device also ends the sessions opened from it.
          await trx
            .updateTable('sessions')
            .set({ revoked_at: ctx.clock.now() })
            .where('device_id', '=', id)
            .where('revoked_at', 'is', null)
            .execute();
        }
        await writeAudit(trx, {
          branchId: req.branchId,
          userId: req.principal!.userId,
          deviceId: req.principal!.deviceId,
          action: b.isActive === false ? 'DEVICE_REVOKE' : 'DEVICE_UPDATE',
          entity: 'device',
          entityId: id,
          before,
          after: row,
          ip: req.ip,
        });
        return row;
      });
      res.json(after);
    }),
  );

  return r;
}
