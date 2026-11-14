/**
 * DEV ONLY. Plays back 21 trading days through the real API (with a controllable clock) so the owner
 * dashboard has history to show: sales across hours and channels, mixed payment methods, discounts,
 * khata credit, expenses, recipes with food cost and a cash count with small differences.
 *
 * Needs a fresh dev database that already has the sample menu and tables:
 *   pnpm db:reset && pnpm dev   (API running)   then   pnpm demo:data && pnpm demo:history
 * It stops before today, so today starts empty like a real morning.
 */
import { pino } from 'pino';
import request from 'supertest';
import { loadEnv } from '../src/config/env';
import { createApp } from '../src/http/app';
import type { AppContext } from '../src/http/context';
import { createHasher } from '../src/modules/auth/password';
import { PermissionCache } from '../src/modules/auth/permissions-cache';
import { MenuCache } from '../src/modules/menu/menu-cache';
import { shiftReport } from '../src/modules/reports/cash-report';
import { createDb, createPool } from '../src/shared/db';

if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run in production');

const DAYS = 21;
const PASSWORD = 'Dev#Passw0rd';
// local (Pakistan, UTC+5) time -> UTC for the clock
const at = (date: string, hour: number, minute = 0): Date =>
  new Date(Date.parse(`${date}T00:00:00Z`) + (hour * 60 + minute) * 60_000 - 5 * 3_600_000);

class Clock {
  t = new Date();
  now(): Date {
    return new Date(this.t);
  }
}

