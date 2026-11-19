import {
  asPaisa,
  formatPaisa,
  parseMenuRecords,
  planMenuImport,
  validateHeaders,
  type ExistingMenu,
  type ImportOp,
  type ImportPlan,
  type ImportSummary,
  type RowError,
} from '@erp/domain';
import type { AppContext } from '../../http/context';
import { AppError } from '../../http/errors';
import { withTx, type Queryable } from '../../shared/tx';
import { writeAudit } from '../audit/audit.service';
import { parseCsv, toCsv } from './csv';
import { currentBusinessDate, taxCategoryIdByCode } from './menu.repo';
import type { Actor } from './menu.service';

const DEFAULT_TAX_CATEGORY = 'RESTAURANT_SERVICE';

export interface ImportResult {
  dryRun: boolean;
  ok: boolean;
  effectiveFrom: string;
  summary: ImportSummary;
  warnings: string[];
  errors: RowError[];
}

async function loadContext(q: Queryable, branchId: string) {
  const [lists, stations, taxes] = await Promise.all([
    q.selectFrom('price_lists').select(['id', 'code']).where('branch_id', '=', branchId).execute(),
    q
      .selectFrom('stations')
      .select(['id', 'code'])
      .where('branch_id', '=', branchId)
      .where('archived_at', 'is', null)
      .execute(),
    q.selectFrom('tax_categories').select(['id', 'code']).execute(),
  ]);
  return { lists, stations, taxes };
}

async function loadExisting(q: Queryable, branchId: string): Promise<ExistingMenu> {
  const [categories, items, stations, lists] = await Promise.all([
    q.selectFrom('categories').selectAll().where('branch_id', '=', branchId).execute(),
    q
      .selectFrom('items')
      .selectAll()
      .where('branch_id', '=', branchId)
      .where('archived_at', 'is', null)
      .where('code', 'is not', null)
      .execute(),
    q
      .selectFrom('stations')
      .select(['id', 'code'])
      .where('branch_id', '=', branchId)
      .where('archived_at', 'is', null)
      .execute(),
    q.selectFrom('price_lists').select(['id', 'code']).where('branch_id', '=', branchId).execute(),
  ]);
  const itemIds = items.map((i) => i.id);
  const variants = itemIds.length
    ? await q.selectFrom('item_variants').selectAll().where('item_id', 'in', itemIds).execute()
    : [];
  const prices = variants.length
    ? await q
        .selectFrom('item_prices')
        .selectAll()
        .where(
          'variant_id',
          'in',
          variants.map((v) => v.id),
        )
        .execute()
    : [];
  const stationCode = new Map(stations.map((s) => [s.id, s.code]));
  const listCode = new Map(lists.map((l) => [l.id, l.code.toUpperCase()]));
  return {
    categories: categories.map((c) => ({
      id: c.id,
      name: c.name,
      nameUr: c.name_ur,
      parentId: c.parent_id,
    })),
    items: items.map((i) => ({
      id: i.id,
      code: i.code as string,
      name: i.name,
      nameUr: i.name_ur,
      kind: i.kind as 'STANDARD' | 'WEIGHT' | 'DEAL',
      categoryId: i.category_id,
      stationCode: i.station_id ? (stationCode.get(i.station_id) ?? null) : null,
      searchTerms: i.search_terms,
      isAvailable: i.is_available,
      isActive: i.is_active,
      variants: variants
        .filter((v) => v.item_id === i.id)
        .map((v) => ({
          id: v.id,
          name: v.name,
          nameUr: v.name_ur,
          isActive: v.is_active,
          prices: prices
            .filter((p) => p.variant_id === v.id)
            .map((p) => ({
              listCode: listCode.get(p.price_list_id) ?? '?',
              pricePaisa: asPaisa(p.price_paisa),
              effectiveFrom: p.effective_from,
              effectiveTo: p.effective_to,
            })),
        })),
    })),
  };
}

async function plan(
  ctx: AppContext,
  q: Queryable,
  a: Actor,
  csv: string,
  effectiveFrom: string,
): Promise<ImportPlan> {
  const { headers, records } = parseCsv(csv);
  const c = await loadContext(q, a.branchId);
  const importCtx = {
    priceListCodes: c.lists.map((l) => l.code),
    stationCodes: c.stations.map((s) => s.code),
    taxCategoryCodes: c.taxes.map((t) => t.code),
  };
  const headerErrors = validateHeaders(headers, importCtx);
  const empty: ImportSummary = {
    categoriesCreated: 0,
    itemsCreated: 0,
    itemsUpdated: 0,
    itemsUnchanged: 0,
    variantsCreated: 0,
    variantsUpdated: 0,
    pricesSet: 0,
    pricesUnchanged: 0,
  };
  if (headerErrors.length) return { ops: [], summary: empty, warnings: [], errors: headerErrors };
  if (records.length === 0)
    return {
      ops: [],
      summary: empty,
      warnings: [],
      errors: [{ line: 1, message: 'The file has a header but no rows' }],
    };

  const parsed = parseMenuRecords(records, importCtx);
  if (parsed.errors.length)
    return { ops: [], summary: empty, warnings: parsed.warnings, errors: parsed.errors };
  const existing = await loadExisting(q, a.branchId);
  const p = planMenuImport(parsed.items, existing, effectiveFrom);
  return { ...p, warnings: [...parsed.warnings, ...p.warnings] };
}

