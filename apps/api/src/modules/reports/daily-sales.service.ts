import {
  buildDailySales,
  type DailyBill,
  type DailyLine,
  type DailyRefund,
  type DailySales,
} from '@erp/domain';
import { sql } from 'kysely';
import type { AppContext } from '../../http/context';

/**
 * Everything the daily sales report shows, for one calendar day in the shop's own time zone (a business day can stay
 * open for days, so the bill's own date is what counts, the same as on the Bills screen).
 * Reports are the one module allowed to read other modules' tables (CLAUDE.md rule 8). All amounts are integer paisa.
 */

export interface DailyBillRow {
  billNo: number;
  orderNo: number | null;
  /** HH:mm in the shop's time. */
  time: string;
  where: string;
  customer: string | null;
  channel: string;
  methods: string;
  subtotalPaisa: number;
  discountPaisa: number;
  serviceChargePaisa: number;
  taxPaisa: number;
  totalPaisa: number;
  status: 'SETTLED' | 'PRE_BILLED';
  refundedPaisa: number;
  /** What was actually received for it (the sum of its payments, change excluded). */
  paidPaisa: number;
}

export interface DailySalesReport {
  date: string;
  branch: { name: string; address: string | null; phone: string | null; timezone: string };
  generatedAt: string;
  sales: DailySales;
  bills: DailyBillRow[];
  refunds: {
    cnNo: number;
    billNo: number;
    time: string;
    totalPaisa: number;
    method: string;
    reason: string;
  }[];
  voids: { lines: number; paisa: number };
  discounts: { billNo: number; discountPaisa: number; reason: string | null }[];
}

const big = (e: ReturnType<typeof sql>) => sql<number>`COALESCE(${e}, 0)::bigint`;

