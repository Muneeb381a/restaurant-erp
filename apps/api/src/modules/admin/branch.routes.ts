import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/async-handler';
import type { AppContext } from '../../http/context';
import { AppError } from '../../http/errors';
import { withTx } from '../../shared/tx';
import { writeAudit } from '../audit/audit.service';
import { authenticate, requirePermission, resolveBranch } from '../auth/middleware';

const branchPatch = z
  .object({
    name: z.string().trim().min(1).max(200),
    address: z.string().trim().max(500).nullable(),
    phone: z.string().trim().max(50).nullable(),
    timezone: z.string().trim().min(1).max(60),
    ntn: z.string().trim().max(40).nullable(),
    strn: z.string().trim().max(40).nullable(),
    tax_authority: z.enum(['PRA', 'SRB', 'KPRA', 'BRA', 'FBR', 'NONE']),
  })
  .partial()
  .strict();

/** Fields that decide tax behaviour: changing them needs tax.manage, not just settings.manage. */
const TAX_FIELDS = ['ntn', 'strn', 'tax_authority'] as const;

/** Known settings and their value shapes. Unknown keys are rejected so typos can't silently no-op. */
export const SETTING_SCHEMAS: Record<string, z.ZodType> = {
  'tax.service_charge_taxable': z.boolean(),
  'tax.mixed_tender_policy': z.enum(['HIGHEST_RATE_IF_ANY_NON_DIGITAL', 'PROPORTIONAL']),
  'billing.round_to_rupee': z.boolean(),
  'billing.service_charge_bps': z.number().int().min(0).max(10_000),
  'kot.print_on_send': z.boolean(),
};

export function branchRouter(ctx: AppContext): Router {
  const r = Router();
  const read = [authenticate(ctx), resolveBranch(ctx)];
  const settingsPerm = requirePermission(ctx, 'settings.manage');

  r.get(
    '/branch',
    ...read,
    asyncHandler(async (req, res) => {
      const row = await ctx.db
        .selectFrom('branches')
        .selectAll()
        .where('id', '=', req.branchId!)
        .executeTakeFirstOrThrow();
      res.json(row);
    }),
  );

  r.patch(
    '/branch',
    ...read,
    settingsPerm,
    asyncHandler(async (req, res) => {
      const body = branchPatch.parse(req.body);
      if (Object.keys(body).length === 0)
        throw new AppError(400, 'VALIDATION_FAILED', 'No fields to update');
      if (TAX_FIELDS.some((f) => f in body)) {
        const perms = await ctx.permissions.get(req.principal!.roleId);
        if (!perms.has('tax.manage')) {
          throw new AppError(403, 'PERMISSION_DENIED', 'Changing tax identity needs tax.manage', {
            permission: 'tax.manage',
          });
        }
      }
      const after = await withTx(ctx.db, async (trx) => {
        const before = await trx
          .selectFrom('branches')
          .selectAll()
          .where('id', '=', req.branchId!)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const updated = await trx
          .updateTable('branches')
          .set(body)
          .where('id', '=', req.branchId!)
          .returningAll()
          .executeTakeFirstOrThrow();
        await writeAudit(trx, {
          branchId: req.branchId,
          userId: req.principal!.userId,
          deviceId: req.principal!.deviceId,
          action: 'BRANCH_UPDATE',
          entity: 'branch',
          entityId: req.branchId,
          before,
          after: updated,
          ip: req.ip,
        });
        return updated;
      });
      res.json(after);
    }),
  );

  r.get(
    '/settings',
    ...read,
    asyncHandler(async (req, res) => {
      const rows = await ctx.db
        .selectFrom('settings')
        .select(['key', 'value'])
        .where('branch_id', '=', req.branchId!)
        .orderBy('key')
        .execute();
      res.json(Object.fromEntries(rows.map((s) => [s.key, s.value])));
    }),
  );

  r.put(
    '/settings/:key',
    ...read,
    asyncHandler(async (req, res) => {
      const key = z.string().parse(req.params.key);
      const schema = SETTING_SCHEMAS[key];
      if (!schema) throw new AppError(400, 'VALIDATION_FAILED', `Unknown setting: ${key}`);
      const needed = key.startsWith('tax.') ? 'tax.manage' : 'settings.manage';
      const perms = await ctx.permissions.get(req.principal!.roleId);
      if (!perms.has(needed))
        throw new AppError(403, 'PERMISSION_DENIED', 'You do not have permission for this action', {
          permission: needed,
        });

      const value = schema.parse(z.object({ value: z.unknown() }).parse(req.body).value);
      await withTx(ctx.db, async (trx) => {
        const prev = await trx
          .selectFrom('settings')
          .select('value')
          .where('branch_id', '=', req.branchId!)
          .where('key', '=', key)
          .forUpdate()
          .executeTakeFirst();
        await trx
          .insertInto('settings')
          .values({ branch_id: req.branchId!, key, value: JSON.stringify(value) })
          .onConflict((oc) =>
            oc
              .columns(['branch_id', 'key'])
              .doUpdateSet({ value: JSON.stringify(value), updated_at: ctx.clock.now() }),
          )
          .execute();
        await writeAudit(trx, {
          branchId: req.branchId,
          userId: req.principal!.userId,
          deviceId: req.principal!.deviceId,
          action: 'SETTING_SET',
          entity: 'setting',
          before: prev ? { key, value: prev.value } : null,
          after: { key, value },
          ip: req.ip,
        });
      });
      res.json({ key, value });
    }),
  );

  return r;
}
