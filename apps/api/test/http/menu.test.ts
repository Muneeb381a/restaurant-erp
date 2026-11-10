import {
  asPaisa,
  defaultDealPicks,
  validateDealSelection,
  validateModifierSelection,
  type DealSlotDef,
  type ModifierGroupDef,
} from '@erp/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from './app-harness';

let t: TestApp;
let owner: string;
let cashier: string;
let kitchen: string;
let captain: string;
let manager2: string;
const L: Record<string, string> = {}; // price list ids by code
const S: Record<string, string> = {}; // station ids by code

const o = () => t.as(owner);
const audit = (action: string, entityId?: string) => {
  let q = t.kdb.selectFrom('audit_log').selectAll().where('action', '=', action).orderBy('id');
  if (entityId) q = q.where('entity_id', '=', entityId);
  return q.execute();
};

/** Creates an item through the API and optionally prices its first variant. */
async function mkItem(
  body: Record<string, unknown>,
  prices: Record<string, number> = {},
): Promise<{ id: string; variantId: string; variants: { id: string; name: string }[] }> {
  const res = await o().post('/items', { kind: 'STANDARD', ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  for (const [list, paisa] of Object.entries(prices)) {
    const p = await o().put(`/variants/${res.body.variants[0].id}/prices/${L[list]}`, {
      pricePaisa: paisa,
    });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
  }
  return { id: res.body.id, variantId: res.body.variants[0].id, variants: res.body.variants };
}

const menu = async (query = '') => {
  const res = await o().get(`/menu${query}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res;
};
// The POS payload is asserted structurally in the tests; its shape is loose JSON here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const menuItem = (body: { items: Json[] }, id: string): Json => body.items.find((i) => i.id === id);

beforeAll(async () => {
  t = await startApp();
  owner = (await t.login('OWNER')).token;
  cashier = (await t.login('CASHIER')).token;
  kitchen = (await t.login('KITCHEN')).token;
  captain = (await t.login('CAPTAIN')).token;
  manager2 = (await t.login('MANAGER2')).token;
  for (const [code, name] of [
    ['DINE_IN', 'Dine-in'],
    ['TAKEAWAY', 'Takeaway'],
    ['DELIVERY', 'Delivery'],
  ] as const) {
    L[code] = (await o().post('/price-lists', { code, name })).body.id;
  }
  for (const code of ['BBQ', 'TANDOOR'])
    S[code] = (await o().post('/stations', { code, name: code })).body.id;
}, 180_000);
afterAll(async () => {
  await t.stop();
});

describe('categories', () => {
  it('creates a tree, rejects cycles and case-insensitive duplicates, audits, and hides inactive ones', async () => {
    const bbq = (await o().post('/categories', { name: 'BBQ', nameUr: 'بار بی کیو', sort: 1 }))
      .body;
    const tikka = (await o().post('/categories', { name: 'Tikka', parentId: bbq.id })).body;
    expect(tikka.parent_id).toBe(bbq.id);

    const dup = await o().post('/categories', { name: 'bbq' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('CONFLICT');

    const self = await o().patch(`/categories/${bbq.id}`, { parentId: bbq.id });
    expect(self.status).toBe(400);
    const loop = await o().patch(`/categories/${bbq.id}`, { parentId: tikka.id });
    expect(loop.status).toBe(400);
    expect(loop.body.title).toContain('under itself');

    expect((await o().patch(`/categories/${tikka.id}`, { name: 'Tikka & Boti' })).status).toBe(200);
    expect((await audit('CATEGORY_UPDATE', tikka.id))[0]!.before).toMatchObject({ name: 'Tikka' });

    const item = await mkItem({ name: 'Cat Test', categoryId: tikka.id }, { DINE_IN: 10000 });
    expect(menuItem((await menu()).body, item.id)).toBeTruthy();
    expect((await menu()).body.categories.map((c: { id: string }) => c.id)).toContain(tikka.id);
    await o().patch(`/categories/${tikka.id}`, { isActive: false });
    expect((await menu()).body.categories.map((c: { id: string }) => c.id)).not.toContain(tikka.id);
    expect(menuItem((await menu()).body, item.id)).toBeUndefined(); // its items are hidden with it
  });

  it('rejects a parent or category from another branch', async () => {
    const mine = (await o().post('/categories', { name: 'Mine' })).body;
    const theirs = await t.as(manager2).get('/categories');
    expect(theirs.body.items).toEqual([]);
    expect((await t.as(manager2).patch(`/categories/${mine.id}`, { name: 'x' })).status).toBe(404);
    expect(
      (await t.as(manager2).post('/categories', { name: 'x', parentId: mine.id })).status,
    ).toBe(404);
  });
});

describe('items and variants', () => {
  it('creates STANDARD items with variants (first is default), WEIGHT and DEAL with exactly one', async () => {
    const std = await o().post('/items', {
      kind: 'STANDARD',
      code: 'KRH',
      name: 'Chicken Karahi',
      nameUr: 'چکن کڑاہی',
      stationId: S.BBQ,
      searchTerms: 'karahi karai',
      variants: [{ name: 'Half' }, { name: 'Full', nameUr: 'فل' }],
    });
    expect(std.status).toBe(201);
    expect(
      std.body.variants.map((v: { name: string; isDefault: boolean }) => [v.name, v.isDefault]),
    ).toEqual([
      ['Half', true],
      ['Full', false],
    ]);
    expect(std.body).toMatchObject({
      code: 'KRH',
      nameUr: 'چکن کڑاہی',
      searchTerms: 'karahi karai',
      stationId: S.BBQ,
      isAvailable: true,
      isActive: true,
    });

    const plain = await o().post('/items', { kind: 'STANDARD', name: 'Plain Naan' });
    expect(plain.body.variants.map((v: { name: string }) => v.name)).toEqual(['Regular']);

    const weight = await o().post('/items', { kind: 'WEIGHT', name: 'Mutton Chops' });
    expect(weight.body.variants.map((v: { name: string }) => v.name)).toEqual(['Per kg']);
    expect(
      (
        await o().post('/items', {
          kind: 'WEIGHT',
          name: 'W2',
          variants: [{ name: 'a' }, { name: 'b' }],
        })
      ).status,
    ).toBe(400);
    expect((await o().post(`/items/${weight.body.id}/variants`, { name: 'Half kg' })).status).toBe(
      400,
    );

    const deal = await o().post('/items', { kind: 'DEAL', name: 'Mini Deal' });
    expect(deal.body.variants.map((v: { name: string }) => v.name)).toEqual(['Deal']);

    expect(
      (
        await o().post('/items', {
          kind: 'STANDARD',
          name: 'Two defaults',
          variants: [
            { name: 'a', isDefault: true },
            { name: 'b', isDefault: true },
          ],
        })
      ).status,
    ).toBe(400);
    expect(await audit('ITEM_CREATE', std.body.id)).toHaveLength(1);
  });

  it('validates references, codes, tax category and unknown fields', async () => {
    const otherStation = (
      await t.as(owner, t.otherBranchId).post('/stations', { code: 'X', name: 'X' })
    ).body.id;
    expect(
      (await o().post('/items', { kind: 'STANDARD', name: 'a', stationId: otherStation })).status,
    ).toBe(400);
    expect(
      (
        await o().post('/items', {
          kind: 'STANDARD',
          name: 'a',
          categoryId: '00000000-0000-4000-8000-000000000000',
        })
      ).status,
    ).toBe(404);
    expect(
      (await o().post('/items', { kind: 'STANDARD', name: 'a', taxCategoryCode: 'NOPE' })).status,
    ).toBe(400);
    expect(
      (await o().post('/items', { kind: 'STANDARD', name: 'a', code: 'bad code' })).status,
    ).toBe(400);
    expect(
      (await o().post('/items', { kind: 'STANDARD', name: 'a', branchId: t.otherBranchId })).status,
    ).toBe(400);
    await o().post('/items', { kind: 'STANDARD', name: 'a', code: 'DUPCODE' });
    expect(
      (await o().post('/items', { kind: 'STANDARD', name: 'b', code: 'DUPCODE' })).status,
    ).toBe(409);
  });

  it('PATCH edits fields but never the kind; deactivation hides the item from the POS menu', async () => {
    const it = await mkItem({ name: 'Patch Me' }, { DINE_IN: 5000 });
    const p = await o().patch(`/items/${it.id}`, {
      name: 'Patched',
      nameUr: 'پیچ',
      searchTerms: null,
      sort: 5,
    });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ name: 'Patched', nameUr: 'پیچ', sort: 5 });
    expect((await o().patch(`/items/${it.id}`, { kind: 'WEIGHT' })).status).toBe(400);
    expect((await o().patch(`/items/${it.id}`, {})).status).toBe(400);
    expect(menuItem((await menu()).body, it.id)).toBeTruthy();
    await o().patch(`/items/${it.id}`, { isActive: false });
    expect(menuItem((await menu()).body, it.id)).toBeUndefined();
    expect(
      (await o().get('/items?includeInactive=true')).body.items.map((i: { id: string }) => i.id),
    ).toContain(it.id);
    expect((await o().get('/items')).body.items.map((i: { id: string }) => i.id)).not.toContain(
      it.id,
    );
    const rows = await audit('ITEM_UPDATE', it.id);
    expect(rows.at(-1)!.before).toMatchObject({ is_active: true });
    expect(rows.at(-1)!.after).toMatchObject({ is_active: false });
  });

  it('variants: add, switch default, cannot deactivate the default, duplicate names rejected', async () => {
    const it = await mkItem({ name: 'Biryani', variants: [{ name: 'Single' }] });
    const half = (await o().post(`/items/${it.id}/variants`, { name: 'Half' })).body;
    const full = (await o().post(`/items/${it.id}/variants`, { name: 'Full', isDefault: true }))
      .body;
    const state = async () =>
      (await o().get(`/items/${it.id}`)).body.variants.map(
        (v: { name: string; isDefault: boolean }) => [v.name, v.isDefault],
      );
    expect(await state()).toEqual(
      expect.arrayContaining([
        ['Single', false],
        ['Half', false],
        ['Full', true],
      ]),
    );
    expect((await o().post(`/items/${it.id}/variants`, { name: 'full' })).status).toBe(409);
    expect((await o().patch(`/variants/${full.id}`, { isActive: false })).status).toBe(400);
    expect((await o().patch(`/variants/${half.id}`, { isDefault: true })).status).toBe(200);
    expect((await state()).filter(([, d]: [string, boolean]) => d)).toEqual([['Half', true]]);
    expect((await o().patch(`/variants/${full.id}`, { isActive: false })).status).toBe(200);
    expect((await o().patch(`/variants/${half.id}`, { isDefault: false })).status).toBe(400); // only `true` is allowed
  });
});

describe('prices (history is kept; never guessed)', () => {
  it('sets, corrects same-day, schedules a change, and refuses the past and conflicts', async () => {
    const it = await mkItem({ name: 'Priced', code: 'PRICED' });
    const put = (list: string, body: Record<string, unknown>) =>
      o().put(`/variants/${it.variantId}/prices/${L[list]}`, body);

    expect((await put('DINE_IN', { pricePaisa: 100000 })).body).toMatchObject({
      changed: true,
      mode: 'new',
      effectiveFrom: '2026-08-01',
    });
    expect((await put('DINE_IN', { pricePaisa: 100000 })).body).toMatchObject({
      changed: false,
      mode: 'unchanged',
    });
    expect((await put('DINE_IN', { pricePaisa: 110000 })).body.mode).toBe('same_day_update');
    expect(
      (await put('DINE_IN', { pricePaisa: 120000, effectiveFrom: '2026-08-10' })).body.mode,
    ).toBe('close_and_new');

    const rows = (await o().get(`/items/${it.id}`)).body.variants[0].prices.filter(
      (p: { priceListCode: string }) => p.priceListCode === 'DINE_IN',
    );
    expect(
      rows.map((p: { pricePaisa: number; effectiveFrom: string; effectiveTo: string | null }) => [
        p.pricePaisa,
        p.effectiveFrom,
        p.effectiveTo,
      ]),
    ).toEqual([
      [110000, '2026-08-01', '2026-08-09'],
      [120000, '2026-08-10', null],
    ]);

    expect((await put('DINE_IN', { pricePaisa: 1, effectiveFrom: '2026-07-31' })).status).toBe(400); // past
    const conflict = await put('DINE_IN', { pricePaisa: 130000, effectiveFrom: '2026-08-05' }); // before a scheduled one
    expect(conflict.status).toBe(409);
    expect((await put('DINE_IN', { pricePaisa: 1.5 })).status).toBe(400);
    expect((await put('DINE_IN', { pricePaisa: -1 })).status).toBe(400);
    expect((await put('DINE_IN', { pricePaisa: 100, effectiveFrom: '01-08-2026' })).status).toBe(
      400,
    );

    // the POS sees the right price for each business date
    const price = async (date?: string) => {
      const m = (await menu(`?priceList=DINE_IN${date ? `&date=${date}` : ''}`)).body;
      return menuItem(m, it.id)?.variants[0].pricePaisa;
    };
    expect(await price()).toBe(110000);
    expect(await price('2026-08-09')).toBe(110000);
    expect(await price('2026-08-10')).toBe(120000);
    expect(await price('2026-07-01')).toBeUndefined(); // before any price: not offered

    const audits = await audit('PRICE_SET');
    expect(
      audits.some(
        (a) =>
          (a.after as { pricePaisa: number }).pricePaisa === 120000 &&
          (a.before as { pricePaisa: number }).pricePaisa === 110000,
      ),
    ).toBe(true);
  });

  it('zero is a valid price; prices are scoped to the branch and need menu.manage', async () => {
    const it = await mkItem({ name: 'Free Chutney' });
    const zero = await o().put(`/variants/${it.variantId}/prices/${L.DINE_IN}`, { pricePaisa: 0 });
    expect(zero.body.mode).toBe('new');
    expect(menuItem((await menu()).body, it.id)!.variants[0].pricePaisa).toBe(0);

    expect(
      (await t.as(cashier).put(`/variants/${it.variantId}/prices/${L.DINE_IN}`, { pricePaisa: 5 }))
        .status,
    ).toBe(403);
    expect(
      (await t.as(manager2).put(`/variants/${it.variantId}/prices/${L.DINE_IN}`, { pricePaisa: 5 }))
        .status,
    ).toBe(404);
    expect(
      (
        await o().put(`/variants/${it.variantId}/prices/00000000-0000-4000-8000-000000000000`, {
          pricePaisa: 5,
        })
      ).status,
    ).toBe(404);
  });
});

describe('POS menu read model', () => {
  it('offers only priced items per channel, with Urdu names, stations, search terms and availability', async () => {
    const tikka = await mkItem(
      {
        code: 'T-RM',
        name: 'Chicken Tikka',
        nameUr: 'چکن تکہ',
        stationId: S.BBQ,
        searchTerms: 'tikka tika',
      },
      { DINE_IN: 50000, DELIVERY: 60000 },
    );
    const karahi = await mkItem(
      { code: 'K-RM', name: 'Karahi', variants: [{ name: 'Half' }, { name: 'Full' }] },
      { DINE_IN: 110000 },
    );
    await o().put(`/variants/${karahi.variants[1]!.id}/prices/${L.DINE_IN}`, {
      pricePaisa: 210000,
    });
    await o().put(`/variants/${karahi.variants[1]!.id}/prices/${L.TAKEAWAY}`, {
      pricePaisa: 200000,
    });
    const unpriced = await mkItem({ code: 'U-RM', name: 'Unpriced' });

    const dine = (await menu('?priceList=DINE_IN')).body;
    expect(menuItem(dine, tikka.id)).toMatchObject({
      name: 'Chicken Tikka',
      nameUr: 'چکن تکہ',
      station: 'BBQ',
      searchTerms: 'tikka tika',
      available: true,
      kind: 'STANDARD',
    });
    expect(
      menuItem(dine, karahi.id)!.variants.map((v: { name: string; pricePaisa: number }) => [
        v.name,
        v.pricePaisa,
      ]),
    ).toEqual([
      ['Half', 110000],
      ['Full', 210000],
    ]);
    expect(menuItem(dine, unpriced.id)).toBeUndefined();
    expect(dine.priceList).toBe('DINE_IN');
    expect(dine.date).toBe('2026-08-01');

    const takeaway = (await menu('?priceList=takeaway')).body; // case-insensitive code
    expect(menuItem(takeaway, tikka.id)).toBeUndefined(); // no takeaway price → not sold there
    expect(menuItem(takeaway, karahi.id)!.variants.map((v: { name: string }) => v.name)).toEqual([
      'Full',
    ]); // only priced variants
    const delivery = (await menu('?priceList=DELIVERY')).body;
    expect(menuItem(delivery, tikka.id)!.variants[0].pricePaisa).toBe(60000);

    expect((await o().get('/menu?priceList=NOPE')).status).toBe(404);
    expect((await o().get('/menu?date=2026-13-45x')).status).toBe(400);
  });

  it('ETag: 304 when nothing changed; availability, price and item edits change it immediately', async () => {
    const it = await mkItem({ name: 'Etag Item' }, { DINE_IN: 1000 });
    const first = await menu();
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^W\/"[0-9a-f]{20}"$/);
    expect(first.headers['cache-control']).toContain('no-cache');

    const same = await o().get('/menu').set('If-None-Match', etag);
    expect(same.status).toBe(304);
    expect(same.text).toBe('');

    await t.as(cashier).patch(`/items/${it.id}/availability`, { isAvailable: false });
    const afterToggle = await o().get('/menu').set('If-None-Match', etag);
    expect(afterToggle.status).toBe(200);
    expect(menuItem(afterToggle.body, it.id)!.available).toBe(false);
    const etag2 = afterToggle.headers.etag as string;
    expect(etag2).not.toBe(etag);

    await o().put(`/variants/${it.variantId}/prices/${L.DINE_IN}`, { pricePaisa: 2000 });
    const afterPrice = await o().get('/menu').set('If-None-Match', etag2);
    expect(afterPrice.status).toBe(200);
    expect(menuItem(afterPrice.body, it.id)!.variants[0].pricePaisa).toBe(2000);

    await o().patch(`/items/${it.id}`, { name: 'Renamed Etag' });
    expect(menuItem((await menu()).body, it.id)!.name).toBe('Renamed Etag');
  });

  it('is branch-scoped and a different price list/date gets its own cache entry', async () => {
    const m2 = await t.as(manager2).get('/menu');
    expect(m2.status).toBe(404); // branch 2 has no price lists configured
    const a = await menu('?priceList=DINE_IN');
    const b = await menu('?priceList=DELIVERY');
    expect(a.headers.etag).not.toBe(b.headers.etag);
  });

  it('lists items hidden by missing prices for the admin', async () => {
    const lonely = await mkItem({ name: 'Lonely Unpriced', code: 'LONELY' });
    const partial = await mkItem({ name: 'Partial', code: 'PARTIAL' }, { DINE_IN: 100 });
    const w = (await o().get('/menu/warnings')).body;
    expect(w.unpricedEverywhere.map((i: { id: string }) => i.id)).toContain(lonely.id);
    expect(w.unpricedEverywhere.map((i: { id: string }) => i.id)).not.toContain(partial.id);
    const takeaway = w.byPriceList.find((p: { priceList: string }) => p.priceList === 'TAKEAWAY');
    expect(takeaway.itemsWithoutPrice.map((i: { id: string }) => i.id)).toContain(partial.id);
    expect((await t.as(cashier).get('/menu/warnings')).status).toBe(403);
  });
});

describe('86 toggle (availability)', () => {
  it('cashier and kitchen may toggle, captain may not; only real changes are audited', async () => {
    const it = await mkItem({ name: 'Sold Out Soon' }, { DINE_IN: 100 });
    expect(
      (await t.as(kitchen).patch(`/items/${it.id}/availability`, { isAvailable: false })).body,
    ).toEqual({ id: it.id, isAvailable: false });
    expect(
      (await t.as(cashier).patch(`/items/${it.id}/availability`, { isAvailable: false })).status,
    ).toBe(200); // no change
    expect(
      (await t.as(cashier).patch(`/items/${it.id}/availability`, { isAvailable: true })).status,
    ).toBe(200);
    const denied = await t
      .as(captain)
      .patch(`/items/${it.id}/availability`, { isAvailable: false });
    expect(denied.status).toBe(403);
    expect(denied.body.permission).toBe('menu.availability');
    const rows = await audit('ITEM_AVAILABILITY', it.id);
    expect(rows.map((r) => (r.after as { isAvailable: boolean }).isAvailable)).toEqual([
      false,
      true,
    ]);
    // staff with only availability cannot edit the item itself
    expect((await t.as(kitchen).patch(`/items/${it.id}`, { name: 'x' })).status).toBe(403);
    expect(
      (await t.as(manager2).patch(`/items/${it.id}/availability`, { isAvailable: false })).status,
    ).toBe(404);
  });
});

describe('modifiers', () => {
  it('manages groups and modifiers, attaches them to items, and the payload validates with the domain', async () => {
    const g = await o().post('/modifier-groups', {
      code: 'SPICE',
      name: 'Spice level',
      nameUr: 'مرچ',
      minSelect: 1,
      maxSelect: 1,
    });
    expect(g.status).toBe(201);
    expect(
      (
        await o().post('/modifier-groups', {
          code: 'SPICE',
          name: 'Dup',
          minSelect: 0,
          maxSelect: 1,
        })
      ).status,
    ).toBe(409);
    expect(
      (await o().post('/modifier-groups', { code: 'BAD', name: 'Bad', minSelect: 3, maxSelect: 1 }))
        .status,
    ).toBe(400);

    const mild = (
      await o().post(`/modifier-groups/${g.body.id}/modifiers`, {
        name: 'Mild',
        priceDeltaPaisa: 0,
      })
    ).body;
    const hot = (
      await o().post(`/modifier-groups/${g.body.id}/modifiers`, {
        name: 'Hot',
        nameUr: 'تیز',
        priceDeltaPaisa: 5000,
        sort: 2,
      })
    ).body;
    const extras = (
      await o().post('/modifier-groups', {
        code: 'EXTRAS',
        name: 'Extras',
        minSelect: 0,
        maxSelect: 2,
      })
    ).body;
    const raita = (
      await o().post(`/modifier-groups/${extras.id}/modifiers`, {
        name: 'Extra raita',
        priceDeltaPaisa: 4000,
      })
    ).body;

    const it = await mkItem({ name: 'With Mods' }, { DINE_IN: 80000 });
    expect(
      (await o().put(`/items/${it.id}/modifier-groups`, { groupIds: [g.body.id, extras.id] }))
        .status,
    ).toBe(200);
    expect(
      (
        await o().put(`/items/${it.id}/modifier-groups`, {
          groupIds: ['00000000-0000-4000-8000-000000000000'],
        })
      ).status,
    ).toBe(400);

    const payload = menuItem((await menu()).body, it.id)!;
    expect(payload.modifierGroups.map((x: { code: string }) => x.code)).toEqual([
      'SPICE',
      'EXTRAS',
    ]);
    expect(payload.modifierGroups[0].modifiers.map((m: { name: string }) => m.name)).toEqual([
      'Mild',
      'Hot',
    ]);

    // The menu payload is sufficient input for the domain's modifier validation
    const defs: ModifierGroupDef[] = payload.modifierGroups.map(
      (x: {
        id: string;
        minSelect: number;
        maxSelect: number;
        modifiers: { id: string; priceDeltaPaisa: number }[];
      }) => ({
        id: x.id,
        minSelect: x.minSelect,
        maxSelect: x.maxSelect,
        modifiers: x.modifiers.map((m) => ({
          id: m.id,
          priceDeltaPaisa: asPaisa(m.priceDeltaPaisa),
          isActive: true,
        })),
      }),
    );
    expect(validateModifierSelection(defs, [hot.id, raita.id]).deltaPerUnitPaisa).toBe(9000);
    expect(() => validateModifierSelection(defs, [raita.id])).toThrow(); // spice level is required

    // deactivating a modifier removes it from the menu; editing is audited
    expect(
      (await o().patch(`/modifiers/${hot.id}`, { isActive: false, priceDeltaPaisa: 6000 })).status,
    ).toBe(200);
    expect(
      menuItem((await menu()).body, it.id)!.modifierGroups[0].modifiers.map(
        (m: { id: string }) => m.id,
      ),
    ).toEqual([mild.id]);
    expect((await audit('MODIFIER_UPDATE', hot.id))[0]!.before).toMatchObject({
      price_delta_paisa: 5000,
    });
    expect((await o().patch(`/modifier-groups/${g.body.id}`, { maxSelect: 0 })).status).toBe(400); // max < min
    expect(
      (
        await t
          .as(cashier)
          .post('/modifier-groups', { code: 'X', name: 'X', minSelect: 0, maxSelect: 1 })
      ).status,
    ).toBe(403);
    expect((await t.as(manager2).patch(`/modifiers/${hot.id}`, { name: 'x' })).status).toBe(404);
  });
});

describe('deals', () => {
  async function setup() {
    const karahi = await mkItem(
      { name: 'Deal Karahi', variants: [{ name: 'Half' }, { name: 'Full' }] },
      { DINE_IN: 110000 },
    );
    const naan = await mkItem({ name: 'Deal Naan' }, { DINE_IN: 3000 });
    const cola = await mkItem({ name: 'Deal Cola' }, { DINE_IN: 8000 });
    const sprite = await mkItem({ name: 'Deal Sprite' }, { DINE_IN: 8000 });
    const deal = await mkItem({ name: 'Family Deal', kind: 'DEAL' }, { DINE_IN: 400000 });
    return { karahi, naan, cola, sprite, deal };
  }

  it('configures slots and options; the POS payload drives the domain deal validation', async () => {
    const { karahi, naan, cola, sprite, deal } = await setup();
    const res = await o().put(`/items/${deal.id}/deal`, {
      slots: [
        {
          name: 'Karahi',
          qty: 1,
          options: [
            { variantId: karahi.variants[0]!.id, isDefault: true },
            { variantId: karahi.variants[1]!.id, priceDeltaPaisa: 30000 },
          ],
        },
        { name: 'Naan', qty: 4, options: [{ variantId: naan.variantId }] },
        {
          name: 'Drinks',
          qty: 2,
          options: [{ variantId: cola.variantId }, { variantId: sprite.variantId }],
        },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.deal.slots.map((s: { name: string; qty: number }) => [s.name, s.qty])).toEqual([
      ['Karahi', 1],
      ['Naan', 4],
      ['Drinks', 2],
    ]);

    const payload = menuItem((await menu()).body, deal.id)!;
    expect(payload.kind).toBe('DEAL');
    expect(payload.variants[0].pricePaisa).toBe(400000);
    const slots: DealSlotDef[] = payload.deal.slots.map(
      (s: {
        id: string;
        name: string;
        qty: number;
        options: { id: string; variantId: string; priceDeltaPaisa: number; isDefault: boolean }[];
      }) => ({
        id: s.id,
        name: s.name,
        qty: s.qty,
        options: s.options.map((x) => ({
          id: x.id,
          variantId: x.variantId,
          priceDeltaPaisa: asPaisa(x.priceDeltaPaisa),
          isDefault: x.isDefault,
        })),
      }),
    );
    const picks = defaultDealPicks(slots); // karahi default + fixed naan; drinks need a choice
    expect(picks).toHaveLength(2);
    const drinks = slots[2]!;
    const full = [
      ...picks,
      { slotId: drinks.id, optionId: drinks.options[0]!.id, count: 1 },
      { slotId: drinks.id, optionId: drinks.options[1]!.id, count: 1 },
    ];
    expect(validateDealSelection(slots, full).upchargePerUnitPaisa).toBe(0);
    expect(payload.deal.slots[0].options[0]).toMatchObject({
      itemName: 'Deal Karahi',
      variantName: 'Half',
      isDefault: true,
    });
    expect(await audit('DEAL_SET', deal.id)).toHaveLength(1);
  });

  it('replaces the whole structure on every save', async () => {
    const { naan, deal } = await setup();
    await o().put(`/items/${deal.id}/deal`, {
      slots: [
        { name: 'A', qty: 1, options: [{ variantId: naan.variantId }] },
        { name: 'B', qty: 1, options: [{ variantId: naan.variantId }] },
      ],
    });
    const res = await o().put(`/items/${deal.id}/deal`, {
      slots: [{ name: 'Only', qty: 2, options: [{ variantId: naan.variantId }] }],
    });
    expect(res.body.deal.slots.map((s: { name: string }) => s.name)).toEqual(['Only']);
    const rows = await audit('DEAL_SET', deal.id);
    expect((rows[1]!.before as { slots: unknown[] }).slots).toHaveLength(2);
  });

  it('rejects invalid deals', async () => {
    const { karahi, naan, deal } = await setup();
    const put = (id: string, slots: unknown) => o().put(`/items/${id}/deal`, { slots });
    const ok = [{ name: 'S', qty: 1, options: [{ variantId: naan.variantId }] }];

    expect((await put(naan.id, ok)).body.title).toContain('kind DEAL'); // not a deal item
    expect((await put(deal.id, [])).status).toBe(400);
    expect(
      (await put(deal.id, [{ name: 'S', qty: 0, options: [{ variantId: naan.variantId }] }]))
        .status,
    ).toBe(400);
    expect((await put(deal.id, [{ name: 'S', qty: 1, options: [] }])).status).toBe(400);
    const twoDefaults = await put(deal.id, [
      {
        name: 'S',
        qty: 1,
        options: [
          { variantId: karahi.variants[0]!.id, isDefault: true },
          { variantId: karahi.variants[1]!.id, isDefault: true },
        ],
      },
    ]);
    expect(twoDefaults.status).toBe(400);
    expect(twoDefaults.body.reason).toBe('DEAL_MULTIPLE_DEFAULTS');
    expect(
      (
        await put(deal.id, [
          {
            name: 'S',
            qty: 1,
            options: [{ variantId: naan.variantId }, { variantId: naan.variantId }],
          },
        ])
      ).body.reason,
    ).toBe('DEAL_DUPLICATE_VARIANT');
    expect(
      (
        await put(deal.id, [
          { name: 'S', qty: 1, options: [{ variantId: '00000000-0000-4000-8000-000000000000' }] },
        ])
      ).status,
    ).toBe(400);

    const other = await mkItem({ name: 'Another Deal', kind: 'DEAL' });
    expect(
      (await put(deal.id, [{ name: 'S', qty: 1, options: [{ variantId: other.variantId }] }])).body
        .title,
    ).toContain('another deal');

    await o().patch(`/variants/${karahi.variants[1]!.id}`, { isActive: false });
    expect(
      (
        await put(deal.id, [
          { name: 'S', qty: 1, options: [{ variantId: karahi.variants[1]!.id }] },
        ])
      ).body.title,
    ).toContain('inactive');
    expect((await t.as(cashier).put(`/items/${deal.id}/deal`, { slots: ok })).status).toBe(403);
  });

  it('options that become inactive disappear from the POS payload', async () => {
    const { naan, cola, deal } = await setup();
    await o().put(`/items/${deal.id}/deal`, {
      slots: [
        {
          name: 'Drink',
          qty: 1,
          options: [{ variantId: cola.variantId }, { variantId: naan.variantId }],
        },
      ],
    });
    await o().patch(`/items/${cola.id}`, { isActive: false });
    const slot = menuItem((await menu()).body, deal.id)!.deal.slots[0];
    expect(slot.options.map((x: { itemName: string }) => x.itemName)).toEqual(['Deal Naan']);
  });
});

describe('scale', () => {
  it('serves a 300-item menu quickly and revalidates with 304', async () => {
    const branch = t.branchId;
    const cat = (
      await t.kdb
        .insertInto('categories')
        .values({ branch_id: branch, name: 'Bulk' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const tax = (
      await t.kdb
        .selectFrom('tax_categories')
        .select('id')
        .where('code', '=', 'RESTAURANT_SERVICE')
        .executeTakeFirstOrThrow()
    ).id;
    for (let i = 0; i < 300; i++) {
      const item = await t.kdb
        .insertInto('items')
        .values({
          branch_id: branch,
          category_id: cat,
          tax_category_id: tax,
          code: `BULK${i}`,
          name: `Bulk ${i}`,
          sort: i,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      for (const [n, name] of ['Half', 'Full'].entries()) {
        const v = await t.kdb
          .insertInto('item_variants')
          .values({ item_id: item.id, name, is_default: n === 0 })
          .returning('id')
          .executeTakeFirstOrThrow();
        await t.kdb
          .insertInto('item_prices')
          .values({
            variant_id: v.id,
            price_list_id: L.DINE_IN!,
            price_paisa: 10000 + i,
            effective_from: '2026-01-01',
          })
          .execute();
      }
    }
    t.ctx.menu.bump(branch); // direct SQL bypassed the service
    const started = performance.now();
    const cold = await menu();
    const coldMs = performance.now() - started;
    expect(cold.body.items.length).toBeGreaterThanOrEqual(300);
    expect(coldMs).toBeLessThan(2000);

    const warmStart = performance.now();
    const warm = await o()
      .get('/menu')
      .set('If-None-Match', cold.headers.etag as string);
    expect(warm.status).toBe(304);
    expect(performance.now() - warmStart).toBeLessThan(500);
  });
});
