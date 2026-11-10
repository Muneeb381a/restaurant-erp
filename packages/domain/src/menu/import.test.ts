import { describe, expect, it } from 'vitest';
import { asPaisa } from '../money';
import {
  parseMenuRecords,
  planMenuImport,
  validateHeaders,
  type ExistingMenu,
  type ImportContext,
  type ParsedItem,
} from './import';

const ctx: ImportContext = {
  priceListCodes: ['DINE_IN', 'TAKEAWAY', 'DELIVERY'],
  stationCodes: ['BBQ', 'TANDOOR', 'KARAHI'],
  taxCategoryCodes: ['RESTAURANT_SERVICE'],
};

const rec = (o: Record<string, string>): Record<string, string> => o;

describe('validateHeaders', () => {
  it('accepts known columns and price columns of existing lists (any case)', () => {
    expect(
      validateHeaders(
        ['item_code', 'item_name', 'category', 'price_dine_in', 'price_delivery'],
        ctx,
      ),
    ).toEqual([]);
  });

  it('reports missing required columns, unknown columns, unknown price lists and duplicates', () => {
    const msgs = validateHeaders(
      ['item_name', 'itemname', 'price_foodpanda', 'item_name'],
      ctx,
    ).map((e) => e.message);
    expect(msgs).toEqual(
      expect.arrayContaining([
        'Missing required column "item_code"',
        'Unknown column "itemname"',
        expect.stringContaining('no price list with code "FOODPANDA"'),
        'Column "item_name" appears twice',
      ]),
    );
    expect(
      validateHeaders(['item_code', 'item_name', 'price_x'], { ...ctx, priceListCodes: [] })[0]!
        .message,
    ).toContain('have: none');
  });
});

