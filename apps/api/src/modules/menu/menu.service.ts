import { dayBefore, validateDealDefinition, wouldCreateCycle, type Paisa } from '@erp/domain';
import type { AppContext } from '../../http/context';
import { AppError } from '../../http/errors';
import { withTx, type Queryable } from '../../shared/tx';
import { writeAudit } from '../audit/audit.service';
import {
  currentBusinessDate,
  getItemFull,
  requireCategory,
  requireItem,
  requireModifierGroup,
  requirePriceList,
  requireStation,
  requireVariant,
  taxCategoryIdByCode,
} from './menu.repo';

/** Who is acting, for audit rows. */
export interface Actor {
  branchId: string;
  userId: string;
  deviceId: string | null;
  ip?: string | undefined;
}

const DEFAULT_TAX_CATEGORY = 'RESTAURANT_SERVICE';

function audit(
  q: Queryable,
  a: Actor,
  action: string,
  entity: string,
  entityId: string,
  before: unknown,
  after: unknown,
) {
  return writeAudit(q, {
    branchId: a.branchId,
    userId: a.userId,
    deviceId: a.deviceId,
    action,
    entity,
    entityId,
    before,
    after,
    ip: a.ip,
  });
}

/** Runs a menu command in one transaction, then invalidates the POS menu cache. */
async function command<T>(
  ctx: AppContext,
  a: Actor,
  fn: (trx: Queryable) => Promise<T>,
): Promise<T> {
  const result = await withTx(ctx.db, fn);
  ctx.menu.bump(a.branchId);
  return result;
}

const bad = (message: string, extra?: Record<string, unknown>): AppError =>
  new AppError(400, 'VALIDATION_FAILED', message, extra);

// ───────────────────────────── categories ─────────────────────────────

export interface CategoryInput {
  name: string;
  nameUr?: string | null | undefined;
  parentId?: string | null | undefined;
  sort?: number | undefined;
  isActive?: boolean | undefined;
}