/**
 * `dryRun` validates and reports what WOULD change. A real run applies everything in ONE
 * transaction or nothing. Importing the same file twice changes nothing the second time.
 * Imports never delete anything and never touch deals.
 */
export async function importMenu(
  ctx: AppContext,
  a: Actor,
  csv: string,
  opts: { dryRun: boolean; effectiveFrom?: string | undefined },
): Promise<ImportResult> {
  const today = await currentBusinessDate(ctx.db, a.branchId, ctx.clock.now());
  const effectiveFrom = opts.effectiveFrom ?? today;
  if (effectiveFrom < today)
    throw new AppError(
      400,
      'VALIDATION_FAILED',
      `effectiveFrom ${effectiveFrom} is in the past (today is ${today})`,
    );

  if (opts.dryRun) {
    const p = await plan(ctx, ctx.db, a, csv, effectiveFrom);
    return {
      dryRun: true,
      ok: p.errors.length === 0,
      effectiveFrom,
      summary: p.summary,
      warnings: p.warnings,
      errors: p.errors,
    };
  }

  const result = await withTx(ctx.db, async (trx) => {
    const p = await plan(ctx, trx, a, csv, effectiveFrom);
    if (p.errors.length) {
      throw new AppError(
        400,
        'VALIDATION_FAILED',
        `Import rejected: ${p.errors.length} problem(s); nothing was changed`,
        { errors: p.errors, warnings: p.warnings },
      );
    }
    const priceChanges = await applyOps(trx, a, p.ops);
    await writeAudit(trx, {
      branchId: a.branchId,
      userId: a.userId,
      deviceId: a.deviceId,
      action: 'MENU_IMPORT',
      entity: 'menu',
      after: {
        effectiveFrom,
        summary: p.summary,
        warnings: p.warnings.length,
        priceChanges: priceChanges.slice(0, 200),
      },
      ip: a.ip,
    });
    return p;
  });
  ctx.menu.bump(a.branchId);
  return {
    dryRun: false,
    ok: true,
    effectiveFrom,
    summary: result.summary,
    warnings: result.warnings,
    errors: [],
  };
}

