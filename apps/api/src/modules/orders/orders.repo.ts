import { orderSubtotal, asPaisa, type Paisa } from '@erp/domain';
import { sql } from 'kysely';
import { AppError } from '../../http/errors';
import type { Queryable } from '../../shared/tx';

/** Branch-scoped order lookups. `lockOrder` takes the row lock every order command starts with. */

export async function lockOrder(q: Queryable, branchId: string, orderId: string) {
  const row = await q
    .selectFrom('orders')
    .selectAll()
    .where('id', '=', orderId)
    .where('branch_id', '=', branchId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw new AppError(404, 'NOT_FOUND', 'order not found');
  return row;
}

export async function openBusinessDay(q: Queryable, branchId: string) {
  const day = await q
    .selectFrom('business_days')
    .selectAll()
    .where('branch_id', '=', branchId)
    .where('status', '=', 'OPEN')
    .executeTakeFirst();
  return day ?? null;
}

export async function nextDocNo(
  q: Queryable,
  branchId: string,
  dayId: string,
  type: string,
): Promise<number> {
  const r = await sql<{
    n: number;
  }>`select next_doc_no(${branchId}::uuid, ${dayId}::uuid, ${type}) as n`.execute(q);
  return r.rows[0]!.n;
}

export async function getOrderFull(q: Queryable, branchId: string, orderId: string) {
  const order = await q
    .selectFrom('orders')
    .leftJoin('dining_tables', 'dining_tables.id', 'orders.table_id')
    .leftJoin('users', 'users.id', 'orders.waiter_id')
    .select([
      'orders.id as id',
      'orders.order_no as order_no',
      'orders.type as type',
      'orders.channel as channel',
      'orders.status as status',
      'orders.held_at as held_at',
      'orders.table_id as table_id',
      'dining_tables.code as table_code',
      'orders.guests as guests',
      'orders.customer_id as customer_id',
      'orders.price_list_id as price_list_id',
      'orders.waiter_id as waiter_id',
      'users.full_name as waiter_name',
      'orders.notes as notes',
      'orders.customer_name as customer_name',
      'orders.customer_phone as customer_phone',
      'orders.delivery_address as delivery_address',
      'orders.external_ref as external_ref',
      'orders.opened_at as opened_at',
      'orders.closed_at as closed_at',
      'orders.version as version',
      'orders.business_day_id as business_day_id',
    ])
    .where('orders.id', '=', orderId)
    .where('orders.branch_id', '=', branchId)
    .executeTakeFirst();
  if (!order) throw new AppError(404, 'NOT_FOUND', 'order not found');

  const items = await q
    .selectFrom('order_items')
    .selectAll()
    .where('order_id', '=', orderId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  const mods = items.length
    ? await q
        .selectFrom('order_item_modifiers')
        .selectAll()
        .where(
          'order_item_id',
          'in',
          items.map((i) => i.id),
        )
        .execute()
    : [];

  const lines = items.map((i) => ({
    id: i.id,
    parentId: i.parent_order_item_id,
    itemId: i.item_id,
    variantId: i.variant_id,
    name: i.name_snapshot,
    nameUr: i.name_ur_snapshot,
    qty: Number(i.qty),
    weightG: i.weight_g,
    unitPricePaisa: i.unit_price_paisa,
    modifiersTotalPaisa: i.modifiers_total_paisa,
    lineTotalPaisa: i.line_total_paisa,
    taxCategoryId: i.tax_category_id,
    stationId: i.station_id,
    kotId: i.kot_id,
    course: i.course,
    status: i.status,
    note: i.note,
    voidReason: i.void_reason,
    isComplimentary: i.is_complimentary,
    modifiers: mods
      .filter((m) => m.order_item_id === i.id)
      .map((m) => ({
        id: m.id,
        modifierId: m.modifier_id,
        name: m.name_snapshot,
        priceDeltaPaisa: m.price_delta_paisa,
      })),
  }));

  return {
    id: order.id,
    orderNo: order.order_no,
    type: order.type,
    channel: order.channel,
    status: order.status,
    held: order.held_at !== null,
    tableId: order.table_id,
    tableCode: order.table_code,
    guests: order.guests,
    customerId: order.customer_id,
    priceListId: order.price_list_id,
    waiterId: order.waiter_id,
    waiterName: order.waiter_name,
    notes: order.notes,
    customerName: order.customer_name,
    customerPhone: order.customer_phone,
    deliveryAddress: order.delivery_address,
    externalRef: order.external_ref,
    openedAt: order.opened_at,
    closedAt: order.closed_at,
    version: order.version,
    businessDayId: order.business_day_id,
    items: lines,
    subtotalPaisa: orderSubtotal(
      lines.map((l) => ({
        lineTotalPaisa: asPaisa(l.lineTotalPaisa),
        status: l.status,
        parentLineId: l.parentId,
      })),
    ),
  };
}

export type OrderView = Awaited<ReturnType<typeof getOrderFull>>;

/** Count + subtotal of live top-level lines, per order (for floor and list views). */
export async function orderTotals(
  q: Queryable,
  orderIds: string[],
): Promise<Map<string, { itemCount: number; subtotalPaisa: Paisa }>> {
  const out = new Map<string, { itemCount: number; subtotalPaisa: Paisa }>();
  if (orderIds.length === 0) return out;
  const rows = await q
    .selectFrom('order_items')
    .select([
      'order_id',
      (eb) => eb.fn.countAll<string>().as('n'),
      (eb) => eb.fn.sum<string>('line_total_paisa').as('total'),
    ])
    .where('order_id', 'in', orderIds)
    .where('status', '!=', 'VOID')
    .where('parent_order_item_id', 'is', null)
    .groupBy('order_id')
    .execute();
  for (const r of rows)
    out.set(r.order_id, { itemCount: Number(r.n), subtotalPaisa: asPaisa(Number(r.total)) });
  return out;
}

export async function bumpVersion(q: Queryable, orderId: string): Promise<number> {
  const r = await q
    .updateTable('orders')
    .set({ version: sql`version + 1` })
    .where('id', '=', orderId)
    .returning('version')
    .executeTakeFirstOrThrow();
  return r.version;
}