// small deterministic random generator so every run tells the same story
let seed = 20260101;
const rnd = (): number => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const between = (a: number, b: number): number => a + Math.floor(rnd() * (b - a + 1));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const db = createDb(createPool(env.DATABASE_URL));
  const clock = new Clock();
  const ctx: AppContext = {
    db,
    logger: pino({ level: 'silent' }),
    clock,
    hasher: createHasher(),
    permissions: new PermissionCache(db, clock),
    menu: new MenuCache(),
    auth: {
      jwtSecret: env.JWT_SECRET,
      accessTtlSeconds: 7 * 86_400,
      refreshTtlSeconds: 7 * 86_400,
    },
  };
  const app = createApp(ctx);
  const branch = await db
    .selectFrom('branches')
    .select('id')
    .where('code', '=', 'MAIN')
    .executeTakeFirstOrThrow();

  const tokens: Record<string, string> = {};
  const login = async (u: string): Promise<void> => {
    const r = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: u, password: PASSWORD });
    if (r.status !== 200) throw new Error(`login ${u}: ${r.status} ${JSON.stringify(r.body)}`);
    tokens[u] = r.body.accessToken;
  };
  const call = (
    u: string,
    method: 'get' | 'post' | 'put',
    url: string,
    body?: object,
    key?: string,
  ) => {
    const base = request(app)[method](`/api/v1${url}`);
    let rq = base.set('Authorization', `Bearer ${tokens[u]}`).set('x-branch-id', branch.id);
    if (key) rq = rq.set('Idempotency-Key', key);
    return body ? rq.send(body) : rq;
  };
  const ok = async (p: request.Test, what: string): Promise<Json> => {
    const r = await p;
    if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };

  const end = new Date();
  const lastDay = new Date(Date.UTC(end.getFullYear(), end.getMonth(), end.getDate() - 1));
  const dates = Array.from({ length: DAYS }, (_, i) =>
    new Date(lastDay.getTime() - (DAYS - 1 - i) * 86_400_000).toISOString().slice(0, 10),
  );

  clock.t = at(dates[0]!, 8);
  for (const u of ['owner', 'manager', 'cashier', 'captain', 'store']) await login(u);

  // the sample menu was imported today; make its prices valid from the first day being replayed
  await db.updateTable('item_prices').set({ effective_from: dates[0]! }).execute();
  const menu = await ok(call('cashier', 'get', '/menu?priceList=DINE_IN'), 'menu');
  const floor = await ok(call('cashier', 'get', '/floor'), 'floor');
  const methods = await ok(call('cashier', 'get', '/payment-methods'), 'methods');
  const method = (code: string): string =>
    (methods.items ?? methods).find((m: Json) => m.code === code)?.id;
  const items: Json[] = menu.items.filter(
    (i: Json) => i.kind === 'STANDARD' && i.available && i.modifierGroups.length === 0 && !i.deal,
  );
  const catName = (id: string | null): string =>
    menu.categories.find((c: Json) => c.id === id)?.name ?? '';
  const tables: Json[] = floor.tables;

  // ── ingredients and recipes: this is what makes "cost of food" and profit meaningful
  const ing: Record<string, { id: string; costPerBase: number }> = {};
  const mkIng = async (
    name: string,
    key: string,
    uom: 'g' | 'ml',
    perKgPaisa: number,
  ): Promise<void> => {
    const r = await ok(
      call('store', 'post', '/inventory/ingredients', {
        name,
        baseUom: uom,
        purchaseUom: uom === 'g' ? 'kg' : 'litre',
        purchaseToBase: 1000,
        reorderLevel: 20000,
        openingQty: 400,
        openingCostPaisaPerPurchase: perKgPaisa,
      }),
      `ingredient ${name}`,
    );
    ing[key] = { id: r.id, costPerBase: perKgPaisa / 1000 };
  };
  await mkIng('Chicken', 'chicken', 'g', 70_000);
  await mkIng('Mutton', 'mutton', 'g', 220_000);
  await mkIng('Beef', 'beef', 'g', 90_000);
  await mkIng('Flour', 'flour', 'g', 12_000);
  await mkIng('Rice', 'rice', 'g', 32_000);
  await mkIng('Cooking oil', 'oil', 'ml', 45_000);
  await mkIng('Spice mix', 'spice', 'g', 120_000);
  await mkIng('Yoghurt', 'yoghurt', 'g', 25_000);

  const mainFor = (name: string, cat: string): string => {
    const n = name.toLowerCase();
    if (/mutton|chops|paye|nihari|haleem/.test(n))
      return /beef|nihari|haleem/.test(n) ? 'beef' : 'mutton';
    if (/beef|seekh|chapli/.test(n)) return 'beef';
    if (/biryani|pulao|rice/.test(n)) return 'rice';
    if (/naan|roti|paratha|bread/.test(n + cat.toLowerCase())) return 'flour';
    if (/raita|lassi|salad/.test(n)) return 'yoghurt';
    return 'chicken';
  };
  let recipes = 0;
  for (const it of items) {
    for (const v of it.variants) {
      const price = v.pricePaisa as number;
      const target = Math.round(price * (0.26 + rnd() * 0.14)); // 26-40 % food cost, so some dishes are better than others
      const main = ing[mainFor(it.name, catName(it.categoryId))]!;
      const lines = [
        { ingredientId: main.id, qty: Math.max(1, Math.round((target * 0.75) / main.costPerBase)) },
      ];
      const sp = ing[pick(['spice', 'oil'])]!;
      lines.push({
        ingredientId: sp.id,
        qty: Math.max(1, Math.round((target * 0.25) / sp.costPerBase)),
      });
      const r = await call('store', 'put', `/variants/${v.id}/recipe`, { lines });
      if (r.status >= 300)
        throw new Error(`recipe ${it.name}: ${r.status} ${JSON.stringify(r.body)}`);
      recipes++;
    }
  }
  console.log(`ingredients ${Object.keys(ing).length}, recipes ${recipes}`);

  // khata customers
  const khata: string[] = [];
  for (const [name, limit] of [
    ['Haji Rashid', 5_000_000],
    ['Malik Traders', 8_000_000],
    ['Dr Farooq', 3_000_000],
  ] as const) {
    const a = await ok(
      call('manager', 'post', '/khata/accounts', {
        name,
        phone: `0300-11122${khata.length}${khata.length}`,
        creditLimitPaisa: limit,
      }),
      'khata',
    );
    khata.push(a.id);
  }

  let keySeq = 0;
  const key = (): string => `hist-${Date.now()}-${++keySeq}`;
  let orders = 0;

  for (const [di, date] of dates.entries()) {
    clock.t = at(date, 9, 30);
    for (const u of ['manager', 'cashier', 'captain', 'owner']) await login(u);
    await ok(call('manager', 'post', '/business-days/open', {}), `open ${date}`);
    const shift = await ok(
      call('cashier', 'post', '/shifts/open', { openingFloatPaisa: 500_000 }),
      'shift',
    );

    const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 Sun .. 6 Sat
    const weekend = dow === 5 || dow === 6 || dow === 0;
    const trend = 1 + di * 0.012; // slow growth over the three weeks
    const count = Math.round((weekend ? between(24, 34) : between(13, 22)) * trend);

    // dinner is the busiest, with a lunch peak
    const hourPool = [12, 13, 13, 14, 19, 19, 20, 20, 20, 21, 21, 22, 15, 18];
    const slots = Array.from({ length: count }, () => ({
      h: pick(hourPool),
      m: between(0, 59),
    })).sort((a, b) => a.h * 60 + a.m - (b.h * 60 + b.m));

    for (const s of slots) {
      clock.t = at(date, s.h, s.m);
      const roll = rnd();
      const type = roll < 0.62 ? 'DINE_IN' : roll < 0.86 ? 'TAKEAWAY' : 'DELIVERY';
      const body: Json = { type };
      if (type === 'DINE_IN') body.tableId = pick(tables).id;
      const o = await ok(call('captain', 'post', '/orders', body), 'order');
      const lines = between(1, 4);
      for (let k = 0; k < lines; k++) {
        const it = pick(items);
        const v = it.variants[0];
        const r = await call('captain', 'post', `/orders/${o.id}/items`, {
          itemId: it.id,
          variantId: v.id,
          qty: between(1, 3),
        });
        if (r.status >= 300) continue;
      }
      await ok(call('captain', 'post', `/orders/${o.id}/send`, {}), 'send');
      // the kitchen works the tickets: wait, cook, ready, served (slower at the lunch and dinner rush)
      const rush = (s.h >= 13 && s.h <= 15) || (s.h >= 20 && s.h <= 22);
      const tickets = await db
        .selectFrom('kots')
        .select('id')
        .where('order_id', '=', o.id)
        .execute();
      for (const k of tickets) {
        const step = async (to: string, lo: number, hi: number): Promise<void> => {
          clock.t = new Date(clock.t.getTime() + between(lo, hi) * 60_000);
          await ok(call('manager', 'post', `/kots/${k.id}/status`, { status: to }), 'kot');
        };
        await step('PREPARING', 1, rush ? 9 : 4);
        await step('READY', rush ? 9 : 6, rush ? 24 : 16);
        await step('DONE', 1, 3);
      }
      let bill = await ok(call('cashier', 'post', `/orders/${o.id}/bill`), 'bill');
      if (rnd() < 0.12) {
        const d = await call('manager', 'post', `/bills/${bill.id}/discount`, {
          percentBps: pick([500, 1000, 1500]),
          reason: pick(['Regular guest', 'Birthday', 'Staff friend']),
        });
        if (d.status < 300) bill = d.body;
      }
      const total: number = bill.totalPaisa;
      const r2 = rnd();
      let tenders: Json[];
      if (r2 < 0.55)
        tenders = [
          {
            methodId: method('CASH'),
            amountPaisa: total,
            tenderedPaisa: Math.ceil(total / 50_000) * 50_000,
          },
        ];
      else if (r2 < 0.72)
        tenders = [
          {
            methodId: method('CARD'),
            amountPaisa: total,
            reference: `RRN${between(100000, 999999)}`,
          },
        ];
      else if (r2 < 0.84)
        tenders = [
          {
            methodId: method('EASYPAISA'),
            amountPaisa: total,
            reference: `TX${between(100000, 999999)}`,
          },
        ];
      else if (r2 < 0.92)
        tenders = [
          {
            methodId: method('JAZZCASH'),
            amountPaisa: total,
            reference: `JC${between(100000, 999999)}`,
          },
        ];
      else if (r2 < 0.96 && total < 400_000)
        tenders = [{ methodId: method('KHATA'), amountPaisa: total, khataAccountId: pick(khata) }];
      else {
        const part = Math.round(total / 2 / 100) * 100;
        tenders = [
          { methodId: method('CASH'), amountPaisa: part, tenderedPaisa: part },
          {
            methodId: method('CARD'),
            amountPaisa: total - part,
            reference: `RRN${between(100000, 999999)}`,
          },
        ];
      }
      const s2 = await call('cashier', 'post', `/bills/${bill.id}/settle`, { tenders }, key());
      if (s2.status >= 300)
        throw new Error(`settle ${date}: ${s2.status} ${JSON.stringify(s2.body)}`);
      orders++;
    }

    // running costs: gas every day, vegetables most days; the month's rent and salaries once at the start
    clock.t = at(date, 16, 0);
    await ok(
      call(
        'owner',
        'post',
        '/expenses',
        { category: 'GAS', amountPaisa: between(15, 32) * 10_000, paidFrom: 'OWNER_CASH' },
        key(),
      ),
      'gas',
    );
    if (rnd() < 0.8)
      await ok(
        call(
          'owner',
          'post',
          '/expenses',
          {
            category: 'VEGETABLES',
            amountPaisa: between(40, 120) * 10_000,
            paidFrom: 'OWNER_CASH',
          },
          key(),
        ),
        'veg',
      );
    if (di === 0) {
      await ok(
        call(
          'owner',
          'post',
          '/expenses',
          { category: 'RENT', amountPaisa: 8_500_000, paidFrom: 'BANK' },
          key(),
        ),
        'rent',
      );
      await ok(
        call(
          'owner',
          'post',
          '/expenses',
          { category: 'SALARIES', amountPaisa: 24_000_000, paidFrom: 'BANK' },
          key(),
        ),
        'salaries',
      );
    }
    if (di === 10)
      await ok(
        call(
          'owner',
          'post',
          '/expenses',
          { category: 'ELECTRICITY', amountPaisa: 4_200_000, paidFrom: 'BANK' },
          key(),
        ),
        'power',
      );

    // a little wastage and a staff meal now and then
    if (rnd() < 0.4)
      await call(
        'store',
        'post',
        '/inventory/wastage',
        {
          ingredientId: ing.chicken!.id,
          qty: between(300, 1200),
          kind: 'WASTAGE',
          reasonCode: 'SPOILED',
        },
        key(),
      );
    if (rnd() < 0.5)
      await call(
        'store',
        'post',
        '/inventory/wastage',
        { ingredientId: ing.flour!.id, qty: between(1000, 2500), kind: 'STAFF_MEAL' },
        key(),
      );

    // close the till: the count is usually right, sometimes a little off
    clock.t = at(date, 23, 20);
    const rep = await shiftReport(db, branch.id, shift.id);
    const off = rnd() < 0.2 ? pick([-500, -200, 300, 1000]) : 0;
    await ok(
      call('cashier', 'post', `/shifts/${shift.id}/close`, {
        countedCashPaisa: rep.expectedCashPaisa + off,
        ...(off ? { notes: 'Counted twice' } : {}),
      }),
      'close shift',
    );
    await ok(call('manager', 'post', '/business-days/close', {}), `close ${date}`);
    process.stdout.write(`${date} ${count} orders\n`);
  }
  console.log(
    `done: ${orders} bills over ${DAYS} days. Today is empty: open the day and shift to continue.`,
  );
  await db.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
