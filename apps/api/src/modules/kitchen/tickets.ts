import { createHash } from 'node:crypto';
import { renderKot, type KotDoc, type KotLine } from '@erp/printing';
import type { Selectable } from 'kysely';
import type { OrderItems } from '../../db/types';
import type { Queryable } from '../../shared/tx';
import { enqueuePrintJob, stationPrinters } from '../printing/print.service';

export type OrderItemRow = Selectable<OrderItems>;

/** "19:42" in the branch's timezone. */
export function clockTime(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
}

export interface TicketContext {
  orderNo: number;
  orderType: KotDoc['orderType'];
  tableCode: string | null;
  waiter: string | null;
  timeZone: string;
}

export async function loadTicketContext(
  q: Queryable,
  orderId: string,
  waiterId: string | null,
): Promise<TicketContext> {
  const o = await q
    .selectFrom('orders')
    .leftJoin('dining_tables', 'dining_tables.id', 'orders.table_id')
    .innerJoin('branches', 'branches.id', 'orders.branch_id')
    .select([
      'orders.order_no as order_no',
      'orders.type as type',
      'dining_tables.code as table_code',
      'branches.timezone as tz',
    ])
    .where('orders.id', '=', orderId)
    .executeTakeFirstOrThrow();
  const waiter = waiterId
    ? await q.selectFrom('users').select('full_name').where('id', '=', waiterId).executeTakeFirst()
    : undefined;
  return {
    orderNo: o.order_no,
    orderType: o.type as KotDoc['orderType'],
    tableCode: o.table_code,
    waiter: waiter?.full_name ?? null,
    timeZone: o.tz,
  };
}

/** Order lines → ticket lines (modifier names, the deal a component belongs to, notes). */
export async function toKotLines(q: Queryable, lines: readonly OrderItemRow[]): Promise<KotLine[]> {
  if (lines.length === 0) return [];
  const mods = await q
    .selectFrom('order_item_modifiers')
    .select(['order_item_id', 'name_snapshot'])
    .where(
      'order_item_id',
      'in',
      lines.map((l) => l.id),
    )
    .execute();
  const parentIds = [
    ...new Set(lines.map((l) => l.parent_order_item_id).filter((x): x is string => !!x)),
  ];
  const parents = parentIds.length
    ? await q
        .selectFrom('order_items')
        .select(['id', 'name_snapshot'])
        .where('id', 'in', parentIds)
        .execute()
    : [];
  return lines.map((l) => ({
    qty: Number(l.qty),
    name: l.name_snapshot,
    weightG: l.weight_g,
    modifiers: mods.filter((m) => m.order_item_id === l.id).map((m) => m.name_snapshot),
    note: l.note,
    course: l.course,
    fromDeal: parents.find((p) => p.id === l.parent_order_item_id)?.name_snapshot ?? null,
  }));
}

/**
 * Cancel tickets for lines that were voided after the kitchen saw them ("stop making this").
 * One ticket per original KOT, printed on that station's printers. Returns the number of jobs.
 */
export async function queueCancelTickets(
  q: Queryable,
  a: { branchId: string; userId: string },
  orderId: string,
  lineIds: readonly string[],
  reason: string,
  at: Date,
): Promise<number> {
  const lines = await q
    .selectFrom('order_items')
    .selectAll()
    .where('id', 'in', [...lineIds])
    .where('kot_id', 'is not', null)
    .execute();
  if (lines.length === 0) return 0;
  const ctxInfo = await loadTicketContext(q, orderId, a.userId);
  let jobs = 0;

  for (const kotId of [...new Set(lines.map((l) => l.kot_id as string))]) {
    const kot = await q
      .selectFrom('kots')
      .innerJoin('stations', 'stations.id', 'kots.station_id')
      .select([
        'kots.id as id',
        'kots.kot_no as kot_no',
        'kots.station_id as station_id',
        'stations.code as station',
      ])
      .where('kots.id', '=', kotId)
      .executeTakeFirstOrThrow();
    const mine = lines.filter((l) => l.kot_id === kotId);
    const ticketLines = await toKotLines(q, mine);
    const key = createHash('sha1')
      .update(
        mine
          .map((l) => l.id)
          .sort()
          .join(','),
      )
      .digest('hex')
      .slice(0, 20);

    for (const printer of await stationPrinters(q, a.branchId, kot.station_id)) {
      const doc: KotDoc = {
        kind: 'CANCEL',
        kotNo: kot.kot_no,
        station: kot.station,
        orderNo: ctxInfo.orderNo,
        orderType: ctxInfo.orderType,
        tableCode: ctxInfo.tableCode,
        waiter: ctxInfo.waiter,
        time: clockTime(at, ctxInfo.timeZone),
        reason,
        lines: ticketLines,
      };
      const inserted = await enqueuePrintJob(q, {
        branchId: a.branchId,
        printerId: printer.id,
        kind: 'KOT_CANCEL',
        refType: 'kot',
        refId: kotId,
        title: `CANCEL KOT #${kot.kot_no} ${kot.station}`,
        payload: renderKot(doc, printer.paper_mm as 58 | 80),
        idempotencyKey: `kotcancel:${kotId}:${key}:${printer.id}`,
        createdBy: a.userId,
        at,
      });
      if (inserted) jobs++;
    }
  }
  return jobs;
}
