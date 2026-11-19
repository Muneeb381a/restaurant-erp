import { renderKot, type KotDoc } from '@erp/printing';
import type { AppContext } from '../../http/context';
import { AppError } from '../../http/errors';
import { withTx, type Queryable } from '../../shared/tx';
import { writeAudit } from '../audit/audit.service';
import { assertEditable, checkVersion, type Actor } from '../orders/orders.service';
import { bumpVersion, getOrderFull, lockOrder, nextDocNo } from '../orders/orders.repo';
import { enqueuePrintJob, stationPrinters } from '../printing/print.service';
import { clockTime, loadTicketContext, toKotLines } from './tickets';

export interface SendInput {
  rush?: boolean | undefined;
  /** Send only this course (e.g. starters first); default = everything not yet sent. */
  course?: number | undefined;
}

export interface SentKot {
  id: string;
  kotNo: number;
  station: string;
  lineCount: number;
  printers: number;
}

async function printOnSend(q: Queryable, branchId: string): Promise<boolean> {
  const s = await q
    .selectFrom('settings')
    .select('value')
    .where('branch_id', '=', branchId)
    .where('key', '=', 'kot.print_on_send')
    .executeTakeFirst();
  return s ? s.value !== false : true;
}

/**
 * "Send to kitchen": ONE transaction that turns the order's NEW lines into one KOT per station,
 * marks them SENT, and queues a print job per station printer. Deal components go to the
 * stations of their own items. Nothing is half-sent: a line without a station aborts the whole
 * send (STATION_MISSING). Sending twice finds nothing new (NOTHING_TO_SEND).
 */
