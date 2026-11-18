import { Router } from 'express';
import { sql } from 'kysely';
import { asyncHandler } from '../../http/async-handler';
import type { AppContext } from '../../http/context';
import { authenticate, requirePermission, resolveBranch } from '../auth/middleware';

export interface SetupStep {
  key:
    'restaurant' | 'tables' | 'menu' | 'printers' | 'staff' | 'payments' | 'qrMenu' | 'tax' | 'day';
  done: boolean;
  /** A count to show ("12 items"), when that makes sense. */
  count?: number;
  /** Not needed to start selling: shown as a suggestion. */
  optional?: boolean;
}

/**
 * "Is this restaurant ready to sell?" in one read: what the owner has set up and what is still missing.
 * It only counts rows; it changes nothing and the till never depends on it.
 */
export function setupRouter(ctx: AppContext): Router {
  const r = Router();
  r.get(
    '/setup/status',
    authenticate(ctx),
    resolveBranch(ctx),
    requirePermission(ctx, 'settings.manage'),
    asyncHandler(async (req, res) => {
      const b = req.branchId!;
      const one = async <T>(q: ReturnType<typeof sql<T>>): Promise<T> =>
        (await q.execute(ctx.db)).rows[0] as T;
      const [branch, c, setting, day] = await Promise.all([
        ctx.db
          .selectFrom('branches')
          .select(['name', 'address', 'phone'])
          .where('id', '=', b)
          .executeTakeFirstOrThrow(),
        one<{
          tables: number;
          items: number;
          priced: number;
          printers: number;
          staff: number;
          methods: number;
          taxRules: number;
        }>(sql`SELECT
            (SELECT count(*) FROM dining_tables WHERE branch_id = ${b} AND is_active)::int AS tables,
            (SELECT count(*) FROM items WHERE branch_id = ${b} AND is_active)::int AS items,
            (SELECT count(DISTINCT v.item_id) FROM item_prices p
               JOIN item_variants v ON v.id = p.variant_id JOIN items i ON i.id = v.item_id
              WHERE i.branch_id = ${b} AND i.is_active)::int AS priced,
            (SELECT count(*) FROM printers WHERE branch_id = ${b} AND is_active)::int AS printers,
            (SELECT count(*) FROM users WHERE (branch_id = ${b} OR branch_id IS NULL) AND is_active)::int AS staff,
            (SELECT count(*) FROM payment_methods WHERE branch_id = ${b} AND is_active)::int AS methods,
            (SELECT count(*) FROM tax_rules WHERE verified_by IS NOT NULL)::int AS "taxRules"`),
        ctx.db
          .selectFrom('settings')
          .select(['key', 'value'])
          .where('branch_id', '=', b)
          .where('key', 'in', ['menu.public_enabled', 'tax.enabled'])
          .execute(),
        ctx.db
          .selectFrom('business_days')
          .select('id')
          .where('branch_id', '=', b)
          .where('status', '=', 'OPEN')
          .executeTakeFirst(),
      ]);
      const flag = (k: string): boolean => setting.find((s) => s.key === k)?.value === true;
      const steps: SetupStep[] = [
        { key: 'restaurant', done: !!(branch.address && branch.phone) },
        { key: 'tables', done: c.tables > 0, count: c.tables },
        { key: 'menu', done: c.priced > 0, count: c.priced },
        { key: 'printers', done: c.printers > 0, count: c.printers, optional: true },
        { key: 'staff', done: c.staff > 1, count: c.staff },
        { key: 'payments', done: c.methods > 0, count: c.methods },
        { key: 'day', done: !!day },
        { key: 'qrMenu', done: flag('menu.public_enabled'), optional: true },
        { key: 'tax', done: flag('tax.enabled') || c.taxRules > 0, optional: true },
      ];
      const required = steps.filter((s) => !s.optional);
      res.json({
        restaurant: branch.name,
        steps,
        requiredDone: required.filter((s) => s.done).length,
        requiredTotal: required.length,
        ready: required.every((s) => s.done),
      });
    }),
  );
  return r;
}
