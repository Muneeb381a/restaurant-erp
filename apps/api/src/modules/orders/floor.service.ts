import type { AppContext } from '../../http/context';
import { orderTotals } from './orders.repo';

/**
 * Live floor view: every active table with the state of its open order (if any).
 * FREE = no open order · OCCUPIED = open order · BILLED = pre-bill printed, waiting for payment.
 */
export async function getFloor(ctx: AppContext, branchId: string) {
  const [areas, tables] = await Promise.all([
    ctx.db
      .selectFrom('areas')
      .selectAll()
      .where('branch_id', '=', branchId)
      .orderBy('sort')
      .orderBy('name')
      .execute(),
    ctx.db
      .selectFrom('dining_tables')
      .selectAll()
      .where('branch_id', '=', branchId)
      .where('is_active', '=', true)
      .orderBy('code')
      .execute(),
  ]);
  const orders = tables.length
    ? await ctx.db
        .selectFrom('orders')
        .leftJoin('users', 'users.id', 'orders.waiter_id')
        .select([
          'orders.id as id',
          'orders.order_no as order_no',
          'orders.table_id as table_id',
          'orders.status as status',
          'orders.guests as guests',
          'orders.opened_at as opened_at',
          'orders.held_at as held_at',
          'orders.version as version',
          'users.full_name as waiter_name',
        ])
        .where('orders.branch_id', '=', branchId)
        .where('orders.status', 'in', ['OPEN', 'BILLED'])
        .where('orders.table_id', 'is not', null)
        .execute()
    : [];
  const totals = await orderTotals(
    ctx.db,
    orders.map((o) => o.id),
  );
  const byTable = new Map(orders.map((o) => [o.table_id as string, o]));

  return {
    areas: areas.map((a) => ({ id: a.id, name: a.name, sort: a.sort })),
    tables: tables.map((t) => {
      const o = byTable.get(t.id);
      const sum = o ? totals.get(o.id) : undefined;
      return {
        id: t.id,
        code: t.code,
        areaId: t.area_id,
        seats: t.seats,
        posX: t.pos_x,
        posY: t.pos_y,
        status: !o ? 'FREE' : o.status === 'BILLED' ? 'BILLED' : 'OCCUPIED',
        order: o
          ? {
              id: o.id,
              orderNo: o.order_no,
              guests: o.guests,
              openedAt: o.opened_at,
              held: o.held_at !== null,
              waiterName: o.waiter_name,
              version: o.version,
              itemCount: sum?.itemCount ?? 0,
              subtotalPaisa: sum?.subtotalPaisa ?? 0,
            }
          : null,
      };
    }),
  };
}

export async function listOrders(
  ctx: AppContext,
  branchId: string,
  f: {
    status: 'active' | 'OPEN' | 'BILLED' | 'SETTLED' | 'CANCELLED' | 'all';
    type?: string | undefined;
    held?: boolean | undefined;
    limit: number;
  },
) {
  let q = ctx.db
    .selectFrom('orders')
    .leftJoin('dining_tables', 'dining_tables.id', 'orders.table_id')
    .select([
      'orders.id as id',
      'orders.order_no as order_no',
      'orders.type as type',
      'orders.status as status',
      'dining_tables.code as table_code',
      'orders.guests as guests',
      'orders.opened_at as opened_at',
      'orders.held_at as held_at',
      'orders.version as version',
    ])
    .where('orders.branch_id', '=', branchId)
    .orderBy('orders.opened_at', 'desc')
    .limit(f.limit);
  if (f.status === 'active') q = q.where('orders.status', 'in', ['OPEN', 'BILLED']);
  else if (f.status !== 'all') q = q.where('orders.status', '=', f.status);
  if (f.type) q = q.where('orders.type', '=', f.type);
  if (f.held !== undefined)
    q = f.held ? q.where('orders.held_at', 'is not', null) : q.where('orders.held_at', 'is', null);
  const rows = await q.execute();
  const totals = await orderTotals(
    ctx.db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({
    id: r.id,
    orderNo: r.order_no,
    type: r.type,
    status: r.status,
    tableCode: r.table_code,
    guests: r.guests,
    openedAt: r.opened_at,
    held: r.held_at !== null,
    version: r.version,
    itemCount: totals.get(r.id)?.itemCount ?? 0,
    subtotalPaisa: totals.get(r.id)?.subtotalPaisa ?? 0,
  }));
}