export async function dailySalesReport(
  ctx: AppContext,
  branchId: string,
  date: string,
): Promise<DailySalesReport> {
  const db = ctx.db;
  const branch = await db
    .selectFrom('branches')
    .select(['name', 'address', 'phone', 'timezone'])
    .where('id', '=', branchId)
    .executeTakeFirstOrThrow();
  const tz = branch.timezone;
  const at = sql`COALESCE(b.settled_at, b.created_at)`;

  const rows = await sql<{
    id: string;
    bill_no: number;
    order_no: number | null;
    status: 'SETTLED' | 'PRE_BILLED';
    order_type: DailyBill['orderType'];
    channel: string | null;
    table_code: string | null;
    customer: string | null;
    subtotal: number;
    discount: number;
    service: number;
    tax: number;
    round_off: number;
    total: number;
    hour: number;
    time: string;
    cashier: string | null;
    discount_reason: string | null;
  }>`
    SELECT b.id, b.bill_no, o.order_no, b.status, o.type AS order_type, o.channel,
           t.code AS table_code, o.customer_name AS customer,
           ${big(sql`b.subtotal_paisa`)} AS subtotal, ${big(sql`b.discount_paisa`)} AS discount,
           ${big(sql`b.service_charge_paisa`)} AS service, ${big(sql`b.tax_paisa`)} AS tax,
           ${big(sql`b.round_off_paisa`)} AS round_off, ${big(sql`b.total_paisa`)} AS total,
           extract(hour FROM (${at} AT TIME ZONE ${tz}))::int AS hour,
           to_char(${at} AT TIME ZONE ${tz}, 'HH24:MI') AS time,
           u.full_name AS cashier, b.discount_reason
      FROM bills b
      LEFT JOIN orders o ON o.id = b.order_id
      LEFT JOIN dining_tables t ON t.id = o.table_id
      LEFT JOIN users u ON u.id = COALESCE(b.settled_by, b.created_by)
     WHERE b.branch_id = ${branchId} AND b.status IN ('SETTLED', 'PRE_BILLED')
       AND (${at} AT TIME ZONE ${tz})::date = ${date}::date
     ORDER BY ${at}, b.bill_no`.execute(db);

  const ids = rows.rows.map((r) => r.id);
  const pays = ids.length
    ? await sql<{ bill_id: string; method: string; amount: number; tip: number }>`
        SELECT p.bill_id, m.name AS method, ${big(sql`p.amount_paisa`)} AS amount, ${big(sql`p.tip_paisa`)} AS tip
          FROM payments p JOIN payment_methods m ON m.id = p.method_id
         WHERE p.bill_id IN (${sql.join(ids)})
         ORDER BY p.received_at`.execute(db)
    : { rows: [] };
  const lines = ids.length
    ? await sql<{
        bill_id: string;
        name: string;
        category: string | null;
        qty: number;
        net: number;
      }>`
        SELECT l.bill_id, l.description AS name, c.name AS category,
               COALESCE(l.qty, 0)::float8 AS qty, ${big(sql`l.net_paisa`)} AS net
          FROM bill_lines l
          LEFT JOIN order_items oi ON oi.id = l.order_item_id
          LEFT JOIN items i ON i.id = oi.item_id
          LEFT JOIN categories c ON c.id = i.category_id
         WHERE l.bill_id IN (${sql.join(ids)}) AND l.line_kind <> 'ADJUSTMENT'`.execute(db)
    : { rows: [] };

  const refundRows = await sql<{
    cn_no: number;
    bill_no: number;
    time: string;
    total: number;
    method: string | null;
    reason: string;
  }>`
    SELECT c.cn_no, b.bill_no, to_char(c.created_at AT TIME ZONE ${tz}, 'HH24:MI') AS time,
           ${big(sql`c.total_paisa`)} AS total, m.name AS method, c.reason
      FROM credit_notes c JOIN bills b ON b.id = c.bill_id
      LEFT JOIN payment_methods m ON m.id = c.refund_method_id
     WHERE c.branch_id = ${branchId} AND (c.created_at AT TIME ZONE ${tz})::date = ${date}::date
     ORDER BY c.created_at`.execute(db);

  const voided = await sql<{ n: number; paisa: number }>`
    SELECT COUNT(*)::int AS n, ${big(sql`SUM(oi.line_total_paisa)`)} AS paisa
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.branch_id = ${branchId} AND oi.status = 'VOID' AND oi.kot_id IS NOT NULL
       AND (oi.voided_at AT TIME ZONE ${tz})::date = ${date}::date`.execute(db);

  const payByBill = new Map<string, { method: string; amountPaisa: number; tipPaisa: number }[]>();
  for (const p of pays.rows) {
    const list = payByBill.get(p.bill_id) ?? [];
    list.push({ method: p.method, amountPaisa: p.amount, tipPaisa: p.tip });
    payByBill.set(p.bill_id, list);
  }
  const refundedByBill = new Map<number, number>();
  for (const r of refundRows.rows)
    refundedByBill.set(r.bill_no, (refundedByBill.get(r.bill_no) ?? 0) + r.total);

  const dailyBills: DailyBill[] = rows.rows.map((r) => ({
    id: r.id,
    billNo: r.bill_no,
    orderNo: r.order_no,
    status: r.status,
    orderType: r.order_type,
    channel: r.channel,
    subtotalPaisa: r.subtotal,
    discountPaisa: r.discount,
    serviceChargePaisa: r.service,
    taxPaisa: r.tax,
    roundOffPaisa: r.round_off,
    totalPaisa: r.total,
    hour: r.hour,
    cashier: r.cashier,
    payments: payByBill.get(r.id) ?? [],
  }));
  const dailyRefunds: DailyRefund[] = refundRows.rows.map((r) => ({
    amountPaisa: r.total,
    method: r.method ?? 'Unspecified',
  }));
  const dailyLines: DailyLine[] = lines.rows.map((l) => ({
    billId: l.bill_id,
    name: l.name,
    category: l.category,
    qty: l.qty,
    netPaisa: l.net,
  }));

  const typeLabel = { DINE_IN: 'Dine-in', TAKEAWAY: 'Takeaway', DELIVERY: 'Delivery' } as const;
  return {
    date,
    branch,
    generatedAt: new Date().toISOString(),
    sales: buildDailySales(dailyBills, dailyRefunds, dailyLines),
    bills: rows.rows.map((r) => ({
      billNo: r.bill_no,
      orderNo: r.order_no,
      time: r.time,
      where: r.table_code
        ? `Table ${r.table_code}`
        : r.order_type
          ? typeLabel[r.order_type]
          : 'Counter',
      customer: r.customer,
      channel: r.channel ?? 'POS',
      methods: [...new Set((payByBill.get(r.id) ?? []).map((p) => p.method))].join(', '),
      subtotalPaisa: r.subtotal,
      discountPaisa: r.discount,
      serviceChargePaisa: r.service,
      taxPaisa: r.tax,
      totalPaisa: r.total,
      status: r.status,
      refundedPaisa: refundedByBill.get(r.bill_no) ?? 0,
      paidPaisa: (payByBill.get(r.id) ?? []).reduce((n, p) => n + p.amountPaisa, 0),
    })),
    refunds: refundRows.rows.map((r) => ({
      cnNo: r.cn_no,
      billNo: r.bill_no,
      time: r.time,
      totalPaisa: r.total,
      method: r.method ?? 'Unspecified',
      reason: r.reason,
    })),
    voids: { lines: voided.rows[0]?.n ?? 0, paisa: voided.rows[0]?.paisa ?? 0 },
    discounts: rows.rows
      .filter((r) => r.status === 'SETTLED' && r.discount > 0)
      .map((r) => ({ billNo: r.bill_no, discountPaisa: r.discount, reason: r.discount_reason })),
  };
}
