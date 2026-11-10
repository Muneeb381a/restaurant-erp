import { expectedCash, cashVariance } from '@erp/domain';
import type { ReportDoc } from '@erp/printing';
import { sql } from 'kysely';
import { AppError } from '../../http/errors';
import type { Queryable } from '../../shared/tx';

/**
 * Shift and day reports. Reports are the one module allowed to read other modules' tables
 * (CLAUDE.md rule 8). All sums are cast to bigint so the pg parser returns integers (SUM of a
 * bigint column is NUMERIC, which pg would hand back as a string).
 */

const big = (expr: ReturnType<typeof sql>) => sql<number>`COALESCE(${expr}, 0)::bigint`;

export interface MethodTotal {
  code: string;
  method: string;
  count: number;
  amountPaisa: number;
  tipPaisa: number;
  isCash: boolean;
}
export interface SalesTotals {
  billCount: number;
  subtotalPaisa: number;
  discountPaisa: number;
  serviceChargePaisa: number;
  taxPaisa: number;
  roundOffPaisa: number;
  totalPaisa: number;
}
export interface CashFlows {
  openingFloatPaisa: number;
  cashSalesPaisa: number;
  cashInPaisa: number;
  /** Cash received against khata balances (it goes into the drawer). */
  khataCashPaisa: number;
  /** Cash handed back through credit notes. */
  refundsCashPaisa: number;
  paidOutPaisa: number;
  dropsPaisa: number;
  noSaleCount: number;
}
export interface ShiftReport {
  shift: {
    id: string;
    cashier: string;
    status: string;
    openedAt: Date;
    closedAt: Date | null;
    notes: string | null;
    businessDate: string;
  };
  sales: SalesTotals;
  byMethod: MethodTotal[];
  cash: CashFlows;
  /** All khata payments received in this shift, any method. */
  khataCollectedPaisa: number;
  /** Credit notes paid out in this shift, any method. */
  refunds: { count: number; totalPaisa: number };
  /** Cash that should be in the drawer right now (or at close). */
  expectedCashPaisa: number;
  countedCashPaisa: number | null;
  variancePaisa: number | null;
}

async function salesTotals(
  q: Queryable,
  where: { shiftId?: string; dayId?: string },
): Promise<SalesTotals> {
  let b = q.selectFrom('bills').where('status', '=', 'SETTLED');
  if (where.shiftId) b = b.where('shift_id', '=', where.shiftId);
  if (where.dayId) b = b.where('business_day_id', '=', where.dayId);
  const r = await b
    .select([
      sql<number>`count(*)::int`.as('n'),
      big(sql`sum(subtotal_paisa)`).as('subtotal'),
      big(sql`sum(discount_paisa)`).as('discount'),
      big(sql`sum(service_charge_paisa)`).as('service'),
      big(sql`sum(tax_paisa)`).as('tax'),
      big(sql`sum(round_off_paisa)`).as('roundOff'),
      big(sql`sum(total_paisa)`).as('total'),
    ])
    .executeTakeFirstOrThrow();
  return {
    billCount: r.n,
    subtotalPaisa: r.subtotal,
    discountPaisa: r.discount,
    serviceChargePaisa: r.service,
    taxPaisa: r.tax,
    roundOffPaisa: r.roundOff,
    totalPaisa: r.total,
  };
}

async function methodTotals(
  q: Queryable,
  where: { shiftId?: string; dayId?: string },
): Promise<MethodTotal[]> {
  let p = q
    .selectFrom('payments')
    .innerJoin('payment_methods', 'payment_methods.id', 'payments.method_id')
    .innerJoin('shifts', 'shifts.id', 'payments.shift_id');
  if (where.shiftId) p = p.where('payments.shift_id', '=', where.shiftId);
  if (where.dayId) p = p.where('shifts.business_day_id', '=', where.dayId);
  const rows = await p
    .select([
      'payment_methods.code as code',
      'payment_methods.name as method',
      'payment_methods.opens_drawer as isCash',
      sql<number>`count(*)::int`.as('count'),
      big(sql`sum(payments.amount_paisa)`).as('amount'),
      big(sql`sum(payments.tip_paisa)`).as('tip'),
    ])
    .groupBy(['payment_methods.code', 'payment_methods.name', 'payment_methods.opens_drawer'])
    .orderBy('payment_methods.code')
    .execute();
  return rows.map((r) => ({
    code: r.code,
    method: r.method,
    count: r.count,
    amountPaisa: r.amount,
    tipPaisa: r.tip,
    isCash: r.isCash,
  }));
}

