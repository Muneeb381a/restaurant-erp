import { sql } from 'kysely';
import type { AppContext } from '../../http/context';
import { AppError } from '../../http/errors';
import { listIngredients, listSuppliers } from '../inventory/inventory.service';

/**
 * Owner dashboard: one read-only snapshot for a range of business dates.
 * Reports are the one module allowed to read other modules' tables (CLAUDE.md rule 8). Every
 * amount is integer paisa; SUMs are cast to bigint so the pg parser returns numbers.
 *
 * Definitions (also printed on the dashboard, so the owner can check them):
 *  - net sales  = Σ(subtotal − discount + service charge) of settled bills − refunds (net of tax).
 *                 Tax is money collected for the authority, never part of sales or profit.
 *  - cost of food = Σ cost snapshot of settled order lines (recipes × weighted-average cost).
 *  - gross profit = net sales − cost of food.
 *  - net profit   = gross profit − expenses (rent, salaries, gas… entered under Costs).
 *    Stock purchases are not expenses: the food they become is counted when it is sold.
 */

const TZ = 'Asia/Karachi'; // Pakistan has no daylight saving; hours on the chart are local hours
const big = (e: ReturnType<typeof sql>) => sql<number>`COALESCE(${e}, 0)::bigint`;

export interface PeriodSummary {
  bills: number;
  covers: number;
  grossSalesPaisa: number;
  discountPaisa: number;
  servicePaisa: number;
  refundsPaisa: number;
  netSalesPaisa: number;
  taxPaisa: number;
  avgBillPaisa: number;
  costOfFoodPaisa: number;
  grossProfitPaisa: number;
  expensesPaisa: number;
  netProfitPaisa: number;
  purchasesPaisa: number;
  /** Cost of food as basis points of net sales; null when there are no sales. */
  foodCostBps: number | null;
  netMarginBps: number | null;
  /** Settled lines sold without a recipe cost: profit is overstated by their real cost. */
  uncostedLines: number;
}

const bps = (part: number, whole: number): number | null =>
  whole > 0 ? Math.round((part * 10_000) / whole) : null;

const NET = sql`(b.subtotal_paisa - b.discount_paisa + b.service_charge_paisa)`;

async function summary(
  ctx: AppContext,
  branchId: string,
  from: string,
  to: string,
): Promise<PeriodSummary> {
  const db = ctx.db;
  const [bills, refunds, cost, exp, buy, covers] = await Promise.all([
    sql<{
      n: number;
      subtotal: number;
      discount: number;
      service: number;
      tax: number;
    }>`SELECT count(*)::int AS n, ${big(sql`sum(b.subtotal_paisa)`)} AS subtotal,
              ${big(sql`sum(b.discount_paisa)`)} AS discount,
              ${big(sql`sum(b.service_charge_paisa)`)} AS service,
              ${big(sql`sum(b.tax_paisa)`)} AS tax
       FROM bills b JOIN business_days d ON d.id = b.business_day_id
       WHERE b.branch_id = ${branchId} AND b.status = 'SETTLED'
         AND d.business_date BETWEEN ${from} AND ${to}`.execute(db),
    sql<{ net: number }>`SELECT ${big(sql`sum(c.net_paisa)`)} AS net
       FROM credit_notes c JOIN business_days d ON d.id = c.business_day_id
       WHERE c.branch_id = ${branchId} AND d.business_date BETWEEN ${from} AND ${to}`.execute(db),
    sql<{ cost: number; uncosted: number }>`SELECT ${big(sql`sum(oi.cost_paisa_snapshot)`)} AS cost,
              count(*) FILTER (WHERE oi.cost_paisa_snapshot IS NULL AND oi.parent_order_item_id IS NULL)::int AS uncosted
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
       JOIN business_days d ON d.id = o.business_day_id
       WHERE o.branch_id = ${branchId} AND o.status = 'SETTLED' AND oi.status <> 'VOID'
         AND d.business_date BETWEEN ${from} AND ${to}`.execute(db),
    sql<{ total: number }>`SELECT ${big(sql`sum(e.amount_paisa)`)} AS total
       FROM expenses e JOIN business_days d ON d.id = e.business_day_id
       WHERE e.branch_id = ${branchId} AND d.business_date BETWEEN ${from} AND ${to}`.execute(db),
    sql<{ total: number }>`SELECT ${big(sql`sum(p.total_paisa)`)} AS total
       FROM purchases p JOIN business_days d ON d.id = p.business_day_id
       WHERE p.branch_id = ${branchId} AND d.business_date BETWEEN ${from} AND ${to}`.execute(db),
    sql<{ covers: number }>`SELECT ${big(sql`sum(o.guests)`)} AS covers
       FROM orders o JOIN business_days d ON d.id = o.business_day_id
       WHERE o.branch_id = ${branchId} AND o.status = 'SETTLED'
         AND d.business_date BETWEEN ${from} AND ${to}`.execute(db),
  ]);
  const b = bills.rows[0]!;
  const refundsPaisa = refunds.rows[0]!.net;
  const net = b.subtotal - b.discount + b.service - refundsPaisa;
  const food = cost.rows[0]!.cost;
  const expenses = exp.rows[0]!.total;
  return {
    bills: b.n,
    covers: covers.rows[0]!.covers,
    grossSalesPaisa: b.subtotal,
    discountPaisa: b.discount,
    servicePaisa: b.service,
    refundsPaisa,
    netSalesPaisa: net,
    taxPaisa: b.tax,
    avgBillPaisa: b.n > 0 ? Math.round((b.subtotal - b.discount + b.service) / b.n) : 0,
    costOfFoodPaisa: food,
    grossProfitPaisa: net - food,
    expensesPaisa: expenses,
    netProfitPaisa: net - food - expenses,
    purchasesPaisa: buy.rows[0]!.total,
    foodCostBps: bps(food, net),
    netMarginBps: bps(net - food - expenses, net),
    uncostedLines: cost.rows[0]!.uncosted,
  };
}