describe('parseMenuRecords', () => {
  it('parses a simple item with prices per channel, defaults and Urdu', () => {
    const r = parseMenuRecords(
      [
        rec({
          item_code: 'TIKKA1',
          item_name: 'Chicken Tikka',
          item_name_ur: 'چکن تکہ',
          category: 'BBQ',
          category_ur: 'بار بی کیو',
          station: 'bbq',
          price_dine_in: '1,250.50',
          price_takeaway: '1200',
          price_delivery: '',
        }),
      ],
      ctx,
    );
    expect(r.errors).toEqual([]);
    expect(r.items).toHaveLength(1);
    const it = r.items[0]!;
    expect(it).toMatchObject({
      code: 'TIKKA1',
      name: 'Chicken Tikka',
      nameUr: 'چکن تکہ',
      categoryName: 'BBQ',
      categoryNameUr: 'بار بی کیو',
      kind: 'STANDARD',
      stationCode: 'BBQ',
      available: null,
    });
    expect(it.variants).toEqual([
      {
        name: 'Regular',
        nameUr: null,
        isDefault: true,
        prices: { DINE_IN: 125050, TAKEAWAY: 120000 },
        line: 2,
      },
    ]);
  });

  it('groups rows of one item into variants (first is default) and fills item fields from later rows', () => {
    const r = parseMenuRecords(
      [
        rec({
          item_code: 'K1',
          item_name: 'Chicken Karahi',
          variant: 'Half',
          price_dine_in: '1100',
        }),
        rec({
          item_code: 'K1',
          item_name: '',
          category: 'Karahi',
          variant: 'Full',
          variant_ur: 'فل',
          price_dine_in: '2100',
          price_delivery: '2300',
          search_terms: 'karahi karai',
          available: 'No',
        }),
        rec({
          item_code: 'K1',
          item_name: 'Chicken Karahi',
          variant: 'Family',
          price_dine_in: '4000',
        }),
      ],
      ctx,
    );
    expect(r.errors).toEqual([]);
    const it = r.items[0]!;
    expect(it.categoryName).toBe('Karahi');
    expect(it.searchTerms).toBe('karahi karai');
    expect(it.available).toBe(false);
    expect(it.variants.map((v) => [v.name, v.isDefault, v.line])).toEqual([
      ['Half', true, 2],
      ['Full', false, 3],
      ['Family', false, 4],
    ]);
    expect(it.variants[1]!.nameUr).toBe('فل');
  });

  it('WEIGHT items default to a single "Per kg" variant', () => {
    const r = parseMenuRecords(
      [rec({ item_code: 'MUT', item_name: 'Mutton Chops', kind: 'weight', price_dine_in: '4500' })],
      ctx,
    );
    expect(r.errors).toEqual([]);
    expect(r.items[0]).toMatchObject({ kind: 'WEIGHT' });
    expect(r.items[0]!.variants[0]!.name).toBe('Per kg');
  });

  it('accepts yes/true/1 and no/false/0 for available', () => {
    const run = (v: string) =>
      parseMenuRecords([rec({ item_code: 'A', item_name: 'A', available: v })], ctx).items[0]!
        .available;
    expect([run('YES'), run('y'), run('true'), run('1')]).toEqual([true, true, true, true]);
    expect([run('no'), run('N'), run('False'), run('0')]).toEqual([false, false, false, false]);
  });

  it('reports every problem with its line number', () => {
    const r = parseMenuRecords(
      [
        rec({ item_code: '', item_name: 'No code' }), // 2
        rec({ item_code: 'bad code!', item_name: 'x' }), // 3
        rec({ item_code: 'D1', item_name: 'Deal', kind: 'DEAL' }), // 4
        rec({ item_code: 'S1', item_name: 'Odd', kind: 'SPECIAL' }), // 5
        rec({ item_code: 'S2', item_name: 'Bad station', station: 'GRILL' }), // 6
        rec({ item_code: 'S3', item_name: 'Bad tax', tax_category: 'LUXURY' }), // 7
        rec({ item_code: 'S4', item_name: 'Bad avail', available: 'maybe' }), // 8
        rec({
          item_code: 'S5',
          item_name: 'Bad price',
          price_dine_in: '12.345',
          price_takeaway: '-5',
        }), // 9
        rec({
          item_code: 'S6',
          item_name: 'x'.repeat(201),
          category: 'c'.repeat(101),
          search_terms: 's'.repeat(301),
          variant: 'v'.repeat(101),
        }), // 10
        rec({ item_code: 'S7', item_name: 'Ur only', category_ur: 'اردو' }), // 11
      ],
      ctx,
    );
    const byLine = (l: number) => r.errors.filter((e) => e.line === l).map((e) => e.message);
    expect(byLine(2)).toEqual(['item_code is required']);
    expect(byLine(3)[0]).toContain('may only contain');
    expect(byLine(4)[0]).toContain('cannot be imported from CSV');
    expect(byLine(5)[0]).toContain('must be STANDARD or WEIGHT');
    expect(byLine(6)[0]).toContain('station "GRILL" does not exist');
    expect(byLine(7)[0]).toContain('tax_category "LUXURY" does not exist');
    expect(byLine(8)[0]).toContain('must be yes or no');
    expect(byLine(9)).toHaveLength(2);
    expect(byLine(9)[0]).toContain('price_dine_in');
    expect(byLine(10)).toHaveLength(4);
    expect(byLine(11)[0]).toContain('category_ur needs category');
  });

  it('detects conflicting item-level values across rows, naming the other line', () => {
    const r = parseMenuRecords(
      [
        rec({
          item_code: 'X',
          item_name: 'Name A',
          category: 'BBQ',
          nameur: '',
          item_name_ur: 'الف',
          kind: 'STANDARD',
          station: 'BBQ',
          tax_category: 'RESTAURANT_SERVICE',
          search_terms: 'a',
          available: 'yes',
          category_ur: 'ب',
          variant: 'One',
        }),
        rec({
          item_code: 'X',
          item_name: 'Name B',
          category: 'Other',
          item_name_ur: 'ب',
          kind: 'WEIGHT',
          station: 'TANDOOR',
          tax_category: 'restaurant_service',
          search_terms: 'b',
          available: 'no',
          category_ur: 'ج',
          variant: 'Two',
        }),
      ],
      ctx,
    );
    const msgs = r.errors.map((e) => e.message);
    expect(
      msgs.some((m) => m.includes('item_name "Name B" conflicts with "Name A" on line 2')),
    ).toBe(true);
    expect(msgs.some((m) => m.includes('category "Other" conflicts'))).toBe(true);
    expect(msgs.some((m) => m.includes('kind "WEIGHT" conflicts'))).toBe(true);
    expect(msgs.some((m) => m.includes('station "TANDOOR" conflicts'))).toBe(true);
    expect(msgs.some((m) => m.includes('search_terms'))).toBe(true);
    expect(msgs.some((m) => m.includes('available'))).toBe(true);
    expect(msgs.some((m) => m.includes('item_name_ur'))).toBe(true);
    expect(msgs.some((m) => m.includes('category_ur'))).toBe(true);
    expect(r.errors.every((e) => e.line === 3)).toBe(true);
  });

  it('requires variant names when an item has several rows, rejects duplicates and multi-row WEIGHT', () => {
    const r1 = parseMenuRecords(
      [
        rec({ item_code: 'A', item_name: 'A', variant: 'Half' }),
        rec({ item_code: 'A', item_name: 'A' }),
      ],
      ctx,
    );
    expect(r1.errors.map((e) => e.message)).toEqual([
      'variant is required because item A has several rows',
    ]);
    const r2 = parseMenuRecords(
      [
        rec({ item_code: 'A', item_name: 'A', variant: 'Half' }),
        rec({ item_code: 'A', item_name: 'A', variant: 'half' }),
      ],
      ctx,
    );
    expect(r2.errors[0]!.message).toContain('appears twice');
    const r3 = parseMenuRecords(
      [
        rec({ item_code: 'W', item_name: 'W', kind: 'WEIGHT', variant: 'a' }),
        rec({ item_code: 'W', item_name: 'W', variant: 'b' }),
      ],
      ctx,
    );
    expect(r3.errors.map((e) => e.message)).toEqual([expect.stringContaining('exactly one row')]);
  });

  it('requires an item_name on at least one row and warns about unpriced variants', () => {
    const r = parseMenuRecords([rec({ item_code: 'Z', item_name: '' })], ctx);
    expect(r.errors).toEqual([{ line: 2, message: 'item_name is required for item Z' }]);
    const w = parseMenuRecords([rec({ item_code: 'Q', item_name: 'Q' })], ctx);
    expect(w.errors).toEqual([]);
    expect(w.warnings[0]).toContain('has no price on any channel');
  });
});

