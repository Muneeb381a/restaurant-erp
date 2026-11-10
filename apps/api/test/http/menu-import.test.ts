import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from './app-harness';

let t: TestApp;
let owner: string;
let cashier: string;

const HEADER =
  'category,category_ur,item_code,item_name,item_name_ur,kind,station,variant,variant_ur,price_dine_in,price_takeaway,price_delivery,search_terms,available';
const MENU = [
  HEADER,
  'BBQ,بار بی کیو,TIKKA,Chicken Tikka,چکن تکہ,STANDARD,BBQ,,,"1,250.50",1200,1400,tikka tika,yes',
  'BBQ,,MCHOPS,Mutton Chops,مٹن چاپس,WEIGHT,BBQ,,,4500,,4700,,',
  'Karahi,کڑاہی,KARAHI,Chicken Karahi,چکن کڑاہی,,,Half,آدھا,1100,1100,1200,"karahi, karai",',
  ',,KARAHI,,,,,Full,فل,2100,2100,2300,,',
  'Drinks,,COLA,Cola 345ml,,,,,,100,100,100,,no',
].join('\r\n');

const post = (
  csv: string,
  query = '',
  token = () => owner,
  headers: Record<string, string> = { 'content-type': 'text/csv' },
) =>
  request(t.app)
    .post(`/api/v1/menu/import${query}`)
    .set('Authorization', `Bearer ${token()}`)
    .set('x-branch-id', t.branchId)
    .set(headers)
    .send(csv);
const apply = (csv: string, extra = '') => post(csv, `?dryRun=false${extra}`);
const count = async (table: 'items' | 'item_variants' | 'item_prices' | 'categories') =>
  Number(
    (
      await t.kdb
        .selectFrom(table)
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow()
    ).n,
  );

beforeAll(async () => {
  t = await startApp();
  owner = (await t.login('OWNER')).token;
  cashier = (await t.login('CASHIER')).token;
  for (const [code, name] of [
    ['DINE_IN', 'Dine-in'],
    ['TAKEAWAY', 'Takeaway'],
    ['DELIVERY', 'Delivery'],
  ] as const) {
    await t.as(owner).post('/price-lists', { code, name });
  }
  await t.as(owner).post('/stations', { code: 'BBQ', name: 'BBQ' });
}, 180_000);
afterAll(async () => {
  await t.stop();
});

describe('dry run (the default) never changes anything', () => {
  it('reports what would happen, including Urdu text and quoted cells', async () => {
    const res = await post(MENU);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      dryRun: true,
      ok: true,
      effectiveFrom: '2026-08-01',
      errors: [],
      summary: {
        categoriesCreated: 3,
        itemsCreated: 4,
        variantsCreated: 5,
        pricesSet: 14,
        itemsUnchanged: 0,
      },
    });
    expect(await count('items')).toBe(0);
    expect(await count('categories')).toBe(0);
    expect((await post(MENU, '?dryRun=true')).body.dryRun).toBe(true);
  });
});

