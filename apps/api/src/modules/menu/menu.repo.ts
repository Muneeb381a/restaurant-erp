import { sql } from 'kysely';
import { AppError } from '../../http/errors';
import type { Queryable } from '../../shared/tx';

/** Branch-scoped lookups shared by the menu service, read model and import. */

export async function requireItem(q: Queryable, branchId: string, id: string, lock = false) {
  let query = q
    .selectFrom('items')
    .selectAll()
    .where('id', '=', id)
    .where('branch_id', '=', branchId);
  if (lock) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  if (!row) throw new AppError(404, 'NOT_FOUND', 'item not found');
  return row;
}

export async function requireVariant(q: Queryable, branchId: string, id: string, lock = false) {
  let query = q
    .selectFrom('item_variants')
    .innerJoin('items', 'items.id', 'item_variants.item_id')
    .selectAll('item_variants')
    .select(['items.kind as item_kind', 'items.branch_id as branch_id'])
    .where('item_variants.id', '=', id)
    .where('items.branch_id', '=', branchId);
  if (lock) query = query.forUpdate('item_variants');
  const row = await query.executeTakeFirst();
  if (!row) throw new AppError(404, 'NOT_FOUND', 'variant not found');
  return row;
}

export async function requireCategory(q: Queryable, branchId: string, id: string, lock = false) {
  let query = q
    .selectFrom('categories')
    .selectAll()
    .where('id', '=', id)
    .where('branch_id', '=', branchId);
  if (lock) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  if (!row) throw new AppError(404, 'NOT_FOUND', 'category not found');
  return row;
}

export async function requireStation(q: Queryable, branchId: string, id: string) {
  const row = await q
    .selectFrom('stations')
    .select('id')
    .where('id', '=', id)
    .where('branch_id', '=', branchId)
    .executeTakeFirst();
  if (!row)
    throw new AppError(400, 'VALIDATION_FAILED', 'stationId does not belong to this branch');
  return row;
}

export async function requirePriceList(q: Queryable, branchId: string, id: string) {
  const row = await q
    .selectFrom('price_lists')
    .selectAll()
    .where('id', '=', id)
    .where('branch_id', '=', branchId)
    .executeTakeFirst();
  if (!row) throw new AppError(404, 'NOT_FOUND', 'price list not found');
  return row;
}

export async function requireModifierGroup(
  q: Queryable,
  branchId: string,
  id: string,
  lock = false,
) {
  let query = q
    .selectFrom('modifier_groups')
    .selectAll()
    .where('id', '=', id)
    .where('branch_id', '=', branchId);
  if (lock) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  if (!row) throw new AppError(404, 'NOT_FOUND', 'modifier group not found');
  return row;
}

export async function taxCategoryIdByCode(q: Queryable, code: string): Promise<string> {
  const row = await q
    .selectFrom('tax_categories')
    .select('id')
    .where('code', '=', code)
    .executeTakeFirst();
  if (!row) throw new AppError(400, 'VALIDATION_FAILED', `Unknown tax category "${code}"`);
  return row.id;
}

/** `YYYY-MM-DD` of the open business day, else today in the branch's timezone. */
export async function currentBusinessDate(
  q: Queryable,
  branchId: string,
  now: Date,
): Promise<string> {
  const day = await q
    .selectFrom('business_days')
    .select('business_date')
    .where('branch_id', '=', branchId)
    .where('status', '=', 'OPEN')
    .executeTakeFirst();
  if (day) return day.business_date;
  const branch = await q
    .selectFrom('branches')
    .select('timezone')
    .where('id', '=', branchId)
    .executeTakeFirstOrThrow();
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: branch.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** The complete admin view of one item: variants with all price rows, modifier groups, deal. */
export async function getItemFull(q: Queryable, branchId: string, itemId: string) {
  const item = await requireItem(q, branchId, itemId);
  const variants = await q
    .selectFrom('item_variants')
    .selectAll()
    .where('item_id', '=', itemId)
    .where('archived_at', 'is', null)
    .orderBy('sort')
    .orderBy('name')
    .execute();
  const prices = variants.length
    ? await q
        .selectFrom('item_prices')
        .innerJoin('price_lists', 'price_lists.id', 'item_prices.price_list_id')
        .select([
          'item_prices.id as id',
          'item_prices.variant_id as variant_id',
          'item_prices.price_list_id as price_list_id',
          'price_lists.code as price_list_code',
          'item_prices.price_paisa as price_paisa',
          'item_prices.effective_from as effective_from',
          'item_prices.effective_to as effective_to',
        ])
        .where(
          'item_prices.variant_id',
          'in',
          variants.map((v) => v.id),
        )
        .orderBy('price_lists.code')
        .orderBy('item_prices.effective_from')
        .execute()
    : [];
  const groups = await q
    .selectFrom('item_modifier_groups')
    .innerJoin('modifier_groups', 'modifier_groups.id', 'item_modifier_groups.group_id')
    .select([
      'modifier_groups.id as id',
      'modifier_groups.code as code',
      'modifier_groups.name as name',
      'item_modifier_groups.sort as sort',
    ])
    .where('item_modifier_groups.item_id', '=', itemId)
    .orderBy('item_modifier_groups.sort')
    .execute();

  let deal: { slots: unknown[] } | null = null;
  if (item.kind === 'DEAL') {
    const slots = await q
      .selectFrom('deal_slots')
      .selectAll()
      .where('deal_item_id', '=', itemId)
      .orderBy('sort')
      .execute();
    const options = slots.length
      ? await q
          .selectFrom('deal_slot_options')
          .selectAll()
          .where(
            'slot_id',
            'in',
            slots.map((s) => s.id),
          )
          .execute()
      : [];
    deal = {
      slots: slots.map((s) => ({
        id: s.id,
        name: s.name,
        qty: s.qty,
        sort: s.sort,
        options: options
          .filter((o) => o.slot_id === s.id)
          .map((o) => ({
            id: o.id,
            variantId: o.variant_id,
            priceDeltaPaisa: o.price_delta_paisa,
            isDefault: o.is_default,
          })),
      })),
    };
  }

  return {
    id: item.id,
    code: item.code,
    name: item.name,
    nameUr: item.name_ur,
    kind: item.kind,
    categoryId: item.category_id,
    stationId: item.station_id,
    taxCategoryId: item.tax_category_id,
    isAvailable: item.is_available,
    isActive: item.is_active,
    sort: item.sort,
    searchTerms: item.search_terms,
    description: item.description,
    descriptionUr: item.description_ur,
    hiddenFromGuests: item.hidden_from_guests,
    guestTags: item.guest_tags,
    allergens: item.allergens,
    variants: variants.map((v) => ({
      id: v.id,
      name: v.name,
      nameUr: v.name_ur,
      sort: v.sort,
      isDefault: v.is_default,
      isActive: v.is_active,
      prices: prices
        .filter((p) => p.variant_id === v.id)
        .map((p) => ({
          id: p.id,
          priceListId: p.price_list_id,
          priceListCode: p.price_list_code,
          pricePaisa: p.price_paisa,
          effectiveFrom: p.effective_from,
          effectiveTo: p.effective_to,
        })),
    })),
    modifierGroups: groups.map((g) => ({ id: g.id, code: g.code, name: g.name })),
    deal,
  };
}

export const lower = (column: string) => sql<string>`lower(${sql.ref(column)})`;