/** Everything about one shift: sales, tenders, drawer flows, expected / counted / variance. */
export async function shiftReport(
  q: Queryable,
  branchId: string,
  shiftId: string,
): Promise<ShiftReport> {
  const s = await q
    .selectFrom('shifts')
    .innerJoin('users', 'users.id', 'shifts.opened_by')
    .innerJoin('business_days', 'business_days.id', 'shifts.business_day_id')
    .select([
      'shifts.id as id',
      'shifts.status as status',
      'shifts.opened_at as openedAt',
      'shifts.closed_at as closedAt',
      'shifts.notes as notes',
      'shifts.opening_float_paisa as float',
      'shifts.expected_cash_paisa as expected',
      'shifts.counted_cash_paisa as counted',
      'users.full_name as cashier',
      'business_days.business_date as businessDate',
    ])
    .where('shifts.id', '=', shiftId)
    .where('shifts.branch_id', '=', branchId)
    .executeTakeFirst();
  if (!s) throw new AppError(404, 'NOT_FOUND', 'shift not found');

  const [sales, byMethod, moves, khataRows, refundRows] = await Promise.all([
    salesTotals(q, { shiftId }),
    methodTotals(q, { shiftId }),
    q
      .selectFrom('cash_movements')
      .select([
        'kind',
        sql<number>`count(*)::int`.as('n'),
        big(sql`sum(amount_paisa)`).as('amount'),
      ])
      .where('shift_id', '=', shiftId)
      .groupBy('kind')
      .execute(),
    q
      .selectFrom('khata_entries')
      .innerJoin('payment_methods', 'payment_methods.id', 'khata_entries.method_id')
      .select([
        'payment_methods.opens_drawer as isCash',
        big(sql`sum(khata_entries.amount_paisa)`).as('amount'),
      ])
      .where('khata_entries.shift_id', '=', shiftId)
      .where('khata_entries.kind', '=', 'PAYMENT')
      .groupBy('payment_methods.opens_drawer')
      .execute(),
    q
      .selectFrom('credit_notes')
      .leftJoin('payment_methods', 'payment_methods.id', 'credit_notes.refund_method_id')
      .select([
        sql<boolean>`COALESCE(payment_methods.opens_drawer, false)`.as('isCash'),
        sql<number>`count(*)::int`.as('n'),
        big(sql`sum(credit_notes.total_paisa)`).as('amount'),
      ])
      .where('credit_notes.shift_id', '=', shiftId)
      .groupBy(sql`COALESCE(payment_methods.opens_drawer, false)`)
      .execute(),
  ]);
  const sum = (k: string): number => moves.find((m) => m.kind === k)?.amount ?? 0;
  const cash: CashFlows = {
    openingFloatPaisa: s.float,
    cashSalesPaisa: byMethod.filter((m) => m.isCash).reduce((n, m) => n + m.amountPaisa, 0),
    cashInPaisa: sum('CASH_IN'),
    refundsCashPaisa: refundRows.filter((k) => k.isCash).reduce((n, k) => n + k.amount, 0),
    khataCashPaisa: khataRows.filter((k) => k.isCash).reduce((n, k) => n + k.amount, 0),
    paidOutPaisa: sum('PAID_OUT'),
    dropsPaisa: sum('DROP'),
    noSaleCount: moves.find((m) => m.kind === 'NO_SALE_OPEN')?.n ?? 0,
  };
  const expected = s.status === 'CLOSED' && s.expected !== null ? s.expected : expectedCash(cash);
  return {
    shift: {
      id: s.id,
      cashier: s.cashier,
      status: s.status,
      openedAt: s.openedAt,
      closedAt: s.closedAt,
      notes: s.notes,
      businessDate: s.businessDate,
    },
    sales,
    byMethod,
    cash,
    khataCollectedPaisa: khataRows.reduce((n, k) => n + k.amount, 0),
    refunds: {
      count: refundRows.reduce((n, k) => n + k.n, 0),
      totalPaisa: refundRows.reduce((n, k) => n + k.amount, 0),
    },
    expectedCashPaisa: expected,
    countedCashPaisa: s.counted,
    variancePaisa: s.counted === null ? null : cashVariance(s.counted, expected),
  };
}

