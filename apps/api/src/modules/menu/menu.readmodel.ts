import { sql } from 'kysely';
import { createHash } from 'node:crypto';
import type { AppContext } from '../../http/context';
import { AppError } from '../../http/errors';
import { currentBusinessDate } from './menu.repo';

export interface MenuQuery {
  branchId: string;
  /** price list code, e.g. DINE_IN; default DINE_IN, else the first list */
  priceList?: string | undefined;
  /** business date YYYY-MM-DD; default = open business day, else today in the branch timezone */
  date?: string | undefined;
}

/**
 * The single payload the POS loads: every active item that has a price in the requested price
 * list on the requested business date, with variants (priced), modifier groups and deal slots.
 * Items without a price on a channel are simply not offered there (docs/OPEN-QUESTIONS #25);
 * `GET /menu/warnings` lists them for the admin. Cached per (branch, list, date) until any menu
 * write bumps the branch revision.
 */
export async function getMenu(
  ctx: AppContext,
  q: MenuQuery,
): Promise<{ etag: string; body: string }> {
  const { db } = ctx;
  const lists = await db
    .selectFrom('price_lists')
    .selectAll()
    .where('branch_id', '=', q.branchId)
    .orderBy('code')
    .execute();
  const list = q.priceList
    ? lists.find((l) => l.code.toLowerCase() === q.priceList!.toLowerCase())
    : (lists.find((l) => l.code === 'DINE_IN') ?? lists[0]);
  if (!list)
    throw new AppError(
      404,
      'NOT_FOUND',
      q.priceList ? `price list ${q.priceList} not found` : 'no price lists configured',
    );

  const date = q.date ?? (await currentBusinessDate(db, q.branchId, ctx.clock.now()));
  const key = `${list.id}|${date}`;
  const cached = ctx.menu.get(q.branchId, key);
  if (cached) return cached;
  const revisionAtRead = ctx.menu.revision(q.branchId);

  const [activeCategories, activeItems, stations] = await Promise.all([
    db
      .selectFrom('categories')
      .selectAll()
      .where('branch_id', '=', q.branchId)
      .where('is_active', '=', true)
      .orderBy('sort')
      .orderBy('name')
      .execute(),
    db
      .selectFrom('items')
      .selectAll()
      .where('branch_id', '=', q.branchId)
      .where('is_active', '=', true)
      .orderBy('sort')
      .orderBy('name')
      .execute(),
    db.selectFrom('stations').select(['id', 'code']).where('branch_id', '=', q.branchId).execute(),
  ]);
  // A category is visible when it and all its ancestors are active; items of hidden categories
  // are hidden with them.
  const byId = new Map(activeCategories.map((c) => [c.id, c]));
  const isVisible = (id: string | null, depth = 0): boolean => {
    if (id === null) return true;
    const c = byId.get(id);
    return !!c && depth < 20 && isVisible(c.parent_id, depth + 1);
  };
  const categories = activeCategories.filter((c) => isVisible(c.id));
  const items = activeItems.filter((i) => isVisible(i.category_id));
  const itemIds = items.map((i) => i.id);
  const stationCode = new Map(stations.map((s) => [s.id, s.code]));

  const variants = itemIds.length
    ? await db
        .selectFrom('item_variants')
        .selectAll()
        .where('item_id', 'in', itemIds)
        .where('is_active', '=', true)
        .orderBy('sort')
        .orderBy('name')
        .execute()
    : [];
  const variantIds = variants.map((v) => v.id);
  const prices = variantIds.length
    ? await db
        .selectFrom('item_prices')
        .select(['variant_id', 'price_paisa'])
        .where('price_list_id', '=', list.id)
        .where('variant_id', 'in', variantIds)
        .where('effective_from', '<=', date)
        .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>=', date)]))
        .execute()
    : [];
  const priceOf = new Map(prices.map((p) => [p.variant_id, p.price_paisa]));

  const images = itemIds.length
    ? await db
        .selectFrom('item_images')
        .select(['item_id', 'updated_at'])
        .where('item_id', 'in', itemIds)
        .execute()
    : [];
  const imageVer = new Map(images.map((i) => [i.item_id, new Date(i.updated_at).getTime()]));

  const groupLinks = itemIds.length
    ? await db
        .selectFrom('item_modifier_groups')
        .innerJoin('modifier_groups', 'modifier_groups.id', 'item_modifier_groups.group_id')
        .select([
          'item_modifier_groups.item_id as item_id',
          'item_modifier_groups.sort as link_sort',
          'modifier_groups.id as id',
          'modifier_groups.code as code',
          'modifier_groups.name as name',
          'modifier_groups.name_ur as name_ur',
          'modifier_groups.min_select as min_select',
          'modifier_groups.max_select as max_select',
        ])
        .where('item_modifier_groups.item_id', 'in', itemIds)
        .orderBy('item_modifier_groups.sort')
        .execute()
    : [];
  const groupIds = [...new Set(groupLinks.map((g) => g.id))];
  const modifiers = groupIds.length
    ? await db
        .selectFrom('modifiers')
        .selectAll()
        .where('group_id', 'in', groupIds)
        .where('is_active', '=', true)
        .orderBy('sort')
        .orderBy('name')
        .execute()
    : [];

  const dealItemIds = items.filter((i) => i.kind === 'DEAL').map((i) => i.id);
  const slots = dealItemIds.length
    ? await db
        .selectFrom('deal_slots')
        .selectAll()
        .where('deal_item_id', 'in', dealItemIds)
        .orderBy('sort')
        .execute()
    : [];
  const options = slots.length
    ? await db
        .selectFrom('deal_slot_options')
        .innerJoin('item_variants', 'item_variants.id', 'deal_slot_options.variant_id')
        .innerJoin('items', 'items.id', 'item_variants.item_id')
        .select([
          'deal_slot_options.id as id',
          'deal_slot_options.slot_id as slot_id',
          'deal_slot_options.variant_id as variant_id',
          'deal_slot_options.price_delta_paisa as price_delta_paisa',
          'deal_slot_options.is_default as is_default',
          'items.id as item_id',
          'items.name as item_name',
          'items.name_ur as item_name_ur',
          'item_variants.item_id as option_item_id',
          'item_variants.name as variant_name',
          'item_variants.name_ur as variant_name_ur',
          'item_variants.is_active as v_active',
          'items.is_active as i_active',
          'items.is_available as i_available',
        ])
        .where(
          'deal_slot_options.slot_id',
          'in',
          slots.map((s) => s.id),
        )
        // stable, meaningful order: default first, then cheaper upcharge, then by name
        .orderBy('deal_slot_options.is_default', 'desc')
        .orderBy('deal_slot_options.price_delta_paisa')
        .orderBy('items.name')
        .orderBy('item_variants.name')
        .execute()
    : [];

  const menuItems = items.flatMap((item) => {
    const vs = variants
      .filter((v) => v.item_id === item.id && priceOf.has(v.id))
      .map((v) => ({
        id: v.id,
        name: v.name,
        nameUr: v.name_ur,
        isDefault: v.is_default,
        pricePaisa: priceOf.get(v.id)!,
      }));
    if (vs.length === 0) return [];
    return [
      {
        id: item.id,
        code: item.code,
        name: item.name,
        nameUr: item.name_ur,
        kind: item.kind,
        categoryId: item.category_id,
        station: item.station_id ? (stationCode.get(item.station_id) ?? null) : null,
        available: item.is_available,
        searchTerms: item.search_terms,
        description: item.description,
        descriptionUr: item.description_ur,
        hiddenFromGuests: item.hidden_from_guests,
        guestTags: item.guest_tags,
        allergens: item.allergens,
        imageVer: imageVer.get(item.id) ?? null,
        variants: vs,
        modifierGroups: groupLinks
          .filter((g) => g.item_id === item.id)
          .map((g) => ({
            id: g.id,
            code: g.code,
            name: g.name,
            nameUr: g.name_ur,
            minSelect: g.min_select,
            maxSelect: g.max_select,
            modifiers: modifiers
              .filter((m) => m.group_id === g.id)
              .map((m) => ({
                id: m.id,
                name: m.name,
                nameUr: m.name_ur,
                priceDeltaPaisa: m.price_delta_paisa,
              })),
          })),
        deal:
          item.kind === 'DEAL'
            ? {
                slots: slots
                  .filter((s) => s.deal_item_id === item.id)
                  .map((s) => ({
                    id: s.id,
                    name: s.name,
                    qty: s.qty,
                    options: options
                      .filter((o) => o.slot_id === s.id && o.v_active && o.i_active)
                      .map((o) => ({
                        id: o.id,
                        variantId: o.variant_id,
                        itemId: o.option_item_id,
                        itemName: o.item_name,
                        itemNameUr: o.item_name_ur,
                        variantName: o.variant_name,
                        variantNameUr: o.variant_name_ur,
                        priceDeltaPaisa: o.price_delta_paisa,
                        isDefault: o.is_default,
                        available: o.i_available,
                      })),
                  })),
              }
            : null,
      },
    ];
  });

  const body = JSON.stringify({
    priceList: list.code,
    date,
    categories: categories.map((c) => ({
      id: c.id,
      parentId: c.parent_id,
      name: c.name,
      nameUr: c.name_ur,
      sort: c.sort,
    })),
    items: menuItems,
  });
  const etag = `W/"${createHash('sha1').update(body).digest('hex').slice(0, 20)}"`;
  const value = { etag, body };
  ctx.menu.set(q.branchId, key, value, revisionAtRead);
  return value;
}