async function applyOps(trx: Queryable, a: Actor, ops: readonly ImportOp[]): Promise<unknown[]> {
  const c = await loadContext(trx, a.branchId);
  const stationId = new Map(c.stations.map((s) => [s.code.toUpperCase(), s.id]));
  const listId = new Map(c.lists.map((l) => [l.code.toUpperCase(), l.id]));
  const cats = await trx
    .selectFrom('categories')
    .select(['id', 'name'])
    .where('branch_id', '=', a.branchId)
    .where('parent_id', 'is', null)
    .execute();
  const categoryId = new Map(cats.map((x) => [x.name.toLowerCase(), x.id]));
  const items = await trx
    .selectFrom('items')
    .select(['id', 'code'])
    .where('branch_id', '=', a.branchId)
    .where('archived_at', 'is', null)
    .where('code', 'is not', null)
    .execute();
  const itemId = new Map(items.map((i) => [i.code as string, i.id]));
  const vs = items.length
    ? await trx
        .selectFrom('item_variants')
        .select(['id', 'item_id', 'name'])
        .where(
          'item_id',
          'in',
          items.map((i) => i.id),
        )
        .execute()
    : [];
  const variantId = new Map(vs.map((v) => [`${v.item_id}|${v.name.toLowerCase()}`, v.id]));

  const need = <T>(v: T | undefined, what: string): T => {
    if (v === undefined)
      throw new AppError(500, 'INTERNAL_ERROR', `import plan referenced unknown ${what}`);
    return v;
  };
  const changes: unknown[] = [];
  // Keep file order: new items sort after existing ones; variants sort within their item.
  const maxSort = await trx
    .selectFrom('items')
    .select((eb) => eb.fn.max('sort').as('m'))
    .where('branch_id', '=', a.branchId)
    .executeTakeFirst();
  let itemSort = (maxSort?.m ?? -1) + 1;
  const variantSort = new Map<string, number>();
  // one lookup per tax category code for the whole import, not one per item
  const taxIds = new Map<string, string>();
  const taxId = async (code: string): Promise<string> => {
    let id = taxIds.get(code);
    if (id === undefined) {
      id = await taxCategoryIdByCode(trx, code);
      taxIds.set(code, id);
    }
    return id;
  };
  for (const v of vs) variantSort.set(v.item_id, (variantSort.get(v.item_id) ?? 0) + 1);

  for (const op of ops) {
    switch (op.type) {
      case 'createCategory': {
        const row = await trx
          .insertInto('categories')
          .values({ branch_id: a.branchId, name: op.name, name_ur: op.nameUr })
          .returning('id')
          .executeTakeFirstOrThrow();
        categoryId.set(op.name.toLowerCase(), row.id);
        break;
      }
      case 'updateCategory':
        await trx
          .updateTable('categories')
          .set({ name_ur: op.nameUr })
          .where('id', '=', need(categoryId.get(op.name.toLowerCase()), 'category'))
          .execute();
        break;
      case 'createItem': {
        const it = op.item;
        const row = await trx
          .insertInto('items')
          .values({
            branch_id: a.branchId,
            code: it.code,
            name: it.name,
            name_ur: it.nameUr,
            kind: it.kind,
            category_id: it.categoryName
              ? need(categoryId.get(it.categoryName.toLowerCase()), 'category')
              : null,
            station_id: it.stationCode
              ? need(stationId.get(it.stationCode.toUpperCase()), 'station')
              : null,
            tax_category_id: await taxId(it.taxCategoryCode ?? DEFAULT_TAX_CATEGORY),
            search_terms: it.searchTerms,
            is_available: it.available ?? true,
            sort: itemSort++,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        itemId.set(it.code, row.id);
        break;
      }
      case 'updateItem': {
        const ch = op.changes;
        await trx
          .updateTable('items')
          .set({
            ...(ch.name !== undefined && { name: ch.name }),
            ...(ch.nameUr !== undefined && { name_ur: ch.nameUr }),
            ...(ch.searchTerms !== undefined && { search_terms: ch.searchTerms }),
            ...(ch.isAvailable !== undefined && { is_available: ch.isAvailable }),
            ...(ch.reactivate && { is_active: true }),
            ...(ch.stationCode !== undefined && {
              station_id: need(stationId.get(ch.stationCode.toUpperCase()), 'station'),
            }),
            ...(ch.categoryName !== undefined && {
              category_id: need(categoryId.get(ch.categoryName.toLowerCase()), 'category'),
            }),
          })
          .where('id', '=', need(itemId.get(op.code), 'item'))
          .execute();
        break;
      }
      case 'createVariant': {
        const iid = need(itemId.get(op.itemCode), 'item');
        const row = await trx
          .insertInto('item_variants')
          .values({
            item_id: iid,
            sort: variantSort.get(iid) ?? 0,
            name: op.variant.name,
            name_ur: op.variant.nameUr,
            is_default: op.variant.isDefault,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        variantId.set(`${iid}|${op.variant.name.toLowerCase()}`, row.id);
        variantSort.set(iid, (variantSort.get(iid) ?? 0) + 1);
        break;
      }
      case 'updateVariant': {
        const vid = need(
          variantId.get(`${need(itemId.get(op.itemCode), 'item')}|${op.variantName.toLowerCase()}`),
          'variant',
        );
        await trx
          .updateTable('item_variants')
          .set({
            ...(op.changes.nameUr !== undefined && { name_ur: op.changes.nameUr }),
            ...(op.changes.reactivate && { is_active: true }),
          })
          .where('id', '=', vid)
          .execute();
        break;
      }
      case 'setPrice': {
        const vid = need(
          variantId.get(`${need(itemId.get(op.itemCode), 'item')}|${op.variantName.toLowerCase()}`),
          'variant',
        );
        const lid = need(listId.get(op.listCode.toUpperCase()), 'price list');
        if (op.mode !== 'new') {
          const active = await trx
            .selectFrom('item_prices')
            .select(['id', 'effective_to'])
            .where('variant_id', '=', vid)
            .where('price_list_id', '=', lid)
            .where('effective_from', '<=', op.effectiveFrom)
            .where((eb) =>
              eb.or([eb('effective_to', 'is', null), eb('effective_to', '>=', op.effectiveFrom)]),
            )
            .forUpdate()
            .executeTakeFirstOrThrow();
          if (op.mode === 'same_day_update') {
            await trx
              .updateTable('item_prices')
              .set({ price_paisa: op.pricePaisa })
              .where('id', '=', active.id)
              .execute();
          } else {
            await trx
              .updateTable('item_prices')
              .set({ effective_to: op.closePreviousTo as string })
              .where('id', '=', active.id)
              .execute();
            await trx
              .insertInto('item_prices')
              .values({
                variant_id: vid,
                price_list_id: lid,
                price_paisa: op.pricePaisa,
                effective_from: op.effectiveFrom,
                effective_to: active.effective_to,
              })
              .execute();
          }
        } else {
          await trx
            .insertInto('item_prices')
            .values({
              variant_id: vid,
              price_list_id: lid,
              price_paisa: op.pricePaisa,
              effective_from: op.effectiveFrom,
            })
            .execute();
        }
        changes.push({
          item: op.itemCode,
          variant: op.variantName,
          list: op.listCode,
          pricePaisa: op.pricePaisa,
          mode: op.mode,
        });
        break;
      }
    }
  }
  return changes;
}

const EXPORT_BASE = [
  'category',
  'category_ur',
  'item_code',
  'item_name',
  'item_name_ur',
  'kind',
  'station',
  'tax_category',
  'variant',
  'variant_ur',
];

/** Current menu as CSV (UTF-8 with BOM so Excel shows Urdu). Re-importing it changes nothing. */
export async function exportMenuCsv(
  ctx: AppContext,
  branchId: string,
  date?: string,
): Promise<string> {
  const { db } = ctx;
  const day = date ?? (await currentBusinessDate(db, branchId, ctx.clock.now()));
  const [lists, categories, stations, taxes, items] = await Promise.all([
    db
      .selectFrom('price_lists')
      .select(['id', 'code'])
      .where('branch_id', '=', branchId)
      .orderBy('code')
      .execute(),
    db.selectFrom('categories').selectAll().where('branch_id', '=', branchId).execute(),
    db
      .selectFrom('stations')
      .select(['id', 'code'])
      .where('branch_id', '=', branchId)
      .where('archived_at', 'is', null)
      .execute(),
    db.selectFrom('tax_categories').select(['id', 'code']).execute(),
    db
      .selectFrom('items')
      .selectAll()
      .where('branch_id', '=', branchId)
      .where('is_active', '=', true)
      .where('code', 'is not', null)
      .where('kind', '!=', 'DEAL')
      .orderBy('sort')
      .orderBy('name')
      .execute(),
  ]);
  const ids = items.map((i) => i.id);
  const variants = ids.length
    ? await db
        .selectFrom('item_variants')
        .selectAll()
        .where('item_id', 'in', ids)
        .where('is_active', '=', true)
        .orderBy('sort')
        .orderBy('name')
        .execute()
    : [];
  const prices = variants.length
    ? await db
        .selectFrom('item_prices')
        .select(['variant_id', 'price_list_id', 'price_paisa'])
        .where(
          'variant_id',
          'in',
          variants.map((v) => v.id),
        )
        .where('effective_from', '<=', day)
        .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>=', day)]))
        .execute()
    : [];
  const priceOf = new Map(prices.map((p) => [`${p.variant_id}|${p.price_list_id}`, p.price_paisa]));
  const cat = new Map(categories.map((c) => [c.id, c]));
  const stationCode = new Map(stations.map((s) => [s.id, s.code]));
  const taxCode = new Map(taxes.map((t) => [t.id, t.code]));

  const header = [
    ...EXPORT_BASE,
    ...lists.map((l) => `price_${l.code.toLowerCase()}`),
    'search_terms',
    'available',
  ];
  const rows: string[][] = [header];
  const catSort = (id: string | null): number => (id ? (cat.get(id)?.sort ?? 0) : -1);
  const ordered = [...items].sort((x, y) => catSort(x.category_id) - catSort(y.category_id));
  for (const item of ordered) {
    const c = item.category_id ? cat.get(item.category_id) : undefined;
    for (const v of variants.filter((x) => x.item_id === item.id)) {
      rows.push([
        c?.name ?? '',
        c?.name_ur ?? '',
        item.code ?? '',
        item.name,
        item.name_ur ?? '',
        item.kind,
        item.station_id ? (stationCode.get(item.station_id) ?? '') : '',
        taxCode.get(item.tax_category_id) ?? '',
        v.name,
        v.name_ur ?? '',
        ...lists.map((l) => {
          const p = priceOf.get(`${v.id}|${l.id}`);
          return p === undefined ? '' : formatPaisa(asPaisa(p));
        }),
        item.search_terms ?? '',
        item.is_available ? 'yes' : 'no',
      ]);
    }
  }
  return '﻿' + toCsv(rows);
}