export function createCategory(ctx: AppContext, a: Actor, input: CategoryInput) {
  return command(ctx, a, async (trx) => {
    if (input.parentId) await requireCategory(trx, a.branchId, input.parentId);
    const row = await trx
      .insertInto('categories')
      .values({
        branch_id: a.branchId,
        name: input.name,
        name_ur: input.nameUr ?? null,
        parent_id: input.parentId ?? null,
        sort: input.sort ?? 0,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(trx, a, 'CATEGORY_CREATE', 'category', row.id, null, row);
    return row;
  });
}

export function updateCategory(
  ctx: AppContext,
  a: Actor,
  id: string,
  input: Partial<CategoryInput>,
) {
  return command(ctx, a, async (trx) => {
    const before = await requireCategory(trx, a.branchId, id, true);
    if (input.parentId !== undefined) {
      if (input.parentId) await requireCategory(trx, a.branchId, input.parentId);
      const all = await trx
        .selectFrom('categories')
        .select(['id', 'parent_id'])
        .where('branch_id', '=', a.branchId)
        .execute();
      if (
        wouldCreateCycle(
          all.map((c) => ({ id: c.id, parentId: c.parent_id })),
          id,
          input.parentId,
        )
      ) {
        throw bad('A category cannot be moved under itself or one of its sub-categories');
      }
    }
    const row = await trx
      .updateTable('categories')
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.nameUr !== undefined && { name_ur: input.nameUr }),
        ...(input.parentId !== undefined && { parent_id: input.parentId }),
        ...(input.sort !== undefined && { sort: input.sort }),
        ...(input.isActive !== undefined && { is_active: input.isActive }),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(trx, a, 'CATEGORY_UPDATE', 'category', id, before, row);
    return row;
  });
}

// ──────────────────────────────── items ────────────────────────────────

export interface VariantInput {
  name: string;
  nameUr?: string | null | undefined;
  isDefault?: boolean | undefined;
  sort?: number | undefined;
}

export interface ItemInput {
  code?: string | null | undefined;
  name: string;
  nameUr?: string | null | undefined;
  kind: 'STANDARD' | 'WEIGHT' | 'DEAL';
  categoryId?: string | null | undefined;
  stationId?: string | null | undefined;
  searchTerms?: string | null | undefined;
  taxCategoryCode?: string | undefined;
  sort?: number | undefined;
  variants?: VariantInput[] | undefined;
  description?: string | null | undefined;
  descriptionUr?: string | null | undefined;
  hiddenFromGuests?: boolean | undefined;
  guestTags?: string[] | undefined;
  allergens?: string[] | undefined;
}

/** WEIGHT and DEAL items have exactly one variant ("Per kg" / "Deal"); STANDARD at least one. */
function normaliseVariants(
  kind: ItemInput['kind'],
  given: VariantInput[] | undefined,
): VariantInput[] {
  if (kind === 'STANDARD') {
    const list = given && given.length ? given : [{ name: 'Regular' }];
    const defaults = list.filter((v) => v.isDefault).length;
    if (defaults > 1) throw bad('Only one variant can be the default');
    return list.map((v, i) => ({ ...v, isDefault: defaults === 0 ? i === 0 : !!v.isDefault }));
  }
  if (given && given.length > 1) throw bad(`${kind} items have exactly one variant`);
  return [
    {
      name: given?.[0]?.name ?? (kind === 'WEIGHT' ? 'Per kg' : 'Deal'),
      nameUr: given?.[0]?.nameUr,
      isDefault: true,
    },
  ];
}

export function createItem(ctx: AppContext, a: Actor, input: ItemInput) {
  return command(ctx, a, async (trx) => {
    if (input.categoryId) await requireCategory(trx, a.branchId, input.categoryId);
    if (input.stationId) await requireStation(trx, a.branchId, input.stationId);
    const variants = normaliseVariants(input.kind, input.variants);
    const taxCategoryId = await taxCategoryIdByCode(
      trx,
      input.taxCategoryCode ?? DEFAULT_TAX_CATEGORY,
    );

    const item = await trx
      .insertInto('items')
      .values({
        branch_id: a.branchId,
        category_id: input.categoryId ?? null,
        station_id: input.stationId ?? null,
        tax_category_id: taxCategoryId,
        code: input.code ?? null,
        name: input.name,
        name_ur: input.nameUr ?? null,
        kind: input.kind,
        search_terms: input.searchTerms ?? null,
        sort: input.sort ?? 0,
        description: input.description ?? null,
        description_ur: input.descriptionUr ?? null,
        hidden_from_guests: input.hiddenFromGuests ?? false,
        guest_tags: input.guestTags ?? [],
        allergens: input.allergens ?? [],
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const [i, v] of variants.entries()) {
      await trx
        .insertInto('item_variants')
        .values({
          item_id: item.id,
          name: v.name,
          name_ur: v.nameUr ?? null,
          is_default: !!v.isDefault,
          sort: v.sort ?? i,
        })
        .execute();
    }
    const full = await getItemFull(trx, a.branchId, item.id);
    await audit(trx, a, 'ITEM_CREATE', 'item', item.id, null, full);
    return full;
  });
}

export interface ItemPatch {
  code?: string | null | undefined;
  name?: string | undefined;
  nameUr?: string | null | undefined;
  categoryId?: string | null | undefined;
  stationId?: string | null | undefined;
  searchTerms?: string | null | undefined;
  sort?: number | undefined;
  isActive?: boolean | undefined;
  description?: string | null | undefined;
  descriptionUr?: string | null | undefined;
  hiddenFromGuests?: boolean | undefined;
  guestTags?: string[] | undefined;
  allergens?: string[] | undefined;
}

export function updateItem(ctx: AppContext, a: Actor, id: string, p: ItemPatch) {
  return command(ctx, a, async (trx) => {
    const before = await requireItem(trx, a.branchId, id, true);
    if (p.categoryId) await requireCategory(trx, a.branchId, p.categoryId);
    if (p.stationId) await requireStation(trx, a.branchId, p.stationId);
    await trx
      .updateTable('items')
      .set({
        ...(p.code !== undefined && { code: p.code }),
        ...(p.name !== undefined && { name: p.name }),
        ...(p.nameUr !== undefined && { name_ur: p.nameUr }),
        ...(p.categoryId !== undefined && { category_id: p.categoryId }),
        ...(p.stationId !== undefined && { station_id: p.stationId }),
        ...(p.searchTerms !== undefined && { search_terms: p.searchTerms }),
        ...(p.sort !== undefined && { sort: p.sort }),
        ...(p.isActive !== undefined && { is_active: p.isActive }),
        ...(p.description !== undefined && { description: p.description }),
        ...(p.descriptionUr !== undefined && { description_ur: p.descriptionUr }),
        ...(p.hiddenFromGuests !== undefined && { hidden_from_guests: p.hiddenFromGuests }),
        ...(p.guestTags !== undefined && { guest_tags: [...new Set(p.guestTags)] }),
        ...(p.allergens !== undefined && { allergens: [...new Set(p.allergens)] }),
      })
      .where('id', '=', id)
      .execute();
    const after = await requireItem(trx, a.branchId, id);
    await audit(trx, a, 'ITEM_UPDATE', 'item', id, before, after);
    return getItemFull(trx, a.branchId, id);
  });
}

/** Sets (or replaces) the one photo of a dish. The bytes were checked by the route; the audit keeps only the size. */
export function setItemImage(
  ctx: AppContext,
  a: Actor,
  id: string,
  image: { contentType: string; data: Buffer },
) {
  return command(ctx, a, async (trx) => {
    await requireItem(trx, a.branchId, id, true);
    await trx
      .insertInto('item_images')
      .values({ item_id: id, content_type: image.contentType, data: image.data })
      .onConflict((oc) =>
        oc.column('item_id').doUpdateSet({
          content_type: image.contentType,
          data: image.data,
          updated_at: new Date(),
        }),
      )
      .execute();
    await audit(trx, a, 'ITEM_IMAGE_SET', 'item', id, null, {
      contentType: image.contentType,
      bytes: image.data.length,
    });
    return { id, hasImage: true };
  });
}

export function clearItemImage(ctx: AppContext, a: Actor, id: string) {
  return command(ctx, a, async (trx) => {
    await requireItem(trx, a.branchId, id, true);
    await trx.deleteFrom('item_images').where('item_id', '=', id).execute();
    await audit(trx, a, 'ITEM_IMAGE_CLEAR', 'item', id, null, null);
    return { id, hasImage: false };
  });
}

/** The "86" toggle: sold out today. Cheap, frequent and audited. */
export function setAvailability(ctx: AppContext, a: Actor, id: string, isAvailable: boolean) {
  return command(ctx, a, async (trx) => {
    const before = await requireItem(trx, a.branchId, id, true);
    await trx
      .updateTable('items')
      .set({ is_available: isAvailable })
      .where('id', '=', id)
      .execute();
    if (before.is_available !== isAvailable) {
      await audit(
        trx,
        a,
        'ITEM_AVAILABILITY',
        'item',
        id,
        { isAvailable: before.is_available },
        { isAvailable },
      );
    }
    return { id, isAvailable };
  });
}

// ─────────────────────────────── variants ───────────────────────────────

export function createVariant(ctx: AppContext, a: Actor, itemId: string, v: VariantInput) {
  return command(ctx, a, async (trx) => {
    const item = await requireItem(trx, a.branchId, itemId, true);
    if (item.kind !== 'STANDARD') throw bad(`${item.kind} items have exactly one variant`);
    if (v.isDefault)
      await trx
        .updateTable('item_variants')
        .set({ is_default: false })
        .where('item_id', '=', itemId)
        .execute();
    const row = await trx
      .insertInto('item_variants')
      .values({
        item_id: itemId,
        name: v.name,
        name_ur: v.nameUr ?? null,
        is_default: !!v.isDefault,
        sort: v.sort ?? 0,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(trx, a, 'VARIANT_CREATE', 'item_variant', row.id, null, row);
    return row;
  });
}

export interface VariantPatch {
  name?: string | undefined;
  nameUr?: string | null | undefined;
  sort?: number | undefined;
  isDefault?: true | undefined;
  isActive?: boolean | undefined;
}

export function updateVariant(ctx: AppContext, a: Actor, id: string, p: VariantPatch) {
  return command(ctx, a, async (trx) => {
    const before = await requireVariant(trx, a.branchId, id, true);
    if (p.isActive === false && before.is_default)
      throw bad(
        'The default variant cannot be deactivated; make another variant the default first',
      );
    if (p.isDefault) {
      await trx
        .updateTable('item_variants')
        .set({ is_default: false })
        .where('item_id', '=', before.item_id)
        .execute();
    }
    const row = await trx
      .updateTable('item_variants')
      .set({
        ...(p.name !== undefined && { name: p.name }),
        ...(p.nameUr !== undefined && { name_ur: p.nameUr }),
        ...(p.sort !== undefined && { sort: p.sort }),
        ...(p.isDefault && { is_default: true }),
        ...(p.isActive !== undefined && { is_active: p.isActive }),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(trx, a, 'VARIANT_UPDATE', 'item_variant', id, before, row);
    return row;
  });
}

// ──────────────────────────────── prices ────────────────────────────────

export interface SetPriceResult {
  changed: boolean;
  mode: 'unchanged' | 'new' | 'same_day_update' | 'close_and_new';
  variantId: string;
  priceListId: string;
  pricePaisa: Paisa;
  effectiveFrom: string;
}

/**
 * "From <date>, this variant costs X in this price list." History is kept: the running period is
 * closed the day before and a new one opens. Same-day corrections edit today's row. Past dates
 * are refused; a later, already-scheduled price must be resolved first.
 */
export function setPrice(
  ctx: AppContext,
  a: Actor,
  variantId: string,
  priceListId: string,
  pricePaisa: Paisa,
  effectiveFrom?: string,
) {
  return command(ctx, a, async (trx): Promise<SetPriceResult> => {
    const variant = await requireVariant(trx, a.branchId, variantId, true);
    const list = await requirePriceList(trx, a.branchId, priceListId);
    const today = await currentBusinessDate(trx, a.branchId, ctx.clock.now());
    const date = effectiveFrom ?? today;
    if (date < today) throw bad(`effectiveFrom ${date} is in the past (today is ${today})`);

    const rows = await trx
      .selectFrom('item_prices')
      .selectAll()
      .where('variant_id', '=', variantId)
      .where('price_list_id', '=', priceListId)
      .orderBy('effective_from')
      .execute();
    if (rows.some((r) => r.effective_from > date)) {
      throw new AppError(
        409,
        'CONFLICT',
        'A later price is already scheduled for this variant and price list; remove or reschedule it first',
      );
    }
    const active = rows.find(
      (r) => r.effective_from <= date && (r.effective_to === null || r.effective_to >= date),
    );
    const base = { variantId, priceListId, pricePaisa, effectiveFrom: date };
    const meta = { variant: variant.name, priceList: list.code };

    if (active && active.price_paisa === pricePaisa)
      return { ...base, changed: false, mode: 'unchanged' };

    if (!active) {
      const row = await trx
        .insertInto('item_prices')
        .values({
          variant_id: variantId,
          price_list_id: priceListId,
          price_paisa: pricePaisa,
          effective_from: date,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(trx, a, 'PRICE_SET', 'item_price', row.id, null, {
        ...meta,
        pricePaisa,
        effectiveFrom: date,
      });
      return { ...base, changed: true, mode: 'new' };
    }
    if (active.effective_from === date) {
      await trx
        .updateTable('item_prices')
        .set({ price_paisa: pricePaisa })
        .where('id', '=', active.id)
        .execute();
      await audit(
        trx,
        a,
        'PRICE_SET',
        'item_price',
        active.id,
        { ...meta, pricePaisa: active.price_paisa },
        { ...meta, pricePaisa, effectiveFrom: date },
      );
      return { ...base, changed: true, mode: 'same_day_update' };
    }
    await trx
      .updateTable('item_prices')
      .set({ effective_to: dayBefore(date) })
      .where('id', '=', active.id)
      .execute();
    const row = await trx
      .insertInto('item_prices')
      .values({
        variant_id: variantId,
        price_list_id: priceListId,
        price_paisa: pricePaisa,
        effective_from: date,
        effective_to: active.effective_to,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(
      trx,
      a,
      'PRICE_SET',
      'item_price',
      row.id,
      { ...meta, pricePaisa: active.price_paisa, effectiveFrom: active.effective_from },
      { ...meta, pricePaisa, effectiveFrom: date },
    );
    return { ...base, changed: true, mode: 'close_and_new' };
  });
}

// ───────────────────────────── modifiers ─────────────────────────────

export interface ModifierGroupInput {
  code: string;
  name: string;
  nameUr?: string | null | undefined;
  minSelect: number;
  maxSelect: number;
}

export function createModifierGroup(ctx: AppContext, a: Actor, input: ModifierGroupInput) {
  return command(ctx, a, async (trx) => {
    const row = await trx
      .insertInto('modifier_groups')
      .values({
        branch_id: a.branchId,
        code: input.code,
        name: input.name,
        name_ur: input.nameUr ?? null,
        min_select: input.minSelect,
        max_select: input.maxSelect,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(trx, a, 'MODIFIER_GROUP_CREATE', 'modifier_group', row.id, null, row);
    return row;
  });
}

export function updateModifierGroup(
  ctx: AppContext,
  a: Actor,
  id: string,
  p: Partial<Omit<ModifierGroupInput, 'code'>>,
) {
  return command(ctx, a, async (trx) => {
    const before = await requireModifierGroup(trx, a.branchId, id, true);
    const row = await trx
      .updateTable('modifier_groups')
      .set({
        ...(p.name !== undefined && { name: p.name }),
        ...(p.nameUr !== undefined && { name_ur: p.nameUr }),
        ...(p.minSelect !== undefined && { min_select: p.minSelect }),
        ...(p.maxSelect !== undefined && { max_select: p.maxSelect }),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(trx, a, 'MODIFIER_GROUP_UPDATE', 'modifier_group', id, before, row);
    return row;
  });
}

export interface ModifierInput {
  name: string;
  nameUr?: string | null | undefined;
  priceDeltaPaisa: number;
  sort?: number | undefined;
}

export function createModifier(ctx: AppContext, a: Actor, groupId: string, input: ModifierInput) {
  return command(ctx, a, async (trx) => {
    await requireModifierGroup(trx, a.branchId, groupId, true);
    const row = await trx
      .insertInto('modifiers')
      .values({
        group_id: groupId,
        name: input.name,
        name_ur: input.nameUr ?? null,
        price_delta_paisa: input.priceDeltaPaisa,
        sort: input.sort ?? 0,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(trx, a, 'MODIFIER_CREATE', 'modifier', row.id, null, row);
    return row;
  });
}

export function updateModifier(
  ctx: AppContext,
  a: Actor,
  id: string,
  p: Partial<ModifierInput> & { isActive?: boolean | undefined },
) {
  return command(ctx, a, async (trx) => {
    const before = await trx
      .selectFrom('modifiers')
      .innerJoin('modifier_groups', 'modifier_groups.id', 'modifiers.group_id')
      .selectAll('modifiers')
      .where('modifiers.id', '=', id)
      .where('modifier_groups.branch_id', '=', a.branchId)
      .forUpdate('modifiers')
      .executeTakeFirst();
    if (!before) throw new AppError(404, 'NOT_FOUND', 'modifier not found');
    const row = await trx
      .updateTable('modifiers')
      .set({
        ...(p.name !== undefined && { name: p.name }),
        ...(p.nameUr !== undefined && { name_ur: p.nameUr }),
        ...(p.priceDeltaPaisa !== undefined && { price_delta_paisa: p.priceDeltaPaisa }),
        ...(p.sort !== undefined && { sort: p.sort }),
        ...(p.isActive !== undefined && { is_active: p.isActive }),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(trx, a, 'MODIFIER_UPDATE', 'modifier', id, before, row);
    return row;
  });
}

/** Which modifier groups appear on an item, in display order. */
export function setItemModifierGroups(
  ctx: AppContext,
  a: Actor,
  itemId: string,
  groupIds: string[],
) {
  return command(ctx, a, async (trx) => {
    await requireItem(trx, a.branchId, itemId, true);
    const unique = [...new Set(groupIds)];
    if (unique.length) {
      const found = await trx
        .selectFrom('modifier_groups')
        .select('id')
        .where('branch_id', '=', a.branchId)
        .where('id', 'in', unique)
        .execute();
      if (found.length !== unique.length) throw bad('Unknown modifier group id for this branch');
    }
    const before = (
      await trx
        .selectFrom('item_modifier_groups')
        .select('group_id')
        .where('item_id', '=', itemId)
        .orderBy('sort')
        .execute()
    ).map((r) => r.group_id);
    await trx.deleteFrom('item_modifier_groups').where('item_id', '=', itemId).execute();
    if (unique.length) {
      await trx
        .insertInto('item_modifier_groups')
        .values(unique.map((group_id, sort) => ({ item_id: itemId, group_id, sort })))
        .execute();
    }
    await audit(
      trx,
      a,
      'ITEM_MODIFIER_GROUPS_SET',
      'item',
      itemId,
      { groupIds: before },
      { groupIds: unique },
    );
    return { groupIds: unique };
  });
}

// ──────────────────────────────── deals ────────────────────────────────

export interface DealInput {
  slots: {
    name: string;
    qty: number;
    options: {
      variantId: string;
      priceDeltaPaisa?: number | undefined;
      isDefault?: boolean | undefined;
    }[];
  }[];
}

/** Replaces a deal's whole structure (slots + options). The deal's own price is a normal price row. */
export function setDeal(ctx: AppContext, a: Actor, itemId: string, input: DealInput) {
  return command(ctx, a, async (trx) => {
    const item = await requireItem(trx, a.branchId, itemId, true);
    if (item.kind !== 'DEAL') throw bad('Only items of kind DEAL have slots');
    validateDealDefinition(
      input.slots.map((s) => ({
        name: s.name,
        qty: s.qty,
        options: s.options.map((o) => ({ variantId: o.variantId, isDefault: !!o.isDefault })),
      })),
    );

    const variantIds = [...new Set(input.slots.flatMap((s) => s.options.map((o) => o.variantId)))];
    const found = await trx
      .selectFrom('item_variants')
      .innerJoin('items', 'items.id', 'item_variants.item_id')
      .select([
        'item_variants.id as id',
        'item_variants.is_active as v_active',
        'items.is_active as i_active',
        'items.kind as kind',
      ])
      .where('items.branch_id', '=', a.branchId)
      .where('item_variants.id', 'in', variantIds)
      .execute();
    if (found.length !== variantIds.length)
      throw bad('A deal option refers to an unknown item variant');
    if (found.some((f) => f.kind === 'DEAL')) throw bad('A deal cannot contain another deal');
    if (found.some((f) => !f.v_active || !f.i_active))
      throw bad('A deal option refers to an inactive item');

    const before = (await getItemFull(trx, a.branchId, itemId)).deal;
    await trx.deleteFrom('deal_slots').where('deal_item_id', '=', itemId).execute(); // options cascade
    for (const [i, s] of input.slots.entries()) {
      const slot = await trx
        .insertInto('deal_slots')
        .values({ deal_item_id: itemId, name: s.name, qty: s.qty, sort: i })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('deal_slot_options')
        .values(
          s.options.map((o) => ({
            slot_id: slot.id,
            variant_id: o.variantId,
            price_delta_paisa: o.priceDeltaPaisa ?? 0,
            is_default: !!o.isDefault,
          })),
        )
        .execute();
    }
    const full = await getItemFull(trx, a.branchId, itemId);
    await audit(trx, a, 'DEAL_SET', 'item', itemId, before, full.deal);
    return full;
  });
}