/**
 * Everything the menu admin screen needs in ONE payload: all items (active or not) with every
 * variant's current price per price list (null = not sold on that channel), plus the lookup
 * lists for the edit forms.
 */
export async function getAdminMenu(ctx: AppContext, branchId: string, date?: string) {
  const { db } = ctx;
  const day = date ?? (await currentBusinessDate(db, branchId, ctx.clock.now()));
  const [lists, stations, categories, items] = await Promise.all([
    db
      .selectFrom('price_lists')
      .select(['id', 'code', 'name'])
      .where('branch_id', '=', branchId)
      .orderBy('code')
      .execute(),
    db
      .selectFrom('stations')
      .select(['id', 'code', 'name'])
      .where('branch_id', '=', branchId)
      .where('archived_at', 'is', null)
      .orderBy('code')
      .execute(),
    db
      .selectFrom('categories')
      .selectAll()
      .where('branch_id', '=', branchId)
      .orderBy('sort')
      .orderBy('name')
      .execute(),
    db
      .selectFrom('items')
      .selectAll()
      .where('branch_id', '=', branchId)
      .where('archived_at', 'is', null)
      .orderBy('sort')
      .orderBy('name')
      .execute(),
  ]);
  const ids = items.map((i) => i.id);
  const withImage = new Set(
    ids.length
      ? (
          await db.selectFrom('item_images').select('item_id').where('item_id', 'in', ids).execute()
        ).map((r) => r.item_id)
      : [],
  );
  const variants = ids.length
    ? await db
        .selectFrom('item_variants')
        .selectAll()
        .where('item_id', 'in', ids)
        .where('archived_at', 'is', null)
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
  const listCode = new Map(lists.map((l) => [l.id, l.code]));
  return {
    date: day,
    priceLists: lists,
    stations,
    categories: categories.map((c) => ({
      id: c.id,
      parentId: c.parent_id,
      name: c.name,
      nameUr: c.name_ur,
      isActive: c.is_active,
    })),
    items: items.map((i) => ({
      id: i.id,
      code: i.code,
      name: i.name,
      nameUr: i.name_ur,
      kind: i.kind,
      categoryId: i.category_id,
      stationId: i.station_id,
      isAvailable: i.is_available,
      isActive: i.is_active,
      searchTerms: i.search_terms,
      description: i.description,
      descriptionUr: i.description_ur,
      hiddenFromGuests: i.hidden_from_guests,
      guestTags: i.guest_tags,
      allergens: i.allergens,
      hasImage: withImage.has(i.id),
      variants: variants
        .filter((v) => v.item_id === i.id)
        .map((v) => ({
          id: v.id,
          name: v.name,
          nameUr: v.name_ur,
          isDefault: v.is_default,
          isActive: v.is_active,
          prices: Object.fromEntries(
            lists.map((l) => [
              l.code,
              prices.find((p) => p.variant_id === v.id && listCode.get(p.price_list_id) === l.code)
                ?.price_paisa ?? null,
            ]),
          ),
        })),
    })),
  };
}