export function sendToKitchen(
  ctx: AppContext,
  a: Actor,
  orderId: string,
  input: SendInput,
  ifMatch: number | undefined,
) {
  return withTx(ctx.db, async (trx) => {
    const order = await lockOrder(trx, a.branchId, orderId);
    assertEditable(order);
    checkVersion(order, ifMatch, false);

    let q = trx
      .selectFrom('order_items')
      .selectAll()
      .where('order_id', '=', orderId)
      .where('status', '=', 'NEW');
    if (input.course !== undefined) q = q.where('course', '=', input.course);
    const fresh = await q.orderBy('created_at').orderBy('id').execute();
    if (fresh.length === 0)
      throw new AppError(409, 'NOTHING_TO_SEND', 'There is nothing new to send to the kitchen');

    // Deal parents carry the price but produce no ticket; their components do.
    const parentIds = new Set(
      fresh.map((l) => l.parent_order_item_id).filter((x): x is string => !!x),
    );
    const parents = fresh.filter((l) => parentIds.has(l.id));
    const printable = fresh.filter((l) => !parentIds.has(l.id));

    // A line remembers the station its dish had WHEN IT WAS ADDED. If the station was set up (or changed)
    // afterwards, that memory is stale: look the dish up again now, so fixing the menu is enough.
    const stale = printable.filter((l) => !l.station_id);
    if (stale.length) {
      const now = await trx
        .selectFrom('items')
        .innerJoin('stations', 'stations.id', 'items.station_id')
        .select(['items.id as item_id', 'items.station_id as station_id'])
        .where('items.id', 'in', [...new Set(stale.map((l) => l.item_id))])
        .where('stations.archived_at', 'is', null)
        .execute();
      const byItem = new Map(now.map((r) => [r.item_id, r.station_id as string]));
      for (const l of stale) {
        const sid = byItem.get(l.item_id);
        if (!sid) continue;
        await trx
          .updateTable('order_items')
          .set({ station_id: sid })
          .where('id', '=', l.id)
          .execute();
        l.station_id = sid;
      }
    }

    const missing = printable.filter((l) => !l.station_id);
    if (missing.length) {
      const names = [...new Set(missing.map((l) => l.name_snapshot))];
      throw new AppError(
        409,
        'STATION_MISSING',
        `These dishes have no kitchen station: ${names.join(', ')}. Open Admin, Menu, choose the dish and pick its station (Karahi, Grill, ...), then send again.`,
        { items: names },
      );
    }

    const byStation = new Map<string, typeof printable>();
    for (const l of printable)
      byStation.set(l.station_id as string, [...(byStation.get(l.station_id as string) ?? []), l]);

    const now = ctx.clock.now();
    const info = await loadTicketContext(trx, orderId, a.userId);
    const printing = await printOnSend(trx, a.branchId);
    const sent: SentKot[] = [];
    const unprinted: string[] = [];

    for (const [stationId, lines] of byStation) {
      const station = await trx
        .selectFrom('stations')
        .select('code')
        .where('id', '=', stationId)
        .executeTakeFirstOrThrow();
      const kotNo = await nextDocNo(trx, a.branchId, order.business_day_id, 'KOT');
      const kot = await trx
        .insertInto('kots')
        .values({
          branch_id: a.branchId,
          business_day_id: order.business_day_id,
          order_id: orderId,
          station_id: stationId,
          kot_no: kotNo,
          is_rush: !!input.rush,
          created_by: a.userId,
          created_at: now,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('order_items')
        .set({ kot_id: kot.id, status: 'SENT' })
        .where(
          'id',
          'in',
          lines.map((l) => l.id),
        )
        .execute();

      const printers = printing ? await stationPrinters(trx, a.branchId, stationId) : [];
      if (printing && printers.length === 0) unprinted.push(station.code);
      const doc: KotDoc = {
        kind: 'KOT',
        kotNo,
        station: station.code,
        orderNo: info.orderNo,
        orderType: info.orderType,
        tableCode: info.tableCode,
        waiter: info.waiter,
        time: clockTime(now, info.timeZone),
        rush: !!input.rush,
        lines: await toKotLines(trx, lines),
      };
      for (const p of printers) {
        await enqueuePrintJob(trx, {
          branchId: a.branchId,
          printerId: p.id,
          kind: 'KOT',
          refType: 'kot',
          refId: kot.id,
          title: `KOT #${kotNo} ${station.code}`,
          payload: renderKot(doc, p.paper_mm as 58 | 80),
          idempotencyKey: `kot:${kot.id}:p0:${p.id}`,
          createdBy: a.userId,
          at: now,
        });
      }
      if (printers.length)
        await trx.updateTable('kots').set({ print_count: 1 }).where('id', '=', kot.id).execute();
      sent.push({
        id: kot.id,
        kotNo,
        station: station.code,
        lineCount: lines.length,
        printers: printers.length,
      });
    }

    if (parents.length)
      await trx
        .updateTable('order_items')
        .set({ status: 'SENT' })
        .where(
          'id',
          'in',
          parents.map((l) => l.id),
        )
        .execute();
    await bumpVersion(trx, orderId);
    return { order: await getOrderFull(trx, a.branchId, orderId), kots: sent, unprinted };
  });
}

/** Prints a KOT again ("REPRINT #n"). Needs `kot.reprint` and a reason, and is audited (rule 7). */
export function reprintKot(ctx: AppContext, a: Actor, kotId: string, reason: string) {
  return withTx(ctx.db, async (trx) => {
    const kot = await trx
      .selectFrom('kots')
      .innerJoin('stations', 'stations.id', 'kots.station_id')
      .select([
        'kots.id as id',
        'kots.kot_no as kot_no',
        'kots.order_id as order_id',
        'kots.station_id as station_id',
        'kots.is_rush as is_rush',
        'kots.print_count as print_count',
        'stations.code as station',
      ])
      .where('kots.id', '=', kotId)
      .where('kots.branch_id', '=', a.branchId)
      .forUpdate('kots')
      .executeTakeFirst();
    if (!kot) throw new AppError(404, 'NOT_FOUND', 'KOT not found');

    const lines = await trx
      .selectFrom('order_items')
      .selectAll()
      .where('kot_id', '=', kotId)
      .where('status', '!=', 'VOID')
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    if (lines.length === 0)
      throw new AppError(409, 'NOTHING_TO_SEND', 'Every line of this KOT was voided');
    const printers = await stationPrinters(trx, a.branchId, kot.station_id);
    if (printers.length === 0)
      throw new AppError(409, 'NO_PRINTER', `Station ${kot.station} has no printer`);

    const now = ctx.clock.now();
    const reprintNo = Math.max(1, kot.print_count);
    const info = await loadTicketContext(trx, kot.order_id, a.userId);
    const doc: KotDoc = {
      kind: 'KOT',
      kotNo: kot.kot_no,
      station: kot.station,
      orderNo: info.orderNo,
      orderType: info.orderType,
      tableCode: info.tableCode,
      waiter: info.waiter,
      time: clockTime(now, info.timeZone),
      rush: kot.is_rush,
      reprint: reprintNo,
      lines: await toKotLines(trx, lines),
    };
    for (const p of printers) {
      await enqueuePrintJob(trx, {
        branchId: a.branchId,
        printerId: p.id,
        kind: 'KOT',
        refType: 'kot',
        refId: kotId,
        title: `REPRINT #${reprintNo} KOT #${kot.kot_no} ${kot.station}`,
        payload: renderKot(doc, p.paper_mm as 58 | 80),
        idempotencyKey: `kot:${kotId}:p${reprintNo}:${p.id}`,
        createdBy: a.userId,
        at: now,
      });
    }
    await trx
      .updateTable('kots')
      .set({ print_count: kot.print_count + 1 })
      .where('id', '=', kotId)
      .execute();
    await writeAudit(trx, {
      branchId: a.branchId,
      userId: a.userId,
      deviceId: a.deviceId,
      action: 'KOT_REPRINT',
      entity: 'kot',
      entityId: kotId,
      before: { printCount: kot.print_count },
      after: { printCount: kot.print_count + 1, reprint: reprintNo, printers: printers.length },
      reason,
      ip: a.ip,
    });
    return {
      id: kotId,
      kotNo: kot.kot_no,
      station: kot.station,
      reprint: reprintNo,
      printers: printers.length,
    };
  });
}

export async function listKots(ctx: AppContext, branchId: string, orderId?: string) {
  let q = ctx.db
    .selectFrom('kots')
    .innerJoin('stations', 'stations.id', 'kots.station_id')
    .innerJoin('orders', 'orders.id', 'kots.order_id')
    .select([
      'kots.id as id',
      'kots.kot_no as kot_no',
      'kots.order_id as order_id',
      'orders.order_no as order_no',
      'stations.code as station',
      'kots.status as status',
      'kots.is_rush as is_rush',
      'kots.print_count as print_count',
      'kots.created_at as created_at',
    ])
    .where('kots.branch_id', '=', branchId)
    .orderBy('kots.created_at', 'desc')
    .orderBy('kots.kot_no', 'desc')
    .limit(200);
  if (orderId) q = q.where('kots.order_id', '=', orderId);
  const rows = await q.execute();
  return rows.map((k) => ({
    id: k.id,
    kotNo: k.kot_no,
    orderId: k.order_id,
    orderNo: k.order_no,
    station: k.station,
    status: k.status,
    rush: k.is_rush,
    printCount: k.print_count,
    createdAt: k.created_at,
  }));
}

export async function getKot(ctx: AppContext, branchId: string, kotId: string) {
  const kot = (await listKots(ctx, branchId)).find((k) => k.id === kotId);
  if (!kot) throw new AppError(404, 'NOT_FOUND', 'KOT not found');
  const lines = await ctx.db
    .selectFrom('order_items')
    .selectAll()
    .where('kot_id', '=', kotId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  const kotLines = await toKotLines(ctx.db, lines);
  return {
    ...kot,
    lines: lines.map((l, i) => ({
      id: l.id,
      status: l.status,
      voidReason: l.void_reason,
      ...kotLines[i]!,
    })),
  };
}

// ──────────────────────────────── kitchen display ────────────────────────────────

export type KotStatus = 'NEW' | 'PREPARING' | 'READY' | 'DONE';

/** Which moves a ticket may make. One step back is allowed so a mis-tap can be undone. */
const MOVES: Record<KotStatus, KotStatus[]> = {
  NEW: ['PREPARING', 'READY'],
  PREPARING: ['READY', 'NEW'],
  READY: ['DONE', 'PREPARING'],
  DONE: ['READY'],
};
/** The line status that matches each ticket status. */
const LINE_STATUS: Record<KotStatus, 'SENT' | 'PREPARING' | 'READY' | 'SERVED'> = {
  NEW: 'SENT',
  PREPARING: 'PREPARING',
  READY: 'READY',
  DONE: 'SERVED',
};

/**
 * Every ticket still in the kitchen (new, preparing, ready) plus tickets served in the last
 * 30 minutes, each with its lines, so the screen can show the whole board in one request.
 */
export async function kitchenBoard(ctx: AppContext, branchId: string, stationCode?: string) {
  const now = ctx.clock.now();
  const since = new Date(now.getTime() - 30 * 60_000);
  let q = ctx.db
    .selectFrom('kots')
    .innerJoin('stations', 'stations.id', 'kots.station_id')
    .innerJoin('orders', 'orders.id', 'kots.order_id')
    .innerJoin('business_days', 'business_days.id', 'kots.business_day_id')
    .leftJoin('dining_tables', 'dining_tables.id', 'orders.table_id')
    .leftJoin('users', 'users.id', 'orders.waiter_id')
    .select([
      'kots.id as id',
      'kots.kot_no as kotNo',
      'kots.status as status',
      'kots.is_rush as rush',
      'kots.created_at as createdAt',
      'kots.started_at as startedAt',
      'kots.ready_at as readyAt',
      'kots.done_at as doneAt',
      'stations.code as stationCode',
      'stations.name as stationName',
      'orders.id as orderId',
      'orders.order_no as orderNo',
      'orders.type as orderType',
      'dining_tables.code as tableCode',
      'users.full_name as waiter',
    ])
    .where('kots.branch_id', '=', branchId)
    // only today's trading: tickets left over from a closed day must never clutter the screen
    .where('business_days.status', '=', 'OPEN')
    .where('orders.status', '<>', 'CANCELLED')
    .where((eb) =>
      eb.or([
        eb('kots.status', 'in', ['NEW', 'PREPARING', 'READY']),
        eb.and([eb('kots.status', '=', 'DONE'), eb('kots.done_at', '>=', since)]),
      ]),
    )
    .orderBy('kots.created_at');
  if (stationCode) q = q.where('stations.code', '=', stationCode);
  const tickets = await q.execute();
  const lines = tickets.length
    ? await ctx.db
        .selectFrom('order_items')
        .selectAll()
        .where(
          'kot_id',
          'in',
          tickets.map((t) => t.id),
        )
        .orderBy('created_at')
        .orderBy('id')
        .execute()
    : [];
  const doc = await toKotLines(ctx.db, lines);
  const stations = await ctx.db
    .selectFrom('stations')
    .select(['code', 'name'])
    .where('branch_id', '=', branchId)
    .where('archived_at', 'is', null)
    .orderBy('name')
    .execute();
  return {
    now,
    stations,
    tickets: tickets.map((t) => ({
      ...t,
      lines: lines
        .map((l, i) => ({ l, d: doc[i]! }))
        .filter((x) => x.l.kot_id === t.id)
        .map((x) => ({
          id: x.l.id,
          qty: x.d.qty,
          name: x.d.name,
          weightG: x.d.weightG,
          modifiers: x.d.modifiers,
          note: x.d.note,
          fromDeal: x.d.fromDeal,
          voided: x.l.status === 'VOID',
        })),
    })),
  };
}

/** Moves a ticket (and its lines) one step on the kitchen board. */
export function setKotStatus(ctx: AppContext, a: Actor, kotId: string, to: KotStatus) {
  return withTx(ctx.db, async (trx) => {
    const kot = await trx
      .selectFrom('kots')
      .selectAll()
      .where('id', '=', kotId)
      .where('branch_id', '=', a.branchId)
      .forUpdate()
      .executeTakeFirst();
    if (!kot) throw new AppError(404, 'NOT_FOUND', 'ticket not found');
    const from = kot.status as KotStatus | 'CANCELLED';
    if (from === 'CANCELLED') throw new AppError(409, 'KOT_CANCELLED', 'This ticket was cancelled');
    if (from === to) return { id: kot.id, status: to };
    if (!MOVES[from].includes(to))
      throw new AppError(409, 'KOT_BAD_MOVE', `A ticket cannot go from ${from} to ${to}`);
    // moving on to "served" is the waiter's step; the other steps are the kitchen's
    const needed = to === 'DONE' ? 'kitchen.serve' : 'kitchen.update';
    if (!a.permissions.has(needed) && !(to === 'DONE' && a.permissions.has('kitchen.update')))
      throw new AppError(403, 'PERMISSION_DENIED', 'You do not have permission for this action', {
        permission: needed,
      });
    const now = ctx.clock.now();
    await trx
      .updateTable('kots')
      .set({
        status: to,
        started_at: to === 'NEW' ? null : (kot.started_at ?? now),
        ready_at: to === 'READY' ? now : to === 'DONE' ? (kot.ready_at ?? now) : null,
        done_at: to === 'DONE' ? now : null,
      })
      .where('id', '=', kotId)
      .execute();
    await trx
      .updateTable('order_items')
      .set({ status: LINE_STATUS[to] })
      .where('kot_id', '=', kotId)
      .where('status', '!=', 'VOID')
      .execute();
    return { id: kot.id, status: to };
  });
}
