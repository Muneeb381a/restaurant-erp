import { sql } from 'kysely';
import {
  allocateDealLine,
  asPaisa,
  canTransitionOrder,
  defaultDealPicks,
  findPrice,
  isItemEditable,
  isOrderEditable,
  priceLine,
  validateDealSelection,
  validateModifierSelection,
  voidRule,
  type DealPick,
  type DealSlotDef,
  type ItemStatus,
  type ModifierGroupDef,
  type Paisa,
} from '@erp/domain';
import type { AppContext } from '../../http/context';
import { AppError } from '../../http/errors';
import { withTx, type Queryable } from '../../shared/tx';
import { writeAudit } from '../audit/audit.service';
import {
  bumpVersion,
  getOrderFull,
  lockOrder,
  nextDocNo,
  openBusinessDay,
  orderTotals,
} from './orders.repo';

export interface Actor {
  branchId: string;
  userId: string;
  deviceId: string | null;
  ip?: string | undefined;
  /** Permission codes of the actor's role (for checks that depend on the data, e.g. void after KOT). */
  permissions: ReadonlySet<string>;
}

const bad = (message: string, extra?: Record<string, unknown>): AppError =>
  new AppError(400, 'VALIDATION_FAILED', message, extra);

function audit(
  q: Queryable,
  a: Actor,
  action: string,
  entityId: string,
  before: unknown,
  after: unknown,
  reason?: string,
) {
  return writeAudit(q, {
    branchId: a.branchId,
    userId: a.userId,
    deviceId: a.deviceId,
    action,
    entity: 'order',
    entityId,
    before,
    after,
    reason,
    ip: a.ip,
  });
}

/**
 * Optimistic locking. Structural changes (transfer, merge, cancel, header edits) REQUIRE the
 * `If-Match` version the client last saw. Item changes are commutative (two captains adding
 * to one table is normal), so `If-Match` is optional there — but if sent it must match.
 */
function checkVersion(
  order: { version: number },
  ifMatch: number | undefined,
  required: boolean,
): void {
  if (ifMatch === undefined) {
    if (required)
      throw new AppError(
        428,
        'PRECONDITION_REQUIRED',
        'Send the order version you last saw in If-Match',
      );
    return;
  }
  if (ifMatch !== order.version) {
    throw new AppError(
      409,
      'VERSION_CONFLICT',
      'The order was changed by someone else; reload and retry',
      { currentVersion: order.version },
    );
  }
}

function assertEditable(order: { status: string; held_at: Date | null }): void {
  if (!isOrderEditable(order.status as 'OPEN')) {
    throw new AppError(
      409,
      'ORDER_NOT_EDITABLE',
      `Order is ${order.status} and can no longer be changed`,
    );
  }
  if (order.held_at)
    throw new AppError(409, 'ORDER_HELD', 'Resume the held order before changing it');
}

async function tableOccupied(
  ctx: AppContext,
  branchId: string,
  tableId: string,
): Promise<AppError> {
  const o = await ctx.db
    .selectFrom('orders')
    .select(['id', 'order_no'])
    .where('branch_id', '=', branchId)
    .where('table_id', '=', tableId)
    .where('status', 'in', ['OPEN', 'BILLED'])
    .executeTakeFirst();
  return new AppError(
    409,
    'TABLE_OCCUPIED',
    'That table already has an open order',
    o ? { orderId: o.id, orderNo: o.order_no } : undefined,
  );
}

/** Runs `fn`; a clash on the one-open-order-per-table index becomes TABLE_OCCUPIED. */
async function guardTable<T>(
  ctx: AppContext,
  branchId: string,
  tableId: string | null | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (
      tableId &&
      (e as { code?: string; constraint?: string }).constraint === 'one_open_order_per_table'
    ) {
      throw await tableOccupied(ctx, branchId, tableId);
    }
    throw e;
  }
}

// ───────────────────────────── create / header ─────────────────────────────

