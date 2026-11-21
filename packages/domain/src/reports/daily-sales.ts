/**
 * The daily sales report, as pure arithmetic on integer paisa. The API gathers the day's bills, payments, refunds and
 * lines; this turns them into the figures the owner reads (and the PDF prints). Nothing here reads a clock or a
 * database, and every total is a plain sum of the parts, so the total by type = the total by method = the day's total.
 */

export type DailyOrderType = 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';

export interface DailyPayment {
  method: string;
  amountPaisa: number;
  tipPaisa: number;
}

export interface DailyBill {
  id: string;
  billNo: number;
  orderNo: number | null;
  status: 'SETTLED' | 'PRE_BILLED';
  orderType: DailyOrderType | null;
  /** Where the order came from: POS (counter) or an online/phone source. */
  channel: string | null;
  subtotalPaisa: number;
  discountPaisa: number;
  serviceChargePaisa: number;
  taxPaisa: number;
  roundOffPaisa: number;
  totalPaisa: number;
  /** Local hour (0-23) it was settled, or made when unpaid. */
  hour: number;
  cashier: string | null;
  payments: DailyPayment[];
}

export interface DailyRefund {
  amountPaisa: number;
  method: string;
}

export interface DailyLine {
  billId: string;
  name: string;
  category: string | null;
  qty: number;
  netPaisa: number;
}

export interface Bucket {
  key: string;
  bills: number;
  amountPaisa: number;
}

export interface Ranked {
  name: string;
  qty: number;
  amountPaisa: number;
}

export interface DailySales {
  paidBills: number;
  /** Sum of the subtotal of paid bills, before discount, service charge and tax. */
  grossSalesPaisa: number;
  discountPaisa: number;
  serviceChargePaisa: number;
  taxPaisa: number;
  roundOffPaisa: number;
  /** What the guests were charged: the sum of the total of paid bills. */
  collectedPaisa: number;
  refundsPaisa: number;
  netAfterRefundsPaisa: number;
  avgBillPaisa: number;
  tipsPaisa: number;
  unpaidBills: number;
  unpaidPaisa: number;
  byMethod: Bucket[];
  byType: Bucket[];
  byChannel: Bucket[];
  byHour: Bucket[];
  byCashier: Bucket[];
  refundsByMethod: Bucket[];
  topItems: Ranked[];
  categories: Ranked[];
}

const sum = (xs: readonly number[]): number => xs.reduce((n, x) => n + x, 0);

/** Groups into buckets, biggest amount first (ties by name), so the report reads the same every time. */
function buckets<T>(rows: readonly T[], key: (r: T) => string, amount: (r: T) => number): Bucket[] {
  const m = new Map<string, Bucket>();
  for (const r of rows) {
    const k = key(r);
    const b = m.get(k) ?? { key: k, bills: 0, amountPaisa: 0 };
    b.bills += 1;
    b.amountPaisa += amount(r);
    m.set(k, b);
  }
  return [...m.values()].sort(
    (a, b) => b.amountPaisa - a.amountPaisa || a.key.localeCompare(b.key),
  );
}

const ranked = (m: Map<string, Ranked>): Ranked[] =>
  [...m.values()].sort(
    (a, b) => b.amountPaisa - a.amountPaisa || b.qty - a.qty || a.name.localeCompare(b.name),
  );

export function buildDailySales(
  bills: readonly DailyBill[],
  refunds: readonly DailyRefund[],
  lines: readonly DailyLine[],
  topN = 10,
): DailySales {
  const paid = bills.filter((b) => b.status === 'SETTLED');
  const unpaid = bills.filter((b) => b.status === 'PRE_BILLED');
  const paidIds = new Set(paid.map((b) => b.id));

  const collected = sum(paid.map((b) => b.totalPaisa));
  const refundsPaisa = sum(refunds.map((r) => r.amountPaisa));

  // the hours run through the day, not by size
  const byHour = buckets(
    paid,
    (b) => String(b.hour).padStart(2, '0'),
    (b) => b.totalPaisa,
  ).sort((a, b) => a.key.localeCompare(b.key));

  const items = new Map<string, Ranked>();
  const cats = new Map<string, Ranked>();
  const add = (m: Map<string, Ranked>, name: string, l: DailyLine): void => {
    const r = m.get(name) ?? { name, qty: 0, amountPaisa: 0 };
    r.qty += l.qty;
    r.amountPaisa += l.netPaisa;
    m.set(name, r);
  };
  for (const l of lines) {
    if (!paidIds.has(l.billId)) continue; // an unpaid bill is not a sale yet
    add(items, l.name, l);
    add(cats, l.category ?? 'Uncategorised', l);
  }

  return {
    paidBills: paid.length,
    grossSalesPaisa: sum(paid.map((b) => b.subtotalPaisa)),
    discountPaisa: sum(paid.map((b) => b.discountPaisa)),
    serviceChargePaisa: sum(paid.map((b) => b.serviceChargePaisa)),
    taxPaisa: sum(paid.map((b) => b.taxPaisa)),
    roundOffPaisa: sum(paid.map((b) => b.roundOffPaisa)),
    collectedPaisa: collected,
    refundsPaisa,
    netAfterRefundsPaisa: collected - refundsPaisa,
    avgBillPaisa: paid.length ? Math.round(collected / paid.length) : 0,
    tipsPaisa: sum(paid.flatMap((b) => b.payments.map((p) => p.tipPaisa))),
    unpaidBills: unpaid.length,
    unpaidPaisa: sum(unpaid.map((b) => b.totalPaisa)),
    byMethod: buckets(
      paid.flatMap((b) => b.payments),
      (p) => p.method,
      (p) => p.amountPaisa,
    ),
    byType: buckets(
      paid,
      (b) => b.orderType ?? 'OTHER',
      (b) => b.totalPaisa,
    ),
    byChannel: buckets(
      paid,
      (b) => b.channel ?? 'POS',
      (b) => b.totalPaisa,
    ),
    byHour,
    byCashier: buckets(
      paid,
      (b) => b.cashier ?? 'Unknown',
      (b) => b.totalPaisa,
    ),
    refundsByMethod: buckets(
      refunds,
      (r) => r.method,
      (r) => r.amountPaisa,
    ),
    topItems: ranked(items).slice(0, topN),
    categories: ranked(cats),
  };
}