const addDays = (iso: string, n: number): string =>
  new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

export async function dashboard(ctx: AppContext, branchId: string, from: string, to: string) {
  const n = daysBetween(from, to);
  if (n < 1 || n > 366)
    throw new AppError(400, 'VALIDATION_FAILED', 'Choose a range of 1 to 366 days');
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(from, -n);
  const db = ctx.db;

  const [
    current,
    previous,
    billDays,
    expDays,
    costDays,
    hourly,
    methods,
    types,
    items,
    categories,
    expCats,
    discount,
    voids,
    comps,
    refundsC,
    drawer,
    variance,
    waste,
    khata,
    ingredients,
    suppliers,
    open,
    users,
  ] = await Promise.all([
    summary(ctx, branchId, from, to),
    summary(ctx, branchId, prevFrom, prevTo),
    sql<{ date: string; sales: number; bills: number }>`SELECT d.business_date::text AS date,
         ${big(sql`sum(${NET})`)} AS sales, count(*)::int AS bills
       FROM bills b JOIN business_days d ON d.id = b.business_day_id
       WHERE b.branch_id = ${branchId} AND b.status = 'SETTLED' AND d.business_date BETWEEN ${from} AND ${to}
       GROUP BY d.business_date`.execute(db),
    sql<{
      date: string;
      total: number;
    }>`SELECT d.business_date::text AS date, ${big(sql`sum(e.amount_paisa)`)} AS total
       FROM expenses e JOIN business_days d ON d.id = e.business_day_id
       WHERE e.branch_id = ${branchId} AND d.business_date BETWEEN ${from} AND ${to}
       GROUP BY d.business_date`.execute(db),
    sql<{
      date: string;
      total: number;
    }>`SELECT d.business_date::text AS date, ${big(sql`sum(oi.cost_paisa_snapshot)`)} AS total
       FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN business_days d ON d.id = o.business_day_id
       WHERE o.branch_id = ${branchId} AND o.status = 'SETTLED' AND oi.status <> 'VOID'
         AND d.business_date BETWEEN ${from} AND ${to}
       GROUP BY d.business_date`.execute(db),
    sql<{
      hour: number;
      sales: number;
      bills: number;
    }>`SELECT extract(hour FROM (b.settled_at AT TIME ZONE ${TZ}))::int AS hour,
         ${big(sql`sum(${NET})`)} AS sales, count(*)::int AS bills
       FROM bills b JOIN business_days d ON d.id = b.business_day_id
       WHERE b.branch_id = ${branchId} AND b.status = 'SETTLED' AND b.settled_at IS NOT NULL
         AND d.business_date BETWEEN ${from} AND ${to}
       GROUP BY 1 ORDER BY 1`.execute(db),
    sql<{
      code: string;
      method: string;
      isCash: boolean;
      count: number;
      amount: number;
    }>`SELECT m.code, m.name AS method,
         m.opens_drawer AS "isCash", count(*)::int AS count, ${big(sql`sum(p.amount_paisa)`)} AS amount
       FROM payments p JOIN payment_methods m ON m.id = p.method_id
       JOIN bills b ON b.id = p.bill_id JOIN business_days d ON d.id = b.business_day_id
       WHERE b.branch_id = ${branchId} AND d.business_date BETWEEN ${from} AND ${to}
       GROUP BY m.code, m.name, m.opens_drawer ORDER BY 5 DESC`.execute(db),
    sql<{
      type: string;
      bills: number;
      sales: number;
    }>`SELECT o.type, count(*)::int AS bills, ${big(sql`sum(${NET})`)} AS sales
       FROM bills b JOIN orders o ON o.id = b.order_id JOIN business_days d ON d.id = b.business_day_id
       WHERE b.branch_id = ${branchId} AND b.status = 'SETTLED' AND d.business_date BETWEEN ${from} AND ${to}
       GROUP BY o.type ORDER BY 3 DESC`.execute(db),
    sql<{
      name: string;
      qty: number;
      revenue: number;
      cost: number;
    }>`SELECT MAX(oi.name_snapshot) AS name,
         COALESCE(SUM(oi.qty) FILTER (WHERE oi.parent_order_item_id IS NULL), 0)::float8 AS qty,
         ${big(sql`sum(oi.line_total_paisa)`)} AS revenue, ${big(sql`sum(oi.cost_paisa_snapshot)`)} AS cost
       FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN business_days d ON d.id = o.business_day_id
       WHERE o.branch_id = ${branchId} AND o.status = 'SETTLED' AND oi.status <> 'VOID'
         AND d.business_date BETWEEN ${from} AND ${to}
       GROUP BY oi.item_id HAVING COALESCE(SUM(oi.qty) FILTER (WHERE oi.parent_order_item_id IS NULL), 0) > 0
       ORDER BY 4 DESC`.execute(db),
    sql<{
      name: string;
      revenue: number;
    }>`SELECT COALESCE(c.name, 'Uncategorised') AS name, ${big(sql`sum(oi.line_total_paisa)`)} AS revenue
       FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN business_days d ON d.id = o.business_day_id
       LEFT JOIN items i ON i.id = oi.item_id LEFT JOIN categories c ON c.id = i.category_id
       WHERE o.branch_id = ${branchId} AND o.status = 'SETTLED' AND oi.status <> 'VOID'
         AND d.business_date BETWEEN ${from} AND ${to}
       GROUP BY 1 ORDER BY 2 DESC`.execute(db),
    sql<{
      category: string;
      total: number;
    }>`SELECT e.category, ${big(sql`sum(e.amount_paisa)`)} AS total
       FROM expenses e JOIN business_days d ON d.id = e.business_day_id
       WHERE e.branch_id = ${branchId} AND d.business_date BETWEEN ${from} AND ${to}
       GROUP BY e.category ORDER BY 2 DESC`.execute(db),
    sql<{
      bills: number;
      total: number;
      approvals: number;
    }>`SELECT count(*) FILTER (WHERE b.discount_paisa > 0)::int AS bills,
         ${big(sql`sum(b.discount_paisa)`)} AS total,
         count(*) FILTER (WHERE b.discount_approved_by IS NOT NULL)::int AS approvals
       FROM bills b JOIN business_days d ON d.id = b.business_day_id
       WHERE b.branch_id = ${branchId} AND b.status = 'SETTLED' AND d.business_date BETWEEN ${from} AND ${to}`.execute(
      db,
    ),
    sql<{
      lines: number;
      total: number;
    }>`SELECT count(*)::int AS lines, ${big(sql`sum(oi.line_total_paisa)`)} AS total
       FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN business_days d ON d.id = o.business_day_id
       WHERE o.branch_id = ${branchId} AND oi.status = 'VOID' AND oi.void_reason IS NOT NULL
         AND d.business_date BETWEEN ${from} AND ${to}`.execute(db),
    sql<{
      lines: number;
      total: number;
    }>`SELECT count(*)::int AS lines, ${big(sql`sum(oi.line_total_paisa)`)} AS total
       FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN business_days d ON d.id = o.business_day_id
       WHERE o.branch_id = ${branchId} AND oi.is_complimentary AND oi.status <> 'VOID'
         AND d.business_date BETWEEN ${from} AND ${to}`.execute(db),
    sql<{
      count: number;
      total: number;
    }>`SELECT count(*)::int AS count, ${big(sql`sum(c.total_paisa)`)} AS total
       FROM credit_notes c JOIN business_days d ON d.id = c.business_day_id
       WHERE c.branch_id = ${branchId} AND d.business_date BETWEEN ${from} AND ${to}`.execute(db),
    sql<{
      kind: string;
      n: number;
      total: number;
    }>`SELECT m.kind, count(*)::int AS n, ${big(sql`sum(m.amount_paisa)`)} AS total
       FROM cash_movements m JOIN shifts s ON s.id = m.shift_id JOIN business_days d ON d.id = s.business_day_id
       WHERE s.branch_id = ${branchId} AND d.business_date BETWEEN ${from} AND ${to}
       GROUP BY m.kind`.execute(db),
    sql<{
      shifts: number;
      off: number;
      total: number;
      short: number;
    }>`SELECT count(*)::int AS shifts,
         count(*) FILTER (WHERE s.variance_paisa <> 0)::int AS off,
         ${big(sql`sum(s.variance_paisa)`)} AS total,
         ${big(sql`sum(s.variance_paisa) FILTER (WHERE s.variance_paisa < 0)`)} AS short
       FROM shifts s JOIN business_days d ON d.id = s.business_day_id
       WHERE s.branch_id = ${branchId} AND s.status = 'CLOSED' AND d.business_date BETWEEN ${from} AND ${to}`.execute(
      db,
    ),
    sql<{
      kind: string;
      value: number;
    }>`SELECT kind, COALESCE(SUM(ABS(qty_base) * COALESCE(unit_cost_per_base, 0)), 0)::float8 AS value
       FROM stock_movements m JOIN business_days d ON d.id = m.business_day_id
       WHERE m.branch_id = ${branchId} AND m.kind IN ('WASTAGE', 'STAFF_MEAL') AND d.business_date BETWEEN ${from} AND ${to}
       GROUP BY kind`.execute(db),
    sql<{
      owed: number;
      accounts: number;
    }>`SELECT ${big(sql`sum(bal)`)} AS owed, count(*) FILTER (WHERE bal > 0)::int AS accounts
       FROM (SELECT SUM(e.delta_paisa) AS bal FROM khata_entries e JOIN khata_accounts a ON a.id = e.account_id
             WHERE a.branch_id = ${branchId} GROUP BY e.account_id) t WHERE bal > 0`.execute(db),
    listIngredients(ctx, branchId, {}),
    listSuppliers(ctx, branchId),
    sql<{ orders: number; tables: number; value: number }>`SELECT count(*)::int AS orders,
         count(*) FILTER (WHERE o.table_id IS NOT NULL)::int AS tables, ${big(sql`0`)} AS value
       FROM orders o WHERE o.branch_id = ${branchId} AND o.status IN ('OPEN', 'BILLED')`.execute(
      db,
    ),
    sql<{
      name: string;
      bills: number;
      discount: number;
    }>`SELECT u.full_name AS name, count(*)::int AS bills, ${big(sql`sum(b.discount_paisa)`)} AS discount
       FROM bills b JOIN users u ON u.id = b.settled_by JOIN business_days d ON d.id = b.business_day_id
       WHERE b.branch_id = ${branchId} AND b.status = 'SETTLED' AND d.business_date BETWEEN ${from} AND ${to}
       GROUP BY u.full_name ORDER BY 3 DESC`.execute(db),
  ]);

  // one row per day in the range, zero-filled, so the trend chart has no gaps
  const salesBy = new Map(billDays.rows.map((r) => [r.date, r]));
  const expBy = new Map(expDays.rows.map((r) => [r.date, r.total]));
  const costBy = new Map(costDays.rows.map((r) => [r.date, r.total]));
  const daily = Array.from({ length: n }, (_, i) => {
    const date = addDays(from, i);
    const sales = salesBy.get(date)?.sales ?? 0;
    const food = costBy.get(date) ?? 0;
    const expenses = expBy.get(date) ?? 0;
    return {
      date,
      bills: salesBy.get(date)?.bills ?? 0,
      salesPaisa: sales,
      costOfFoodPaisa: food,
      expensesPaisa: expenses,
      profitPaisa: sales - food - expenses,
    };
  });
  const hours = Array.from({ length: 24 }, (_, h) => {
    const row = hourly.rows.find((r) => r.hour === h);
    return { hour: h, salesPaisa: row?.sales ?? 0, bills: row?.bills ?? 0 };
  });
  const move = (k: string) => drawer.rows.find((r) => r.kind === k);
  const sumMethods = methods.rows.reduce((s, m) => s + m.amount, 0);
  const lowStock = ingredients.filter((i) => i.isActive && i.needsReorder);

  return {
    range: { from, to, days: n },
    previousRange: { from: prevFrom, to: prevTo },
    current,
    previous,
    daily,
    hourly: hours,
    payments: methods.rows.map((m) => ({
      code: m.code,
      method: m.method,
      isCash: m.isCash,
      isCredit: m.code === 'KHATA',
      count: m.count,
      amountPaisa: m.amount,
      shareBps: bps(m.amount, sumMethods),
    })),
    orderTypes: types.rows.map((t) => ({ type: t.type, bills: t.bills, salesPaisa: t.sales })),
    topItems: items.rows.slice(0, 10).map((i) => ({
      name: i.name,
      qty: i.qty,
      revenuePaisa: i.revenue,
      costPaisa: i.cost,
      marginPaisa: i.revenue - i.cost,
    })),
    slowItems: [...items.rows]
      .sort((a, b) => a.qty - b.qty)
      .slice(0, 5)
      .map((i) => ({ name: i.name, qty: i.qty, revenuePaisa: i.revenue })),
    categories: categories.rows.map((c) => ({ name: c.name, revenuePaisa: c.revenue })),
    expensesByCategory: expCats.rows.map((c) => ({ category: c.category, totalPaisa: c.total })),
    controls: {
      discountBills: discount.rows[0]!.bills,
      discountPaisa: discount.rows[0]!.total,
      discountsApprovedByManager: discount.rows[0]!.approvals,
      voidedAfterKitchenLines: voids.rows[0]!.lines,
      voidedAfterKitchenPaisa: voids.rows[0]!.total,
      complimentaryLines: comps.rows[0]!.lines,
      complimentaryPaisa: comps.rows[0]!.total,
      refundCount: refundsC.rows[0]!.count,
      refundPaisa: refundsC.rows[0]!.total,
      noSaleOpens: move('NO_SALE_OPEN')?.n ?? 0,
      paidOutPaisa: move('PAID_OUT')?.total ?? 0,
      closedShifts: variance.rows[0]!.shifts,
      shiftsWithDifference: variance.rows[0]!.off,
      cashDifferencePaisa: variance.rows[0]!.total,
      cashShortPaisa: variance.rows[0]!.short,
      wastagePaisa: Math.round(waste.rows.find((w) => w.kind === 'WASTAGE')?.value ?? 0),
      staffMealPaisa: Math.round(waste.rows.find((w) => w.kind === 'STAFF_MEAL')?.value ?? 0),
    },
    waiters: users.rows.map((u) => ({ name: u.name, bills: u.bills, discountPaisa: u.discount })),
    position: {
      khataOwedToUsPaisa: khata.rows[0]!.owed,
      khataAccountsOwing: khata.rows[0]!.accounts,
      owedToSuppliersPaisa: suppliers.reduce((s, x) => s + Math.max(x.owedPaisa, 0), 0),
      suppliersOwed: suppliers.filter((x) => x.owedPaisa > 0).length,
      stockValuePaisa: ingredients.reduce((s, i) => s + i.stockValuePaisa, 0),
      lowStock: lowStock
        .slice(0, 8)
        .map((i) => ({ name: i.name, onHand: i.onHand, uom: i.baseUom })),
      lowStockCount: lowStock.length,
      openOrders: open.rows[0]!.orders,
      openTables: open.rows[0]!.tables,
    },
  };
}
