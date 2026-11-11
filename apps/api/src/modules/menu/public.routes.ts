import { createHash } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/async-handler';
import type { AppContext } from '../../http/context';
import { AppError } from '../../http/errors';
import { getMenu } from './menu.readmodel';

/**
 * The customer-facing menu behind the QR code (GET /public/menu). It is the only unauthenticated
 * business endpoint, so it is deliberately narrow:
 *  - read-only, and off until the owner switches `menu.public_enabled` on;
 *  - returns names, prices of the DINE_IN list for today's business date, and whether a dish is
 *    sold out: never codes, stations, costs, search terms, modifiers or anything about orders;
 *  - cheap (the menu is cached per branch/date) and rate limited per client address.
 */

interface MenuPayload {
  priceList: string;
  date: string;
  categories: {
    id: string;
    parentId: string | null;
    name: string;
    nameUr: string | null;
    sort: number;
  }[];
  items: {
    id: string;
    name: string;
    nameUr: string | null;
    kind: string;
    categoryId: string | null;
    available: boolean;
    variants: { name: string; nameUr: string | null; isDefault: boolean; pricePaisa: number }[];
    deal: {
      slots: {
        name: string;
        qty: number;
        options: {
          itemName: string;
          itemNameUr: string | null;
          variantName: string;
          available: boolean;
        }[];
      }[];
    } | null;
  }[];
}

/** Small fixed-window limiter so a scraper or a stuck page cannot hammer the till's database. */
function rateLimit(limit: number, windowMs: number, now: () => number): RequestHandler {
  const hits = new Map<string, { n: number; resetAt: number }>();
  return (req, _res, next) => {
    const t = now();
    // behind the reverse proxy every client has the proxy's address, so prefer the forwarded one
    const ip = req.header('x-forwarded-for')?.split(',')[0]?.trim() || req.ip || 'unknown';
    const h = hits.get(ip);
    if (!h || h.resetAt <= t) {
      hits.set(ip, { n: 1, resetAt: t + windowMs });
      if (hits.size > 5000) for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
      return next();
    }
    h.n += 1;
    if (h.n > limit)
      return next(new AppError(429, 'RATE_LIMITED', 'Too many requests, try again in a minute'));
    next();
  };
}

export function publicRouter(ctx: AppContext): Router {
  const r = Router();
  r.use(rateLimit(240, 60_000, () => ctx.clock.now().getTime()));

  r.get(
    '/menu',
    asyncHandler(async (req, res) => {
      const q = z.object({ branch: z.string().uuid().optional() }).parse(req.query);
      const branches = await ctx.db
        .selectFrom('branches')
        .select(['id', 'name', 'name_ur', 'address', 'phone'])
        .where('is_active', '=', true)
        .$if(!!q.branch, (qb) => qb.where('id', '=', q.branch!))
        .limit(2)
        .execute();
      if (branches.length === 0) throw new AppError(404, 'NOT_FOUND', 'Menu not found');
      if (branches.length > 1)
        throw new AppError(400, 'BRANCH_REQUIRED', 'Use the link printed from the admin screen');
      const branch = branches[0]!;

      const rows = await ctx.db
        .selectFrom('settings')
        .select(['key', 'value'])
        .where('branch_id', '=', branch.id)
        .where('key', 'in', [
          'menu.public_enabled',
          'menu.public_note',
          'billing.service_charge_bps',
        ])
        .execute();
      const s = Object.fromEntries(rows.map((x) => [x.key, x.value]));
      if (s['menu.public_enabled'] !== true)
        throw new AppError(404, 'MENU_NOT_PUBLIC', 'The menu is not published');

      const menu = JSON.parse((await getMenu(ctx, { branchId: branch.id })).body) as MenuPayload;
      const body = JSON.stringify({
        restaurant: {
          name: branch.name,
          nameUr: branch.name_ur,
          address: branch.address,
          phone: branch.phone,
        },
        date: menu.date,
        note: typeof s['menu.public_note'] === 'string' ? s['menu.public_note'] : null,
        serviceChargeBps:
          typeof s['billing.service_charge_bps'] === 'number' ? s['billing.service_charge_bps'] : 0,
        categories: menu.categories.map((c) => ({
          id: c.id,
          parentId: c.parentId,
          name: c.name,
          nameUr: c.nameUr,
          sort: c.sort,
        })),
        items: menu.items.map((i) => ({
          id: i.id,
          name: i.name,
          nameUr: i.nameUr,
          isDeal: i.kind === 'DEAL',
          categoryId: i.categoryId,
          available: i.available,
          variants: i.variants.map((v) => ({
            name: v.name,
            nameUr: v.nameUr,
            pricePaisa: v.pricePaisa,
          })),
          dealSlots: (i.deal?.slots ?? []).map((sl) => ({
            name: sl.name,
            qty: sl.qty,
            options: sl.options.map((o) => ({
              name: o.itemName,
              nameUr: o.itemNameUr,
              variant: o.variantName,
              available: o.available,
            })),
          })),
        })),
      });
      const etag = `W/"${createHash('sha1').update(body).digest('hex').slice(0, 20)}"`;
      res.setHeader('ETag', etag);
      // a phone that rescans within half a minute reuses what it has; a menu change shows up quickly
      res.setHeader('Cache-Control', 'public, max-age=30');
      if (req.header('if-none-match') === etag) {
        res.status(304).end();
        return;
      }
      res.type('application/json').send(body);
    }),
  );
  return r;
}