export interface DayReport {
  day: { id: string; businessDate: string; status: string; openedAt: Date; closedAt: Date | null };
  sales: SalesTotals;
  byMethod: MethodTotal[];
  byOrderType: { type: string; count: number; totalPaisa: number }[];
  shifts: {
    id: string;
    cashier: string;
    status: string;
    expectedCashPaisa: number | null;
    countedCashPaisa: number | null;
    variancePaisa: number | null;
  }[];
  voidedBills: number;
  cancelledOrders: number;
  varianceTotalPaisa: number;
  khata: { chargedPaisa: number; collectedPaisa: number };
  refunds: { count: number; totalPaisa: number };
  netAfterRefundsPaisa: number;
}

export async function dayReport(q: Queryable, branchId: string, dayId: string): Promise<DayReport> {
  const d = await q
    .selectFrom('business_days')
    .selectAll()
    .where('id', '=', dayId)
    .where('branch_id', '=', branchId)
    .executeTakeFirst();
  if (!d) throw new AppError(404, 'NOT_FOUND', 'business day not found');
  const [sales, byMethod, byType, shifts, voided, cancelled, charged, collected, refunded] =
    await Promise.all([
      salesTotals(q, { dayId }),
      methodTotals(q, { dayId }),
      q
        .selectFrom('bills')
        .innerJoin('orders', 'orders.id', 'bills.order_id')
        .select([
          'orders.type as type',
          sql<number>`count(*)::int`.as('count'),
          big(sql`sum(bills.total_paisa)`).as('total'),
        ])
        .where('bills.business_day_id', '=', dayId)
        .where('bills.status', '=', 'SETTLED')
        .groupBy('orders.type')
        .orderBy('orders.type')
        .execute(),
      q
        .selectFrom('shifts')
        .innerJoin('users', 'users.id', 'shifts.opened_by')
        .select([
          'shifts.id as id',
          'users.full_name as cashier',
          'shifts.status as status',
          'shifts.expected_cash_paisa as expected',
          'shifts.counted_cash_paisa as counted',
          'shifts.variance_paisa as variance',
        ])
        .where('shifts.business_day_id', '=', dayId)
        .orderBy('shifts.opened_at')
        .execute(),
      q
        .selectFrom('bills')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('business_day_id', '=', dayId)
        .where('status', '=', 'VOID')
        .executeTakeFirstOrThrow(),
      q
        .selectFrom('orders')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('business_day_id', '=', dayId)
        .where('status', '=', 'CANCELLED')
        .executeTakeFirstOrThrow(),
      q
        .selectFrom('khata_entries')
        .innerJoin('bills', 'bills.id', 'khata_entries.bill_id')
        .select(big(sql`sum(khata_entries.amount_paisa)`).as('n'))
        .where('bills.business_day_id', '=', dayId)
        .where('khata_entries.kind', '=', 'CHARGE')
        .executeTakeFirstOrThrow(),
      q
        .selectFrom('khata_entries')
        .innerJoin('shifts', 'shifts.id', 'khata_entries.shift_id')
        .select(big(sql`sum(khata_entries.amount_paisa)`).as('n'))
        .where('shifts.business_day_id', '=', dayId)
        .where('khata_entries.kind', '=', 'PAYMENT')
        .executeTakeFirstOrThrow(),
      q
        .selectFrom('credit_notes')
        .select([sql<number>`count(*)::int`.as('n'), big(sql`sum(total_paisa)`).as('amount')])
        .where('business_day_id', '=', dayId)
        .executeTakeFirstOrThrow(),
    ]);
  return {
    day: {
      id: d.id,
      businessDate: d.business_date,
      status: d.status,
      openedAt: d.opened_at,
      closedAt: d.closed_at,
    },
    sales,
    byMethod,
    byOrderType: byType.map((r) => ({ type: r.type, count: r.count, totalPaisa: r.total })),
    shifts: shifts.map((s) => ({
      id: s.id,
      cashier: s.cashier,
      status: s.status,
      expectedCashPaisa: s.expected,
      countedCashPaisa: s.counted,
      variancePaisa: s.variance,
    })),
    voidedBills: voided.n,
    cancelledOrders: cancelled.n,
    khata: { chargedPaisa: charged.n, collectedPaisa: collected.n },
    refunds: { count: refunded.n, totalPaisa: refunded.amount },
    netAfterRefundsPaisa: sales.totalPaisa - refunded.amount,
    varianceTotalPaisa: shifts.reduce((n, s) => n + (s.variance ?? 0), 0),
  };
}

// ───────────────────────────── printable versions ─────────────────────────────

const when = (d: Date | null, tz: string): string =>
  d
    ? new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(d)
    : '-';