describe('applying an import', () => {
  it('creates categories, items, variants and prices; the POS menu shows them', async () => {
    const res = await apply(MENU);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ dryRun: false, ok: true });
    expect(await count('items')).toBe(4);
    expect(await count('item_variants')).toBe(5);

    const menu = (await t.as(owner).get('/menu?priceList=DINE_IN')).body;
    const tikka = menu.items.find((i: { code: string }) => i.code === 'TIKKA');
    expect(tikka).toMatchObject({
      name: 'Chicken Tikka',
      nameUr: 'چکن تکہ',
      station: 'BBQ',
      searchTerms: 'tikka tika',
      available: true,
    });
    expect(tikka.variants).toEqual([
      expect.objectContaining({ name: 'Regular', pricePaisa: 125050 }),
    ]); // "1,250.50"
    const chops = menu.items.find((i: { code: string }) => i.code === 'MCHOPS');
    expect(chops).toMatchObject({ kind: 'WEIGHT' });
    expect(chops.variants[0]).toMatchObject({ name: 'Per kg', pricePaisa: 450000 });
    const karahi = menu.items.find((i: { code: string }) => i.code === 'KARAHI');
    expect(
      karahi.variants.map((v: { name: string; nameUr: string; pricePaisa: number }) => [
        v.name,
        v.nameUr,
        v.pricePaisa,
      ]),
    ).toEqual([
      ['Half', 'آدھا', 110000],
      ['Full', 'فل', 210000],
    ]);
    expect(karahi.searchTerms).toBe('karahi, karai'); // quoted comma preserved
    expect(menu.categories.map((c: { name: string }) => c.name).sort()).toEqual([
      'BBQ',
      'Drinks',
      'Karahi',
    ]);

    // channels without a price stay unavailable there
    expect(
      (await t.as(owner).get('/menu?priceList=TAKEAWAY')).body.items.map(
        (i: { code: string }) => i.code,
      ),
    ).not.toContain('MCHOPS');
    // available=no is honoured
    expect(menu.items.find((i: { code: string }) => i.code === 'COLA').available).toBe(false);

    const log = (
      await t.kdb.selectFrom('audit_log').selectAll().where('action', '=', 'MENU_IMPORT').execute()
    )[0]!;
    expect(log.after).toMatchObject({ summary: { itemsCreated: 4, variantsCreated: 5 } });
    expect(log.user_id).toBeTruthy();
  });

  it('is idempotent: applying the same file again changes nothing', async () => {
    const before = [
      await count('items'),
      await count('item_variants'),
      await count('item_prices'),
      await count('categories'),
    ];
    const again = await apply(MENU);
    expect(again.body.summary).toMatchObject({
      categoriesCreated: 0,
      itemsCreated: 0,
      itemsUpdated: 0,
      itemsUnchanged: 4,
      variantsCreated: 0,
      pricesSet: 0,
      pricesUnchanged: 14,
    });
    expect([
      await count('items'),
      await count('item_variants'),
      await count('item_prices'),
      await count('categories'),
    ]).toEqual(before);
  });

  it('export → import is a no-op (round trip), and the export is Excel-friendly UTF-8', async () => {
    const exp = await t.as(owner).get('/menu/export.csv');
    expect(exp.status).toBe(200);
    expect(exp.headers['content-type']).toContain('text/csv');
    expect(exp.headers['content-disposition']).toContain('menu.csv');
    const text = exp.text;
    expect(text.charCodeAt(0)).toBe(0xfeff); // BOM
    expect(text).toContain('چکن تکہ');
    expect(text).toContain('"karahi, karai"');
    const dry = await post(text);
    expect(dry.body.ok, JSON.stringify(dry.body)).toBe(true);
    expect(dry.body.summary).toMatchObject({
      itemsCreated: 0,
      itemsUpdated: 0,
      variantsCreated: 0,
      pricesSet: 0,
    });
    expect(dry.body.summary.itemsUnchanged).toBe(4);
  });

  it('a changed price closes the previous period (history kept); same-day edits correct in place', async () => {
    // same day as creation → corrected in place
    const edited = MENU.replace('"1,250.50"', '1300');
    const r1 = await apply(edited);
    expect(r1.body.summary).toMatchObject({ pricesSet: 1, pricesUnchanged: 13, itemsUnchanged: 3 });
    const rows = () =>
      t.kdb
        .selectFrom('item_prices')
        .innerJoin('item_variants', 'item_variants.id', 'item_prices.variant_id')
        .innerJoin('items', 'items.id', 'item_variants.item_id')
        .select([
          'item_prices.price_paisa as p',
          'item_prices.effective_from as f',
          'item_prices.effective_to as e',
        ])
        .innerJoin('price_lists', 'price_lists.id', 'item_prices.price_list_id')
        .where('price_lists.code', '=', 'DINE_IN')
        .where('items.code', '=', 'TIKKA')
        .orderBy('item_prices.effective_from')
        .execute();
    expect(
      (await rows()).filter((x) => x.f === '2026-08-01' && x.e === null).map((x) => x.p),
    ).toContain(130000);

    // next day → closes and reopens
    t.clock.advance(24 * 3600 * 1000);
    owner = (await t.login('OWNER')).token; // access tokens last 15 minutes
    cashier = (await t.login('CASHIER')).token;
    const r2 = await apply(MENU.replace('"1,250.50"', '1400'));
    expect(r2.body).toMatchObject({ effectiveFrom: '2026-08-02' });
    const periods = (await rows()).filter((x) => [130000, 140000].includes(x.p));
    expect(periods.map((x) => [x.p, x.f, x.e])).toEqual([
      [130000, '2026-08-01', '2026-08-01'],
      [140000, '2026-08-02', null],
    ]);
    // a scheduled future change is possible too
    const r3 = await apply(MENU.replace('"1,250.50"', '1500'), '&effectiveFrom=2026-08-10');
    expect(r3.status).toBe(200);
    // …and then the file can no longer touch that variant until the schedule is resolved
    const blocked = await apply(MENU.replace('"1,250.50"', '1600'));
    expect(blocked.status).toBe(400);
    expect(JSON.stringify(blocked.body.errors)).toContain('future-dated');
  });

  it('updates names, Urdu, station, availability and category; blank cells leave values alone', async () => {
    const csv = [HEADER, 'Grill,گرل,COLA,Cola Zero,,,BBQ,,,,,,"cold drink",yes'].join('\n');
    const res = await apply(csv);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = await t.kdb
      .selectFrom('items')
      .selectAll()
      .where('code', '=', 'COLA')
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      name: 'Cola Zero',
      is_available: true,
      search_terms: 'cold drink',
    });
    const cat = await t.kdb
      .selectFrom('categories')
      .selectAll()
      .where('id', '=', row.category_id!)
      .executeTakeFirstOrThrow();
    expect(cat).toMatchObject({ name: 'Grill', name_ur: 'گرل' });
    const bbq = await t.kdb
      .selectFrom('stations')
      .select('id')
      .where('code', '=', 'BBQ')
      .executeTakeFirstOrThrow();
    expect(row.station_id).toBe(bbq.id);
    // price cells were blank → existing price untouched
    const price = await t.kdb
      .selectFrom('item_prices')
      .select('price_paisa')
      .innerJoin('item_variants', 'item_variants.id', 'item_prices.variant_id')
      .where('item_variants.item_id', '=', row.id)
      .executeTakeFirstOrThrow();
    expect(price.price_paisa).toBe(10000);
  });

  it('reactivates an item that was deactivated, with a warning', async () => {
    const item = await t.kdb
      .selectFrom('items')
      .select('id')
      .where('code', '=', 'COLA')
      .executeTakeFirstOrThrow();
    await t.as(owner).patch(`/items/${item.id}`, { isActive: false });
    const res = await apply([HEADER, ',,COLA,Cola Zero,,,,,,,,,,'].join('\n'));
    expect(res.body.warnings.some((w: string) => w.includes('reactivates it'))).toBe(true);
    expect(
      (
        await t.kdb
          .selectFrom('items')
          .select('is_active')
          .where('id', '=', item.id)
          .executeTakeFirstOrThrow()
      ).is_active,
    ).toBe(true);
  });
});