// ─────────────────────────────── planning ───────────────────────────────

const DATE = '2026-08-01';
const parse = (rows: Record<string, string>[]): ParsedItem[] => {
  const r = parseMenuRecords(rows, ctx);
  expect(r.errors).toEqual([]);
  return r.items;
};
const empty: ExistingMenu = { items: [], categories: [] };

describe('planMenuImport', () => {
  const rows = [
    rec({
      item_code: 'T1',
      item_name: 'Tikka',
      category: 'BBQ',
      station: 'BBQ',
      price_dine_in: '500',
    }),
    rec({
      item_code: 'K1',
      item_name: 'Karahi',
      category: 'BBQ',
      variant: 'Half',
      price_dine_in: '1100',
      price_delivery: '1200',
    }),
    rec({ item_code: 'K1', item_name: 'Karahi', variant: 'Full', price_dine_in: '2100' }),
  ];

  it('creates categories (once), items, variants and prices for an empty menu', () => {
    const plan = planMenuImport(parse(rows), empty, DATE);
    expect(plan.errors).toEqual([]);
    expect(plan.summary).toMatchObject({
      categoriesCreated: 1,
      itemsCreated: 2,
      variantsCreated: 3,
      pricesSet: 4,
    });
    expect(plan.ops.filter((o) => o.type === 'createCategory')).toHaveLength(1);
    const defaults = plan.ops
      .filter((o) => o.type === 'createVariant')
      .map((o) => (o.type === 'createVariant' ? o.variant.isDefault : null));
    expect(defaults).toEqual([true, true, false]);
    expect(
      plan.ops
        .filter((o) => o.type === 'setPrice')
        .every((o) => o.type === 'setPrice' && o.mode === 'new' && o.effectiveFrom === DATE),
    ).toBe(true);
  });

  /** Existing menu equal to `rows`, as the DB would report it. */
  const same: ExistingMenu = {
    categories: [{ id: 'c1', name: 'BBQ', nameUr: null, parentId: null }],
    items: [
      {
        id: 'i1',
        code: 'T1',
        name: 'Tikka',
        nameUr: null,
        kind: 'STANDARD',
        categoryId: 'c1',
        stationCode: 'BBQ',
        searchTerms: null,
        isAvailable: true,
        isActive: true,
        variants: [
          {
            id: 'v1',
            name: 'Regular',
            nameUr: null,
            isActive: true,
            prices: [
              {
                listCode: 'DINE_IN',
                pricePaisa: asPaisa(50000),
                effectiveFrom: '2026-01-01',
                effectiveTo: null,
              },
            ],
          },
        ],
      },
      {
        id: 'i2',
        code: 'K1',
        name: 'Karahi',
        nameUr: null,
        kind: 'STANDARD',
        categoryId: 'c1',
        stationCode: null,
        searchTerms: null,
        isAvailable: true,
        isActive: true,
        variants: [
          {
            id: 'v2',
            name: 'Half',
            nameUr: null,
            isActive: true,
            prices: [
              {
                listCode: 'DINE_IN',
                pricePaisa: asPaisa(110000),
                effectiveFrom: '2026-01-01',
                effectiveTo: null,
              },
              {
                listCode: 'DELIVERY',
                pricePaisa: asPaisa(120000),
                effectiveFrom: '2026-01-01',
                effectiveTo: null,
              },
            ],
          },
          {
            id: 'v3',
            name: 'Full',
            nameUr: null,
            isActive: true,
            prices: [
              {
                listCode: 'DINE_IN',
                pricePaisa: asPaisa(210000),
                effectiveFrom: '2026-01-01',
                effectiveTo: null,
              },
            ],
          },
        ],
      },
    ],
  };

  it('is idempotent: importing the same file again plans nothing', () => {
    const plan = planMenuImport(parse(rows), same, DATE);
    expect(plan.errors).toEqual([]);
    expect(plan.ops).toEqual([]);
    expect(plan.summary).toMatchObject({
      itemsCreated: 0,
      itemsUpdated: 0,
      itemsUnchanged: 2,
      variantsCreated: 0,
      pricesSet: 0,
      pricesUnchanged: 4,
    });
  });

  it('closes the old price period and starts a new one when a price changes', () => {
    const changed = rows.map((r) => (r.item_code === 'T1' ? { ...r, price_dine_in: '550' } : r));
    const plan = planMenuImport(parse(changed), same, DATE);
    expect(plan.ops).toEqual([
      {
        type: 'setPrice',
        itemCode: 'T1',
        variantName: 'Regular',
        listCode: 'DINE_IN',
        pricePaisa: 55000,
        effectiveFrom: DATE,
        mode: 'close_and_new',
        closePreviousTo: '2026-07-31',
      },
    ]);
    expect(plan.summary).toMatchObject({ pricesSet: 1, pricesUnchanged: 3, itemsUnchanged: 1 });
  });

  it('corrects a price in place when it was already set today', () => {
    const today: ExistingMenu = {
      ...same,
      items: same.items.map((i) =>
        i.code === 'T1'
          ? {
              ...i,
              variants: [
                {
                  ...i.variants[0]!,
                  prices: [
                    {
                      listCode: 'DINE_IN',
                      pricePaisa: asPaisa(40000),
                      effectiveFrom: DATE,
                      effectiveTo: null,
                    },
                  ],
                },
              ],
            }
          : i,
      ),
    };
    const plan = planMenuImport(parse(rows), today, DATE);
    expect(plan.ops).toEqual([
      expect.objectContaining({
        type: 'setPrice',
        itemCode: 'T1',
        mode: 'same_day_update',
        pricePaisa: 50000,
      }),
    ]);
  });

  it('adds a price for a channel that had none, and never removes prices missing from the file', () => {
    const plan = planMenuImport(
      parse([rec({ item_code: 'T1', item_name: 'Tikka', price_takeaway: '480' })]),
      same,
      DATE,
    );
    expect(plan.ops).toEqual([
      expect.objectContaining({ type: 'setPrice', listCode: 'TAKEAWAY', mode: 'new' }),
    ]);
  });

  it('refuses to touch a variant that has a future-dated price', () => {
    const future: ExistingMenu = {
      ...same,
      items: same.items.map((i) =>
        i.code === 'T1'
          ? {
              ...i,
              variants: [
                {
                  ...i.variants[0]!,
                  prices: [
                    {
                      listCode: 'DINE_IN',
                      pricePaisa: asPaisa(50000),
                      effectiveFrom: '2026-01-01',
                      effectiveTo: '2026-08-31',
                    },
                    {
                      listCode: 'DINE_IN',
                      pricePaisa: asPaisa(60000),
                      effectiveFrom: '2026-09-01',
                      effectiveTo: null,
                    },
                  ],
                },
              ],
            }
          : i,
      ),
    };
    const plan = planMenuImport(parse(rows), future, DATE);
    expect(plan.ops).toEqual([]);
    expect(plan.errors[0]!.message).toContain('future-dated price');
  });

  it('updates changed item fields and Urdu names; blank cells leave values unchanged', () => {
    const edit = [
      rec({
        item_code: 'T1',
        item_name: 'Chicken Tikka',
        item_name_ur: 'تکہ',
        station: 'tandoor',
        search_terms: 'tikka tika',
        available: 'no',
        category: 'Grill',
        category_ur: 'گرل',
        price_dine_in: '500',
      }),
    ];
    const plan = planMenuImport(parse(edit), same, DATE);
    expect(plan.ops).toEqual([
      { type: 'createCategory', name: 'Grill', nameUr: 'گرل' },
      {
        type: 'updateItem',
        code: 'T1',
        changes: {
          name: 'Chicken Tikka',
          nameUr: 'تکہ',
          stationCode: 'TANDOOR',
          searchTerms: 'tikka tika',
          isAvailable: false,
          categoryName: 'Grill',
        },
      },
    ]);
    const blank = planMenuImport(parse([rec({ item_code: 'T1', item_name: 'Tikka' })]), same, DATE);
    expect(blank.ops).toEqual([]);
  });

  it('updates the Urdu name of an existing category and detects a category move', () => {
    const plan = planMenuImport(
      parse([
        rec({ item_code: 'T1', item_name: 'Tikka', category: 'bbq', category_ur: 'بی بی کیو' }),
      ]),
      same,
      DATE,
    );
    expect(plan.ops).toEqual([{ type: 'updateCategory', name: 'BBQ', nameUr: 'بی بی کیو' }]);
    const moved: ExistingMenu = {
      ...same,
      categories: [...same.categories, { id: 'c2', name: 'Karahi', nameUr: null, parentId: null }],
    };
    const mv = planMenuImport(
      parse([rec({ item_code: 'T1', item_name: 'Tikka', category: 'Karahi' })]),
      moved,
      DATE,
    );
    expect(mv.ops).toEqual([
      { type: 'updateItem', code: 'T1', changes: { categoryName: 'Karahi' } },
    ]);
  });

  it('adds a new variant to an existing item (not default) and updates variant Urdu names', () => {
    const plan = planMenuImport(
      parse([
        rec({ item_code: 'K1', item_name: 'Karahi', variant: 'half', variant_ur: 'آدھا' }),
        rec({ item_code: 'K1', item_name: 'Karahi', variant: 'Family', price_dine_in: '4000' }),
      ]),
      same,
      DATE,
    );
    expect(plan.ops).toEqual([
      { type: 'updateVariant', itemCode: 'K1', variantName: 'Half', changes: { nameUr: 'آدھا' } },
      {
        type: 'createVariant',
        itemCode: 'K1',
        variant: { name: 'Family', nameUr: null, isDefault: false },
      },
      {
        type: 'setPrice',
        itemCode: 'K1',
        variantName: 'Family',
        listCode: 'DINE_IN',
        pricePaisa: 400000,
        effectiveFrom: DATE,
        mode: 'new',
      },
    ]);
  });

  it('reactivates deactivated items and variants with a warning', () => {
    const off: ExistingMenu = {
      ...same,
      items: same.items.map((i) =>
        i.code === 'T1'
          ? { ...i, isActive: false, variants: [{ ...i.variants[0]!, isActive: false }] }
          : i,
      ),
    };
    const plan = planMenuImport(parse(rows), off, DATE);
    expect(plan.ops).toEqual([
      { type: 'updateItem', code: 'T1', changes: { reactivate: true } },
      {
        type: 'updateVariant',
        itemCode: 'T1',
        variantName: 'Regular',
        changes: { reactivate: true },
      },
    ]);
    expect(plan.warnings).toHaveLength(2);
  });

  it('blocks kind changes and edits to deals; an error cancels the whole plan', () => {
    const deal: ExistingMenu = {
      ...same,
      items: [
        ...same.items,
        { ...same.items[0]!, id: 'i9', code: 'D1', kind: 'DEAL', name: 'Family Deal' },
      ],
    };
    const plan = planMenuImport(
      parse([
        ...rows.map((r) => (r.item_code === 'T1' ? { ...r, kind: 'WEIGHT' } : r)),
        rec({ item_code: 'D1', item_name: 'Family Deal' }),
      ]),
      deal,
      DATE,
    );
    expect(plan.ops).toEqual([]);
    expect(plan.errors.map((e) => e.message)).toEqual([
      expect.stringContaining('kind cannot change'),
      expect.stringContaining('D1 is a DEAL'),
    ]);
  });

  it('creates a missing category once even when several items use it (case-insensitive)', () => {
    const plan = planMenuImport(
      parse([
        rec({ item_code: 'A', item_name: 'A', category: 'Drinks' }),
        rec({ item_code: 'B', item_name: 'B', category: 'drinks' }),
      ]),
      empty,
      DATE,
    );
    expect(plan.summary.categoriesCreated).toBe(1);
  });

  it('only top-level categories are matched; a nested category of the same name is not reused', () => {
    const nested: ExistingMenu = {
      categories: [
        { id: 'p', name: 'BBQ', nameUr: null, parentId: null },
        { id: 'n', name: 'Tikka', nameUr: null, parentId: 'p' },
      ],
      items: [],
    };
    const plan = planMenuImport(
      parse([rec({ item_code: 'A', item_name: 'A', category: 'Tikka' })]),
      nested,
      DATE,
    );
    expect(plan.summary.categoriesCreated).toBe(1);
  });
});