const salesRows = (s: SalesTotals): [string, number | string][] => [
  ['Bills', String(s.billCount)],
  ['Subtotal', s.subtotalPaisa],
  ...(s.discountPaisa ? ([['Discounts', -s.discountPaisa]] as [string, number][]) : []),
  ...(s.serviceChargePaisa
    ? ([['Service charge', s.serviceChargePaisa]] as [string, number][])
    : []),
  ...(s.taxPaisa ? ([['Tax', s.taxPaisa]] as [string, number][]) : []),
  ...(s.roundOffPaisa ? ([['Round off', s.roundOffPaisa]] as [string, number][]) : []),
  ['Net sales', s.totalPaisa],
];
const methodRows = (m: MethodTotal[]): [string, number | string][] =>
  m.length
    ? m.map((x): [string, number] => [`${x.method} (${x.count})`, x.amountPaisa])
    : [['No payments', '-']];

export function shiftReportDoc(
  r: ShiftReport,
  restaurant: string,
  tz: string,
  copy = 0,
): ReportDoc {
  const c = r.cash;
  return {
    title: r.shift.status === 'CLOSED' ? 'SHIFT CLOSE' : 'SHIFT SUMMARY',
    restaurant,
    copy,
    subtitle: [
      `Business day ${r.shift.businessDate}`,
      `Cashier: ${r.shift.cashier}`,
      `Opened ${when(r.shift.openedAt, tz)}`,
      `Closed ${when(r.shift.closedAt, tz)}`,
    ],
    sections: [
      { heading: 'Sales', rows: salesRows(r.sales) },
      ...(r.refunds.count
        ? [
            {
              heading: 'Refunds',
              rows: [
                ['Credit notes', String(r.refunds.count)],
                ['Refunded', -r.refunds.totalPaisa],
              ] as [string, number | string][],
            },
          ]
        : []),
      { heading: 'Payments', rows: methodRows(r.byMethod) },
      {
        heading: 'Cash drawer',
        rows: [
          ['Opening float', c.openingFloatPaisa],
          ['Cash sales', c.cashSalesPaisa],
          ['Cash in', c.cashInPaisa],
          ['Khata cash received', c.khataCashPaisa],
          ['Cash refunds', -c.refundsCashPaisa],
          ['Paid out', -c.paidOutPaisa],
          ['Drops to safe', -c.dropsPaisa],
          ['No-sale opens', String(c.noSaleCount)],
          ['Expected cash', r.expectedCashPaisa],
        ],
        boldLast: true,
      },
      ...(r.countedCashPaisa !== null
        ? [
            {
              rows: [
                ['Counted cash', r.countedCashPaisa],
                [
                  (r.variancePaisa ?? 0) < 0
                    ? 'SHORT'
                    : (r.variancePaisa ?? 0) > 0
                      ? 'OVER'
                      : 'Variance',
                  r.variancePaisa ?? 0,
                ],
              ] as [string, number][],
              boldLast: true,
            },
          ]
        : []),
    ],
  };
}

export function dayReportDoc(r: DayReport, restaurant: string, tz: string, copy = 0): ReportDoc {
  return {
    title: 'Z-REPORT',
    restaurant,
    copy,
    subtitle: [
      `Business day ${r.day.businessDate}`,
      `Opened ${when(r.day.openedAt, tz)}`,
      `Closed ${when(r.day.closedAt, tz)}`,
    ],
    sections: [
      { heading: 'Sales', rows: salesRows(r.sales) },
      {
        heading: 'Refunds',
        rows: [
          ['Credit notes', String(r.refunds.count)],
          ['Refunded', -r.refunds.totalPaisa],
          ['Net after refunds', r.netAfterRefundsPaisa],
        ],
        boldLast: true,
      },
      { heading: 'Payments', rows: methodRows(r.byMethod) },
      {
        heading: 'By order type',
        rows: r.byOrderType.length
          ? r.byOrderType.map((t): [string, number] => [`${t.type} (${t.count})`, t.totalPaisa])
          : [['No sales', '-']],
      },
      {
        heading: 'Shifts',
        rows: [
          ...r.shifts.map((s): [string, number | string] => [
            s.cashier,
            s.variancePaisa === null ? 'open' : s.variancePaisa,
          ]),
          ['Total variance', r.varianceTotalPaisa],
        ],
        boldLast: true,
      },
      {
        heading: 'Khata',
        rows: [
          ['Charged (credit sales)', r.khata.chargedPaisa],
          ['Collected', r.khata.collectedPaisa],
        ],
      },
      {
        heading: 'Exceptions',
        rows: [
          ['Voided bills', String(r.voidedBills)],
          ['Cancelled orders', String(r.cancelledOrders)],
        ],
      },
    ],
  };
}