describe('rejections are atomic and precise', () => {
  it('reports every bad row with its line and changes nothing', async () => {
    const before = [await count('items'), await count('categories'), await count('item_prices')];
    const bad = [
      HEADER,
      'Soups,,SOUP1,Daal,,,,,,150,,,,', // fine
      ',,SOUP2,Bad price,,,,,,12.345,,,,', // line 3
      ',,SOUP3,Bad station,,,GRILLX,,,100,,,,', // line 4
      ',,SOUP4,Bad kind,,DEAL,,,,100,,,,', // line 5
    ].join('\n');
    const res = await apply(bad);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.errors.map((e: { line: number }) => e.line)).toEqual([3, 4, 5]);
    expect(res.body.errors[0].message).toContain('price_dine_in');
    expect([await count('items'), await count('categories'), await count('item_prices')]).toEqual(
      before,
    );
    // the same file as a dry run is a 200 with ok=false
    const dry = await post(bad);
    expect(dry.status).toBe(200);
    expect(dry.body.ok).toBe(false);
    expect(dry.body.errors).toHaveLength(3);
  });

  it('rejects wrong headers, empty files, unbalanced quotes, huge files and wrong content types', async () => {
    const h = await post('item_code,item_name,item_nme\nA,A,A');
    expect(h.body.ok).toBe(false);
    expect(h.body.errors[0].message).toContain('Unknown column "item_nme"');
    expect((await post('item_name\nA')).body.errors[0].message).toContain(
      'Missing required column "item_code"',
    );
    expect(
      (await post('item_code,item_name,price_foodpanda\nA,A,10')).body.errors[0].message,
    ).toContain('no price list');
    expect((await post(HEADER)).body.errors[0].message).toContain('no rows');
    const broken = await post('item_code,item_name\nA,"unterminated');
    expect(broken.status).toBe(400);
    expect(broken.body.title).toContain('CSV is malformed');
    const rows = [
      'item_code,item_name',
      ...Array.from({ length: 5001 }, (_, i) => `X${i},X${i}`),
    ].join('\n');
    expect((await post(rows)).status).toBe(400);
    const json = await post('{"csv":"x"}', '', () => owner, { 'content-type': 'application/json' });
    expect(json.status).toBe(400);
  });

  it('needs menu.manage and refuses back-dated imports', async () => {
    expect((await post(MENU, '?dryRun=false', () => cashier)).status).toBe(403);
    expect((await t.as(cashier).get('/menu/export.csv')).status).toBe(403);
    const past = await apply(MENU, '&effectiveFrom=2020-01-01');
    expect(past.status).toBe(400);
    expect(past.body.title).toContain('in the past');
  });

  it('refuses to edit deals or change an item kind', async () => {
    const deal = await t
      .as(owner)
      .post('/items', { kind: 'DEAL', name: 'Big Deal', code: 'BIGDEAL' });
    expect(deal.status).toBe(201);
    const res = await apply([HEADER, ',,BIGDEAL,Big Deal,,,,,,100,,,,'].join('\n'));
    expect(res.status).toBe(400);
    expect(res.body.errors[0].message).toContain('DEAL');
    const kind = await apply([HEADER, ',,TIKKA,Chicken Tikka,,WEIGHT,,,,,,,,'].join('\n'));
    expect(kind.status).toBe(400);
    expect(kind.body.errors[0].message).toContain('kind cannot change');
  });
});

describe('scale', () => {
  it('imports 1500 rows in one transaction in reasonable time, then is a no-op', async () => {
    const lines = [HEADER];
    for (let i = 0; i < 1500; i++)
      lines.push(`Bulk,,BULK${i},Bulk Item ${i},,,,,,${100 + i},${100 + i},${100 + i},,`);
    const csv = lines.join('\n');
    const started = performance.now();
    const res = await apply(csv);
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    expect(performance.now() - started).toBeLessThan(30_000);
    expect(res.body.summary.itemsCreated).toBe(1500);
    const again = await apply(csv);
    expect(again.body.summary).toMatchObject({
      itemsCreated: 0,
      pricesSet: 0,
      itemsUnchanged: 1500,
    });
  });
});