export interface CreateOrderInput {
  type: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';
  tableId?: string | undefined;
  guests?: number | undefined;
  customerId?: string | undefined;
  notes?: string | undefined;
  channel?: 'POS' | 'PHONE' | 'WHATSAPP' | 'FOODPANDA' | 'WEB' | 'OTHER' | undefined;
  /** Price list code; defaults to the one named like the order type (DINE_IN / TAKEAWAY / DELIVERY). */
  priceList?: string | undefined;
}

export async function createOrder(ctx: AppContext, a: Actor, input: CreateOrderInput) {
  if (input.type === 'DINE_IN' && !input.tableId) throw bad('A dine-in order needs a tableId');
  if (input.type !== 'DINE_IN' && input.tableId) throw bad('Only dine-in orders have a table');

  const id = await guardTable(ctx, a.branchId, input.tableId, () =>
    withTx(ctx.db, async (trx) => {
      const day = await openBusinessDay(trx, a.branchId);
      if (!day)
        throw new AppError(409, 'DAY_NOT_OPEN', 'Open the business day before taking orders');

      if (input.tableId) {
        const table = await trx
          .selectFrom('dining_tables')
          .select('id')
          .where('id', '=', input.tableId)
          .where('branch_id', '=', a.branchId)
          .where('is_active', '=', true)
          .executeTakeFirst();
        if (!table) throw new AppError(404, 'NOT_FOUND', 'table not found');
      }
      if (input.customerId) {
        const c = await trx
          .selectFrom('customers')
          .select('id')
          .where('id', '=', input.customerId)
          .where('is_active', '=', true)
          .executeTakeFirst();
        if (!c) throw new AppError(404, 'NOT_FOUND', 'customer not found');
      }
      const listCode = (input.priceList ?? input.type).toUpperCase();
      const list = await trx
        .selectFrom('price_lists')
        .select('id')
        .where('branch_id', '=', a.branchId)
        .where('code', '=', listCode)
        .executeTakeFirst();
      if (!list) throw bad(`Price list ${listCode} does not exist for this branch`);

      const orderNo = await nextDocNo(trx, a.branchId, day.id, 'ORDER');
      const row = await trx
        .insertInto('orders')
        .values({
          branch_id: a.branchId,
          business_day_id: day.id,
          order_no: orderNo,
          type: input.type,
          channel: input.channel ?? 'POS',
          table_id: input.tableId ?? null,
          guests: input.guests ?? null,
          customer_id: input.customerId ?? null,
          price_list_id: list.id,
          waiter_id: a.userId,
          notes: input.notes ?? null,
          opened_by: a.userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    }),
  );
  return getOrderFull(ctx.db, a.branchId, id);
}

export interface OrderPatch {
  guests?: number | null | undefined;
  notes?: string | null | undefined;
  customerId?: string | null | undefined;
}

export function updateOrder(
  ctx: AppContext,
  a: Actor,
  orderId: string,
  patch: OrderPatch,
  ifMatch: number | undefined,
) {
  return withTx(ctx.db, async (trx) => {
    const order = await lockOrder(trx, a.branchId, orderId);
    assertEditable(order);
    checkVersion(order, ifMatch, true);
    if (patch.customerId) {
      const c = await trx
        .selectFrom('customers')
        .select('id')
        .where('id', '=', patch.customerId)
        .where('is_active', '=', true)
        .executeTakeFirst();
      if (!c) throw new AppError(404, 'NOT_FOUND', 'customer not found');
    }
    await trx
      .updateTable('orders')
      .set({
        ...(patch.guests !== undefined && { guests: patch.guests }),
        ...(patch.notes !== undefined && { notes: patch.notes }),
        ...(patch.customerId !== undefined && { customer_id: patch.customerId }),
      })
      .where('id', '=', orderId)
      .execute();
    await bumpVersion(trx, orderId);
    return getOrderFull(trx, a.branchId, orderId);
  });
}

export function setHeld(
  ctx: AppContext,
  a: Actor,
  orderId: string,
  held: boolean,
  ifMatch: number | undefined,
) {
  return withTx(ctx.db, async (trx) => {
    const order = await lockOrder(trx, a.branchId, orderId);
    if (!isOrderEditable(order.status as 'OPEN'))
      throw new AppError(409, 'ORDER_NOT_EDITABLE', `Order is ${order.status}`);
    checkVersion(order, ifMatch, false);
    if (held === (order.held_at !== null)) return getOrderFull(trx, a.branchId, orderId); // idempotent
    await trx
      .updateTable('orders')
      .set({ held_at: held ? ctx.clock.now() : null })
      .where('id', '=', orderId)
      .execute();
    await bumpVersion(trx, orderId);
    return getOrderFull(trx, a.branchId, orderId);
  });
}

// ───────────────────────────────── lines ─────────────────────────────────

export interface AddItemInput {
  itemId: string;
  variantId: string;
  qty?: number | undefined;
  weightG?: number | undefined;
  modifierIds?: string[] | undefined;
  /** Deal choices; omitted = the defaults/fixed components (an error if a real choice is needed). */
  dealPicks?: DealPick[] | undefined;
  note?: string | undefined;
  course?: number | undefined;
}

/**
 * Printed name of a line: "Item (Variant)" only when the item really has a choice of variants
 * (Half/Full…); single-variant items, weighed items and deals print just the item name.
 */
const snapshotName = (item: string, variant: string, kind: string, variantCount: number): string =>
  kind !== 'STANDARD' || variantCount <= 1 ? item : `${item} (${variant})`;

async function currentPrice(
  q: Queryable,
  variantId: string,
  priceListId: string,
  date: string,
): Promise<Paisa | null> {
  const rows = await q
    .selectFrom('item_prices')
    .selectAll()
    .where('variant_id', '=', variantId)
    .where('price_list_id', '=', priceListId)
    .execute();
  return findPrice(
    rows.map((r) => ({
      variantId: r.variant_id,
      priceListId: r.price_list_id,
      pricePaisa: asPaisa(r.price_paisa),
      effectiveFrom: r.effective_from,
      effectiveTo: r.effective_to,
    })),
    variantId,
    priceListId,
    date,
  );
}

async function loadModifierGroups(q: Queryable, itemId: string) {
  const groups = await q
    .selectFrom('item_modifier_groups')
    .innerJoin('modifier_groups', 'modifier_groups.id', 'item_modifier_groups.group_id')
    .select([
      'modifier_groups.id as id',
      'modifier_groups.min_select as min_select',
      'modifier_groups.max_select as max_select',
    ])
    .where('item_modifier_groups.item_id', '=', itemId)
    .execute();
  const mods = groups.length
    ? await q
        .selectFrom('modifiers')
        .selectAll()
        .where(
          'group_id',
          'in',
          groups.map((g) => g.id),
        )
        .execute()
    : [];
  const defs: ModifierGroupDef[] = groups.map((g) => ({
    id: g.id,
    minSelect: g.min_select,
    maxSelect: g.max_select,
    modifiers: mods
      .filter((m) => m.group_id === g.id)
      .map((m) => ({
        id: m.id,
        priceDeltaPaisa: asPaisa(m.price_delta_paisa),
        isActive: m.is_active,
      })),
  }));
  return { defs, byId: new Map(mods.map((m) => [m.id, m])) };
}

async function loadDeal(q: Queryable, itemId: string) {
  const slots = await q
    .selectFrom('deal_slots')
    .selectAll()
    .where('deal_item_id', '=', itemId)
    .orderBy('sort')
    .execute();
  const options = slots.length
    ? await q
        .selectFrom('deal_slot_options')
        .innerJoin('item_variants', 'item_variants.id', 'deal_slot_options.variant_id')
        .innerJoin('items', 'items.id', 'item_variants.item_id')
        .select([
          'deal_slot_options.id as id',
          'deal_slot_options.slot_id as slot_id',
          'deal_slot_options.variant_id as variant_id',
          'deal_slot_options.price_delta_paisa as delta',
          'deal_slot_options.is_default as is_default',
          'items.id as item_id',
          'items.kind as item_kind',
          'items.name as item_name',
          'items.name_ur as item_name_ur',
          'items.station_id as station_id',
          'items.tax_category_id as tax_category_id',
          'items.is_available as available',
          'items.is_active as i_active',
          'item_variants.name as variant_name',
          'item_variants.name_ur as variant_name_ur',
          sql<number>`(select count(*)::int from item_variants iv where iv.item_id = items.id and iv.is_active)`.as(
            'variant_count',
          ),
          'item_variants.is_active as v_active',
        ])
        .where(
          'deal_slot_options.slot_id',
          'in',
          slots.map((s) => s.id),
        )
        .execute()
    : [];
  const defs: DealSlotDef[] = slots.map((s) => ({
    id: s.id,
    name: s.name,
    qty: s.qty,
    options: options
      .filter((o) => o.slot_id === s.id)
      .map((o) => ({
        id: o.id,
        variantId: o.variant_id,
        priceDeltaPaisa: asPaisa(o.delta),
        isDefault: o.is_default,
      })),
  }));
  return { defs, byOption: new Map(options.map((o) => [o.id, o])) };
}

export function addItem(
  ctx: AppContext,
  a: Actor,
  orderId: string,
  input: AddItemInput,
  ifMatch: number | undefined,
) {
  return withTx(ctx.db, async (trx) => {
    const order = await lockOrder(trx, a.branchId, orderId);
    assertEditable(order);
    checkVersion(order, ifMatch, false);
    const day = await trx
      .selectFrom('business_days')
      .select('business_date')
      .where('id', '=', order.business_day_id)
      .executeTakeFirstOrThrow();

    const item = await trx
      .selectFrom('items')
      .selectAll()
      .where('id', '=', input.itemId)
      .where('branch_id', '=', a.branchId)
      .executeTakeFirst();
    if (!item || !item.is_active) throw new AppError(404, 'NOT_FOUND', 'item not found');
    if (!item.is_available)
      throw new AppError(409, 'ITEM_UNAVAILABLE', `${item.name} is sold out (86)`);
    const variant = await trx
      .selectFrom('item_variants')
      .selectAll()
      .where('id', '=', input.variantId)
      .where('item_id', '=', item.id)
      .where('is_active', '=', true)
      .executeTakeFirst();
    if (!variant) throw new AppError(404, 'NOT_FOUND', 'variant not found for this item');

    const variantCount = Number(
      (
        await trx
          .selectFrom('item_variants')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('item_id', '=', item.id)
          .where('is_active', '=', true)
          .executeTakeFirstOrThrow()
      ).n,
    );
    const unitPrice = await currentPrice(trx, variant.id, order.price_list_id, day.business_date);
    if (unitPrice === null)
      throw new AppError(
        409,
        'ITEM_NOT_ON_MENU',
        `${item.name} has no price in this order's price list today`,
      );

    const qty = input.qty ?? 1;
    const mods = await loadModifierGroups(trx, item.id);
    const modifierIds = [...(input.modifierIds ?? [])];
    const modSel = validateModifierSelection(mods.defs, modifierIds);

    // ── deal choices
    let upcharge = asPaisa(0);
    let components: { optionId: string; variantId: string; count: number }[] = [];
    let dealMeta: Awaited<ReturnType<typeof loadDeal>> | null = null;
    if (item.kind === 'DEAL') {
      dealMeta = await loadDeal(trx, item.id);
      const picks = input.dealPicks ?? defaultDealPicks(dealMeta.defs);
      const sel = validateDealSelection(dealMeta.defs, picks);
      upcharge = sel.upchargePerUnitPaisa;
      components = sel.components;
      for (const c of components) {
        const o = dealMeta.byOption.get(c.optionId)!;
        if (!o.v_active || !o.i_active)
          throw new AppError(409, 'ITEM_UNAVAILABLE', `${o.item_name} is no longer offered`);
        if (!o.available)
          throw new AppError(409, 'ITEM_UNAVAILABLE', `${o.item_name} is sold out (86)`);
      }
    } else if (input.dealPicks) {
      throw bad('dealPicks only apply to DEAL items');
    }

    const priced = priceLine({
      kind: item.kind as 'STANDARD' | 'WEIGHT' | 'DEAL',
      unitPricePaisa: unitPrice,
      qty,
      weightG: input.weightG,
      modifiersDeltaPerUnitPaisa: modSel.deltaPerUnitPaisa,
      dealUpchargePerUnitPaisa: upcharge,
    });

    const line = await trx
      .insertInto('order_items')
      .values({
        order_id: orderId,
        item_id: item.id,
        variant_id: variant.id,
        name_snapshot: snapshotName(item.name, variant.name, item.kind, variantCount),
        name_ur_snapshot: item.name_ur
          ? item.kind !== 'STANDARD' || variantCount <= 1
            ? item.name_ur
            : `${item.name_ur} (${variant.name_ur ?? variant.name})`
          : null,
        qty,
        weight_g: input.weightG ?? null,
        unit_price_paisa: unitPrice,
        modifiers_total_paisa: priced.modifiersTotalPaisa,
        line_total_paisa: priced.lineTotalPaisa,
        tax_category_id: item.tax_category_id,
        station_id: item.station_id,
        course: input.course ?? 1,
        note: input.note ?? null,
        created_by: a.userId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    if (modSel.selected.length) {
      await trx
        .insertInto('order_item_modifiers')
        .values(
          modSel.selected.map((s) => ({
            order_item_id: line.id,
            modifier_id: s.modifierId,
            name_snapshot: mods.byId.get(s.modifierId)!.name,
            price_delta_paisa: s.priceDeltaPaisa,
          })),
        )
        .execute();
    }

    // ── deal components: child lines (price 0 for display) carrying the allocated share of the price
    if (dealMeta && components.length) {
      const listPrices = await Promise.all(
        components.map(
          async (c) =>
            (await currentPrice(trx, c.variantId, order.price_list_id, day.business_date)) ??
            asPaisa(0),
        ),
      );
      const alloc = allocateDealLine(
        priced.lineTotalPaisa,
        components.map((c, i) => ({
          key: String(i),
          listPricePaisa: listPrices[i]!,
          count: c.count,
        })),
      );
      for (const [i, c] of components.entries()) {
        const o = dealMeta.byOption.get(c.optionId)!;
        await trx
          .insertInto('order_items')
          .values({
            order_id: orderId,
            parent_order_item_id: line.id,
            item_id: o.item_id,
            variant_id: o.variant_id,
            name_snapshot: snapshotName(o.item_name, o.variant_name, o.item_kind, o.variant_count),
            name_ur_snapshot: o.item_name_ur,
            qty: c.count * qty,
            unit_price_paisa: 0,
            modifiers_total_paisa: 0,
            line_total_paisa: alloc[i]!.allocatedPaisa,
            tax_category_id: o.tax_category_id,
            station_id: o.station_id,
            course: input.course ?? 1,
            created_by: a.userId,
          })
          .execute();
      }
    }

    await bumpVersion(trx, orderId);
    return { lineId: line.id, order: await getOrderFull(trx, a.branchId, orderId) };
  });
}

export interface UpdateItemInput {
  qty?: number | undefined;
  weightG?: number | undefined;
  modifierIds?: string[] | undefined;
  note?: string | null | undefined;
  course?: number | undefined;
}

export function updateItem(
  ctx: AppContext,
  a: Actor,
  orderId: string,
  lineId: string,
  patch: UpdateItemInput,
  ifMatch: number | undefined,
) {
  return withTx(ctx.db, async (trx) => {
    const order = await lockOrder(trx, a.branchId, orderId);
    assertEditable(order);
    checkVersion(order, ifMatch, false);
    const line = await trx
      .selectFrom('order_items')
      .selectAll()
      .where('id', '=', lineId)
      .where('order_id', '=', orderId)
      .forUpdate()
      .executeTakeFirst();
    if (!line || line.parent_order_item_id)
      throw new AppError(404, 'NOT_FOUND', 'order line not found');
    if (!isItemEditable(line.status as ItemStatus)) {
      throw new AppError(
        409,
        'ITEM_NOT_EDITABLE',
        'This line was already sent to the kitchen; void it and add it again',
      );
    }
    const item = await trx
      .selectFrom('items')
      .selectAll()
      .where('id', '=', line.item_id)
      .executeTakeFirstOrThrow();
    const oldQty = Number(line.qty);
    const newQty = item.kind === 'WEIGHT' ? 1 : (patch.qty ?? oldQty);
    if (item.kind === 'WEIGHT' && patch.qty !== undefined && patch.qty !== 1)
      throw bad('A weighed line has qty 1; change weightG instead');
    if (item.kind !== 'WEIGHT' && patch.weightG !== undefined)
      throw bad(`${item.kind} lines do not take a weight`);

    // modifiers: re-validate when changed, otherwise keep the stored selection
    let modDelta: Paisa;
    if (patch.modifierIds) {
      const mods = await loadModifierGroups(trx, item.id);
      const sel = validateModifierSelection(mods.defs, patch.modifierIds);
      await trx.deleteFrom('order_item_modifiers').where('order_item_id', '=', lineId).execute();
      if (sel.selected.length) {
        await trx
          .insertInto('order_item_modifiers')
          .values(
            sel.selected.map((s) => ({
              order_item_id: lineId,
              modifier_id: s.modifierId,
              name_snapshot: mods.byId.get(s.modifierId)!.name,
              price_delta_paisa: s.priceDeltaPaisa,
            })),
          )
          .execute();
      }
      modDelta = sel.deltaPerUnitPaisa;
    } else {
      const cur = await trx
        .selectFrom('order_item_modifiers')
        .select('price_delta_paisa')
        .where('order_item_id', '=', lineId)
        .execute();
      modDelta = asPaisa(cur.reduce((n, m) => n + m.price_delta_paisa, 0));
    }

    // a deal's option upcharge is not stored on its own: recover it from the old totals
    const upcharge =
      item.kind === 'DEAL'
        ? asPaisa(
            (line.line_total_paisa - line.modifiers_total_paisa) / oldQty - line.unit_price_paisa,
          )
        : asPaisa(0);
    const priced = priceLine({
      kind: item.kind as 'STANDARD' | 'WEIGHT' | 'DEAL',
      unitPricePaisa: asPaisa(line.unit_price_paisa),
      qty: newQty,
      weightG: item.kind === 'WEIGHT' ? (patch.weightG ?? line.weight_g ?? undefined) : undefined,
      modifiersDeltaPerUnitPaisa: modDelta,
      dealUpchargePerUnitPaisa: upcharge,
    });

    await trx
      .updateTable('order_items')
      .set({
        qty: newQty,
        ...(item.kind === 'WEIGHT' && { weight_g: patch.weightG ?? line.weight_g }),
        modifiers_total_paisa: priced.modifiersTotalPaisa,
        line_total_paisa: priced.lineTotalPaisa,
        ...(patch.note !== undefined && { note: patch.note }),
        ...(patch.course !== undefined && { course: patch.course }),
      })
      .where('id', '=', lineId)
      .execute();

    if (item.kind === 'DEAL') {
      const children = await trx
        .selectFrom('order_items')
        .selectAll()
        .where('parent_order_item_id', '=', lineId)
        .orderBy('created_at')
        .orderBy('id')
        .execute();
      const day = await trx
        .selectFrom('business_days')
        .select('business_date')
        .where('id', '=', order.business_day_id)
        .executeTakeFirstOrThrow();
      const prices = await Promise.all(
        children.map(
          async (c) =>
            (await currentPrice(trx, c.variant_id, order.price_list_id, day.business_date)) ??
            asPaisa(0),
        ),
      );
      const alloc = allocateDealLine(
        priced.lineTotalPaisa,
        children.map((c, i) => ({
          key: c.id,
          listPricePaisa: prices[i]!,
          count: Number(c.qty) / oldQty,
        })),
      );
      for (const [i, c] of children.entries()) {
        await trx
          .updateTable('order_items')
          .set({
            qty: (Number(c.qty) / oldQty) * newQty,
            line_total_paisa: alloc[i]!.allocatedPaisa,
          })
          .where('id', '=', c.id)
          .execute();
      }
    }

    await bumpVersion(trx, orderId);
    return getOrderFull(trx, a.branchId, orderId);
  });
}

export function voidItem(
  ctx: AppContext,
  a: Actor,
  orderId: string,
  lineId: string,
  reason: string | undefined,
  ifMatch: number | undefined,
) {
  return withTx(ctx.db, async (trx) => {
    const order = await lockOrder(trx, a.branchId, orderId);
    assertEditable(order);
    checkVersion(order, ifMatch, false);
    const line = await trx
      .selectFrom('order_items')
      .selectAll()
      .where('id', '=', lineId)
      .where('order_id', '=', orderId)
      .forUpdate()
      .executeTakeFirst();
    if (!line || line.parent_order_item_id)
      throw new AppError(404, 'NOT_FOUND', 'order line not found');

    const rule = voidRule(line.status as ItemStatus);
    if (!rule.allowed) throw new AppError(409, 'ITEM_NOT_EDITABLE', 'This line is already void');
    if (rule.needsPermission) {
      // Voiding what the kitchen already saw: permission + reason + audit (CLAUDE.md rule 7)
      if (!a.permissions.has('kot.void')) {
        throw new AppError(
          403,
          'PERMISSION_DENIED',
          'Voiding an item after it was sent needs kot.void',
          { permission: 'kot.void' },
        );
      }
      if (!reason || reason.trim().length < 3)
        throw bad('A reason is required to void an item that was already sent');
    }
    const why = reason?.trim() || 'Removed before sending';

    await trx
      .updateTable('order_items')
      .set({ status: 'VOID', void_reason: why, voided_by: a.userId, voided_at: ctx.clock.now() })
      .where((eb) => eb.or([eb('id', '=', lineId), eb('parent_order_item_id', '=', lineId)])) // deal components follow
      .execute();
    if (rule.needsPermission) {
      await audit(
        trx,
        a,
        'ITEM_VOID_AFTER_SEND',
        orderId,
        {
          lineId,
          name: line.name_snapshot,
          status: line.status,
          lineTotalPaisa: line.line_total_paisa,
        },
        { status: 'VOID', wastage: rule.wastage },
        why,
      );
    }
    await bumpVersion(trx, orderId);
    return getOrderFull(trx, a.branchId, orderId);
  });
}

// ─────────────────────── transfer / merge / cancel ───────────────────────

export async function transferTable(
  ctx: AppContext,
  a: Actor,
  orderId: string,
  tableId: string,
  ifMatch: number | undefined,
) {
  return guardTable(ctx, a.branchId, tableId, () =>
    withTx(ctx.db, async (trx) => {
      const order = await lockOrder(trx, a.branchId, orderId);
      assertEditable(order);
      checkVersion(order, ifMatch, true);
      if (order.type !== 'DINE_IN') throw bad('Only dine-in orders have a table');
      if (order.table_id === tableId) throw bad('The order is already on that table');
      const table = await trx
        .selectFrom('dining_tables')
        .select(['id', 'code'])
        .where('id', '=', tableId)
        .where('branch_id', '=', a.branchId)
        .where('is_active', '=', true)
        .executeTakeFirst();
      if (!table) throw new AppError(404, 'NOT_FOUND', 'table not found');
      const from = order.table_id
        ? await trx
            .selectFrom('dining_tables')
            .select('code')
            .where('id', '=', order.table_id)
            .executeTakeFirst()
        : undefined;

      await trx
        .updateTable('orders')
        .set({ table_id: tableId })
        .where('id', '=', orderId)
        .execute();
      await bumpVersion(trx, orderId);
      await audit(
        trx,
        a,
        'ORDER_TRANSFER',
        orderId,
        { tableId: order.table_id, table: from?.code },
        { tableId, table: table.code },
      );
      return getOrderFull(trx, a.branchId, orderId);
    }),
  );
}

export function mergeOrders(
  ctx: AppContext,
  a: Actor,
  targetId: string,
  sourceId: string,
  ifMatch: number | undefined,
) {
  if (targetId === sourceId) throw bad('Cannot merge an order into itself');
  return withTx(ctx.db, async (trx) => {
    // Lock both rows in a fixed order so two concurrent merges cannot deadlock.
    const [firstId, secondId] = [targetId, sourceId].sort();
    const first = await lockOrder(trx, a.branchId, firstId!);
    const second = await lockOrder(trx, a.branchId, secondId!);
    const target = first.id === targetId ? first : second;
    const source = first.id === sourceId ? first : second;

    assertEditable(target);
    assertEditable(source);
    checkVersion(target, ifMatch, true);
    if (target.business_day_id !== source.business_day_id)
      throw bad('Orders from different business days cannot be merged');
    if (target.type !== source.type) throw bad('Only orders of the same type can be merged');

    const moved = await trx
      .updateTable('order_items')
      .set({ order_id: targetId })
      .where('order_id', '=', sourceId)
      .returning('id')
      .execute();
    await trx
      .updateTable('kots')
      .set({ order_id: targetId })
      .where('order_id', '=', sourceId)
      .execute();
    await trx
      .updateTable('orders')
      .set({
        status: 'CANCELLED',
        closed_at: ctx.clock.now(),
        notes: `Merged into order #${target.order_no}`,
      })
      .where('id', '=', sourceId)
      .execute();
    await bumpVersion(trx, sourceId);
    await bumpVersion(trx, targetId);
    await audit(
      trx,
      a,
      'ORDER_MERGE',
      targetId,
      { sourceOrderId: sourceId, sourceOrderNo: source.order_no, sourceTableId: source.table_id },
      { targetOrderNo: target.order_no, linesMoved: moved.length },
    );
    return getOrderFull(trx, a.branchId, targetId);
  });
}

export function cancelOrder(
  ctx: AppContext,
  a: Actor,
  orderId: string,
  reason: string,
  ifMatch: number | undefined,
) {
  return withTx(ctx.db, async (trx) => {
    const order = await lockOrder(trx, a.branchId, orderId);
    if (!canTransitionOrder(order.status as 'OPEN', 'CANCELLED')) {
      throw new AppError(409, 'ORDER_NOT_EDITABLE', `A ${order.status} order cannot be cancelled`);
    }
    checkVersion(order, ifMatch, true);
    const sent = await trx
      .selectFrom('order_items')
      .select('id')
      .where('order_id', '=', orderId)
      .where('status', 'not in', ['NEW', 'VOID'])
      .limit(1)
      .executeTakeFirst();
    if (sent)
      throw new AppError(
        409,
        'ORDER_HAS_SENT_ITEMS',
        'Void the items already sent to the kitchen first',
      );

    const before = await orderTotals(trx, [orderId]);
    await trx
      .updateTable('order_items')
      .set({
        status: 'VOID',
        void_reason: `Order cancelled: ${reason}`,
        voided_by: a.userId,
        voided_at: ctx.clock.now(),
      })
      .where('order_id', '=', orderId)
      .where('status', '=', 'NEW')
      .execute();
    await trx
      .updateTable('orders')
      .set({ status: 'CANCELLED', closed_at: ctx.clock.now(), held_at: null })
      .where('id', '=', orderId)
      .execute();
    await bumpVersion(trx, orderId);
    await audit(
      trx,
      a,
      'ORDER_CANCEL',
      orderId,
      { status: order.status, ...before.get(orderId) },
      { status: 'CANCELLED' },
      reason,
    );
    return getOrderFull(trx, a.branchId, orderId);
  });
}