/** Admin helper: active items with no price on a channel (they are hidden there). */
export async function getMenuWarnings(ctx: AppContext, branchId: string, date?: string) {
  const { db } = ctx;
  const day = date ?? (await currentBusinessDate(db, branchId, ctx.clock.now()));
  const lists = await db
    .selectFrom('price_lists')
    .select(['id', 'code'])
    .where('branch_id', '=', branchId)
    .orderBy('code')
    .execute();
  const items = await db
    .selectFrom('items')
    .select(['id', 'code', 'name'])
    .where('branch_id', '=', branchId)
    .where('is_active', '=', true)
    .orderBy('name')
    .execute();
  const priced = await db
    .selectFrom('item_prices')
    .innerJoin('item_variants', 'item_variants.id', 'item_prices.variant_id')
    .select(['item_variants.item_id as item_id', 'item_prices.price_list_id as price_list_id'])
    .where('item_variants.is_active', '=', true)
    .where('item_prices.effective_from', '<=', day)
    .where((eb) =>
      eb.or([
        eb('item_prices.effective_to', 'is', null),
        eb('item_prices.effective_to', '>=', day),
      ]),
    )
    .execute();
  const have = new Set(priced.map((p) => `${p.item_id}|${p.price_list_id}`));
  return {
    date: day,
    byPriceList: lists.map((l) => ({
      priceList: l.code,
      itemsWithoutPrice: items
        .filter((i) => !have.has(`${i.id}|${l.id}`))
        .map((i) => ({ id: i.id, code: i.code, name: i.name })),
    })),
    unpricedEverywhere: items
      .filter((i) => lists.every((l) => !have.has(`${i.id}|${l.id}`)))
      .map((i) => ({ id: i.id, code: i.code, name: i.name })),
  };
}

/**
 * Items ordered most often over the last `days` business days (units on lines that were not voided,
 * orders not cancelled), best first. Only the ids and counts: the till already has the menu.
 */
export async function popularItems(
  ctx: AppContext,
  branchId: string,
  days: number,
  limit: number,
): Promise<{ days: number; items: { itemId: string; qty: number }[] }> {
  const r = await sql<{ item_id: string; qty: number }>`
    SELECT oi.item_id, COALESCE(SUM(oi.qty), 0)::float8 AS qty
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN business_days d ON d.id = o.business_day_id
     WHERE o.branch_id = ${branchId} AND o.status <> 'CANCELLED'
       AND oi.status <> 'VOID' AND oi.parent_order_item_id IS NULL AND oi.item_id IS NOT NULL
       AND d.business_date >= (SELECT max(business_date) FROM business_days WHERE branch_id = ${branchId}) - ${days}::int
     GROUP BY oi.item_id
    HAVING COALESCE(SUM(oi.qty), 0) > 0
     ORDER BY 2 DESC, 1
     LIMIT ${limit}`.execute(ctx.db);
  return { days, items: r.rows.map((x) => ({ itemId: x.item_id, qty: x.qty })) };
}
