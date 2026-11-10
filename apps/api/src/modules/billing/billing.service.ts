import {
  asPaisa,
  canTransitionOrder,
  computeBill,
  discountNeedsApproval,
  taxClassOf,
  validateTenders,
  type BillTotals,
  type Discount,
  type Paisa,
  type TaxClass,
  type TaxResult,
} from '@erp/domain';
import { renderReceipt, renderReceiptBitmap, type ReceiptDoc } from '@erp/printing';
import type { AppContext } from '../../http/context';
import { AppError } from '../../http/errors';
import { withTx, type Queryable } from '../../shared/tx';
import { writeAudit } from '../audit/audit.service';
import { CLEAN_STATE, isLocked, onFailure } from '../auth/lockout';
import { clockTime } from '../kitchen/tickets';
import { bumpVersion, lockOrder, nextDocNo } from '../orders/orders.repo';
import { assertEditable, checkVersion, type Actor } from '../orders/orders.service';
import { chargeKhata, khataForBill } from '../khata/khata.service';
import { loadTaxContext, taxFor, type TaxContext } from '../tax/tax.service';
import { creditNotesOf } from './credit.service';
import { enqueuePrintJob } from '../printing/print.service';

const bad = (message: string, extra?: Record<string, unknown>): AppError =>
  new AppError(400, 'VALIDATION_FAILED', message, extra);

// ───────────────────────────────── settings ─────────────────────────────────

interface BillingSettings {
  roundToRupee: boolean;
  serviceChargeBps: number;
}

async function readSettings(q: Queryable, branchId: string): Promise<BillingSettings> {
  const rows = await q
    .selectFrom('settings')
    .select(['key', 'value'])
    .where('branch_id', '=', branchId)
    .where('key', 'in', ['billing.round_to_rupee', 'billing.service_charge_bps'])
    .execute();
  const get = (k: string): unknown => rows.find((r) => r.key === k)?.value;
  return {
    roundToRupee: get('billing.round_to_rupee') === true,
    serviceChargeBps:
      typeof get('billing.service_charge_bps') === 'number'
        ? (get('billing.service_charge_bps') as number)
        : 0,
  };
}

// ────────────────────────────────── the view ──────────────────────────────────

export async function getBillView(q: Queryable, branchId: string, billId: string) {
  const bill = await q
    .selectFrom('bills')
    .innerJoin('orders', 'orders.id', 'bills.order_id')
    .leftJoin('dining_tables', 'dining_tables.id', 'orders.table_id')
    .selectAll('bills')
    .select([
      'orders.order_no as order_no',
      'orders.type as order_type',
      'orders.version as order_version',
      'dining_tables.code as table_code',
    ])
    .where('bills.id', '=', billId)
    .where('bills.branch_id', '=', branchId)
    .executeTakeFirst();
  if (!bill) throw new AppError(404, 'NOT_FOUND', 'bill not found');
  const creditNotes = await creditNotesOf(q, billId);
  const [lines, payments] = await Promise.all([
    q.selectFrom('bill_lines').selectAll().where('bill_id', '=', billId).orderBy('id').execute(),
    q
      .selectFrom('payments')
      .innerJoin('payment_methods', 'payment_methods.id', 'payments.method_id')
      .select([
        'payments.id as id',
        'payments.method_id as method_id',
        'payment_methods.name as method',
        'payment_methods.code as method_code',
        'payments.amount_paisa as amount',
        'payments.tendered_paisa as tendered',
        'payments.change_paisa as change',
        'payments.tip_paisa as tip',
        'payments.reference as reference',
        'payments.received_at as received_at',
      ])
      .where('payments.bill_id', '=', billId)
      .orderBy('payments.received_at')
      .orderBy('payments.id')
      .execute(),
  ]);
  return {
    id: bill.id,
    billNo: bill.bill_no,
    orderId: bill.order_id,
    orderNo: bill.order_no,
    orderType: bill.order_type,
    orderVersion: bill.order_version,
    tableCode: bill.table_code,
    status: bill.status,
    subtotalPaisa: bill.subtotal_paisa,
    discountPaisa: bill.discount_paisa,
    discountReason: bill.discount_reason,
    discountApprovedBy: bill.discount_approved_by,
    serviceChargePaisa: bill.service_charge_paisa,
    taxablePaisa: bill.taxable_paisa,
    taxPaisa: bill.tax_paisa,
    taxRateBps: bill.tax_rate_bps,
    roundOffPaisa: bill.round_off_paisa,
    totalPaisa: bill.total_paisa,
    taxPaymentClass: bill.tax_payment_class,
    settledAt: bill.settled_at,
    printCount: bill.print_count,
    lines: lines.map((l) => ({
      id: l.id,
      description: l.description,
      qty: Number(l.qty),
      unitPricePaisa: l.unit_price_paisa,
      netPaisa: l.net_paisa,
      taxPaisa: l.tax_paisa,
      taxRateBps: l.tax_rate_bps,
    })),
    payments: payments.map((p) => ({
      id: p.id,
      methodId: p.method_id,
      method: p.method,
      methodCode: p.method_code,
      amountPaisa: p.amount,
      tenderedPaisa: p.tendered,
      changePaisa: p.change,
      tipPaisa: p.tip,
      reference: p.reference,
      receivedAt: p.received_at,
    })),
    changeDuePaisa: payments.reduce((n, p) => n + p.change, 0),
    khata: await khataForBill(q, billId),
    creditNotes,
    refundedPaisa: creditNotes.reduce((n, c) => n + c.totalPaisa, 0),
  };
}
/** Bills of a business day (default: the open one) for look-up: re-printing, refunds. */
export async function listBills(
  q: Queryable,
  branchId: string,
  opts: { businessDate?: string | undefined; billNo?: number | undefined; limit: number },
) {
  let query = q
    .selectFrom('bills')
    .innerJoin('business_days', 'business_days.id', 'bills.business_day_id')
    .select([
      'bills.id as id',
      'bills.order_id as orderId',
      'bills.bill_no as billNo',
      'bills.status as status',
      'bills.total_paisa as totalPaisa',
      'bills.settled_at as settledAt',
      'business_days.business_date as businessDate',
    ])
    .where('bills.branch_id', '=', branchId)
    .where('bills.status', 'in', ['SETTLED', 'PRE_BILLED'])
    .orderBy('business_days.business_date', 'desc')
    .orderBy('bills.bill_no', 'desc')
    .limit(opts.limit);
  if (opts.businessDate) query = query.where('business_days.business_date', '=', opts.businessDate);
  if (opts.billNo !== undefined) query = query.where('bills.bill_no', '=', opts.billNo);
  return query.execute();
}

export type BillView = Awaited<ReturnType<typeof getBillView>>;

export async function getBillForOrder(
  q: Queryable,
  branchId: string,
  orderId: string,
): Promise<BillView | null> {
  const b = await q
    .selectFrom('bills')
    .select('id')
    .where('order_id', '=', orderId)
    .where('branch_id', '=', branchId)
    .where('status', '!=', 'VOID')
    .executeTakeFirst();
  return b ? getBillView(q, branchId, b.id) : null;
}

function audit(
  q: Queryable,
  a: Actor,
  action: string,
  billId: string,
  before: unknown,
  after: unknown,
  reason?: string,
) {
  return writeAudit(q, {
    branchId: a.branchId,
    userId: a.userId,
    deviceId: a.deviceId,
    action,
    entity: 'bill',
    entityId: billId,
    before,
    after,
    reason,
    ip: a.ip,
  });
}

const totalsRow = (t: BillTotals) => ({
  subtotal_paisa: t.subtotalPaisa,
  discount_paisa: t.discountPaisa,
  service_charge_paisa: t.serviceChargePaisa,
  taxable_paisa: t.taxablePaisa,
  tax_paisa: t.taxPaisa,
  round_off_paisa: t.roundOffPaisa,
  total_paisa: t.totalPaisa,
});

const taxCols = (tax: TaxResult | null) => ({
  tax_rule_id: tax?.singleRule?.ruleId ?? null,
  tax_rate_bps: tax?.singleRule?.rateBps ?? null,
});

interface PriceInput {
  subtotalPaisa: Paisa;
  discount?: Discount | undefined;
  settings: BillingSettings;
  lines: { id: string; netPaisa: number; categoryId: string }[];
  tctx: TaxContext;
  paymentClass: TaxClass;
  date: string;
}

/**
 * Prices a bill: discount -> service charge -> tax (per line, from the owner's rules) -> round-off.
 * The service charge is needed for the tax base and the tax for the round-off, hence two passes.
 * With tax switched off the tax is 0 and no rule is involved.
 */
function priceBill(i: PriceInput): { totals: BillTotals; tax: TaxResult | null } {
  const first = computeBill({
    subtotalPaisa: i.subtotalPaisa,
    discount: i.discount,
    serviceChargeBps: i.settings.serviceChargeBps,
    roundToRupee: false,
  });
  const tax = taxFor(i.tctx, {
    lines: i.lines,
    discountPaisa: first.discountPaisa,
    serviceChargePaisa: first.serviceChargePaisa,
    paymentClass: i.paymentClass,
    date: i.date,
  });
  const totals = computeBill({
    subtotalPaisa: i.subtotalPaisa,
    discount: i.discount,
    serviceChargeBps: i.settings.serviceChargeBps,
    taxPaisa: tax?.taxPaisa,
    roundToRupee: i.settings.roundToRupee,
  });
  return { totals, tax };
}

async function writeLineTax(
  trx: Queryable,
  tax: TaxResult | null,
  lineIds: string[],
): Promise<void> {
  for (const id of lineIds) {
    const t = tax?.lines.find((l) => l.id === id);
    await trx
      .updateTable('bill_lines')
      .set({
        tax_paisa: t?.taxPaisa ?? 0,
        tax_rate_bps: t?.rateBps ?? null,
        tax_rule_id: t?.ruleId ?? null,
      })
      .where('id', '=', id)
      .execute();
  }
}

async function billDate(q: Queryable, dayId: string): Promise<string> {
  const d = await q
    .selectFrom('business_days')
    .select('business_date')
    .where('id', '=', dayId)
    .executeTakeFirstOrThrow();
  return d.business_date;
}

/** Re-prices a PRE_BILLED bill (discount change, or the payment class becoming known) and stores it. */
async function repriceBill(
  trx: Queryable,
  a: Actor,
  bill: { id: string; business_day_id: string; subtotal_paisa: number },
  discount: Discount,
  paymentClass: TaxClass,
): Promise<BillTotals> {
  const [lines, settings, tctx, date] = await Promise.all([
    trx
      .selectFrom('bill_lines')
      .select(['id', 'net_paisa', 'tax_category_id'])
      .where('bill_id', '=', bill.id)
      .orderBy('id')
      .execute(),
    readSettings(trx, a.branchId),
    loadTaxContext(trx, a.branchId),
    billDate(trx, bill.business_day_id),
  ]);
  const { totals, tax } = priceBill({
    subtotalPaisa: asPaisa(bill.subtotal_paisa),
    discount,
    settings,
    lines: lines.map((l) => ({ id: l.id, netPaisa: l.net_paisa, categoryId: l.tax_category_id! })),
    tctx,
    paymentClass,
    date,
  });
  await writeLineTax(
    trx,
    tax,
    lines.map((l) => l.id),
  );
  await trx
    .updateTable('bills')
    .set({ ...totalsRow(totals), ...taxCols(tax) })
    .where('id', '=', bill.id)
    .execute();
  return totals;
}

/** What the bill would total for each payment class (the screen shows the one the tenders imply). */
export async function quoteBill(ctx: AppContext, branchId: string, billId: string) {
  const bill = await ctx.db
    .selectFrom('bills')
    .selectAll()
    .where('id', '=', billId)
    .where('branch_id', '=', branchId)
    .executeTakeFirst();
  if (!bill) throw new AppError(404, 'NOT_FOUND', 'bill not found');
  const [lines, settings, tctx, date] = await Promise.all([
    ctx.db
      .selectFrom('bill_lines')
      .select(['id', 'net_paisa', 'tax_category_id'])
      .where('bill_id', '=', billId)
      .orderBy('id')
      .execute(),
    readSettings(ctx.db, branchId),
    loadTaxContext(ctx.db, branchId),
    billDate(ctx.db, bill.business_day_id),
  ]);
  const price = (paymentClass: TaxClass) => {
    const priced = priceBill({
      subtotalPaisa: asPaisa(bill.subtotal_paisa),
      discount: { kind: 'AMOUNT', paisa: asPaisa(bill.discount_paisa) },
      settings,
      lines: lines.map((l) => ({
        id: l.id,
        netPaisa: l.net_paisa,
        categoryId: l.tax_category_id!,
      })),
      tctx,
      paymentClass,
      date,
    });
    return { ...priced.totals, taxRateBps: priced.tax?.singleRule?.rateBps ?? null };
  };
  return { taxEnabled: tctx.enabled, CASH_OTHER: price('CASH_OTHER'), DIGITAL: price('DIGITAL') };
}

// ───────────────────────────────── pre-bill ─────────────────────────────────

/**
 * Pre-bill: freezes the order (BILLED) and prices the bill from the order's live lines.
 * Everything must have been sent to the kitchen first — a line billed but never sent would
 * be food the kitchen never makes.
 */
export function createBill(
  ctx: AppContext,
  a: Actor,
  orderId: string,
  ifMatch: number | undefined,
) {
  return withTx(ctx.db, async (trx) => {
    const order = await lockOrder(trx, a.branchId, orderId);
    assertEditable(order);
    checkVersion(order, ifMatch, false);

    const lines = await trx
      .selectFrom('order_items')
      .selectAll()
      .where('order_id', '=', orderId)
      .where('parent_order_item_id', 'is', null)
      .where('status', '!=', 'VOID')
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    if (lines.length === 0) throw new AppError(409, 'EMPTY_ORDER', 'There is nothing to bill');
    const unsent = lines.filter((l) => l.status === 'NEW');
    if (unsent.length)
      throw new AppError(409, 'UNSENT_ITEMS', 'Send the new items to the kitchen before billing', {
        items: unsent.map((l) => l.name_snapshot),
      });

    const settings = await readSettings(trx, a.branchId);
    const subtotal = asPaisa(lines.reduce((n, l) => n + l.line_total_paisa, 0));
    // shown with the highest-rate class; the real class is known at settlement (tenders)
    const { totals, tax } = priceBill({
      subtotalPaisa: subtotal,
      settings,
      lines: lines.map((l) => ({
        id: l.id,
        netPaisa: l.line_total_paisa,
        categoryId: l.tax_category_id,
      })),
      tctx: await loadTaxContext(trx, a.branchId),
      paymentClass: 'CASH_OTHER',
      date: await billDate(trx, order.business_day_id),
    });
    const billNo = await nextDocNo(trx, a.branchId, order.business_day_id, 'BILL');

    const bill = await trx
      .insertInto('bills')
      .values({
        branch_id: a.branchId,
        business_day_id: order.business_day_id,
        order_id: orderId,
        bill_no: billNo,
        status: 'PRE_BILLED',
        created_by: a.userId,
        ...totalsRow(totals),
        ...taxCols(tax),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('bill_lines')
      .values(
        lines.map((l) => ({
          bill_id: bill.id,
          line_kind: 'ITEM',
          order_item_id: l.id,
          description: l.weight_g ? `${l.name_snapshot} (${l.weight_g} g)` : l.name_snapshot,
          qty: l.qty,
          unit_price_paisa: l.unit_price_paisa,
          portion_bps: 10000,
          net_paisa: l.line_total_paisa,
          tax_category_id: l.tax_category_id,
          tax_paisa: tax?.lines.find((t) => t.id === l.id)?.taxPaisa ?? 0,
          tax_rate_bps: tax?.lines.find((t) => t.id === l.id)?.rateBps ?? null,
          tax_rule_id: tax?.lines.find((t) => t.id === l.id)?.ruleId ?? null,
        })),
      )
      .execute();
    await trx.updateTable('orders').set({ status: 'BILLED' }).where('id', '=', orderId).execute();
    await bumpVersion(trx, orderId);
    return getBillView(trx, a.branchId, bill.id);
  });
}

// ──────────────────────────────── discounts ────────────────────────────────

export interface DiscountInput {
  /** `percentBps` (1000 = 10 %) or `amountPaisa`; 0 removes the discount. */
  percentBps?: number | undefined;
  amountPaisa?: number | undefined;
  reason?: string | undefined;
  approver?: { username: string; pin: string } | undefined;
}

/**
 * Checks an approver's PIN in its OWN transaction, so failed attempts count towards the
 * 5-tries lockout even though the discount request is then rejected.
 */
async function verifyApprover(
  ctx: AppContext,
  branchId: string,
  approver: { username: string; pin: string },
): Promise<string> {
  const now = ctx.clock.now();
  const outcome = await withTx(ctx.db, async (trx) => {
    const user = await trx
      .selectFrom('users')
      .selectAll()
      .where('username', '=', approver.username.trim().toLowerCase())
      .forUpdate()
      .executeTakeFirst();
    const invalid = new AppError(403, 'APPROVER_INVALID', 'Approver username or PIN is wrong');
    if (!user || !user.is_active || (user.branch_id !== null && user.branch_id !== branchId))
      return { error: invalid };
    const state = {
      failedAttempts: user.failed_attempts,
      lastFailedAt: user.last_failed_at,
      lockedUntil: user.locked_until,
    };
    if (isLocked(state, now))
      return { error: new AppError(423, 'ACCOUNT_LOCKED', 'Approver account temporarily locked') };
    const ok = user.pin_hash ? await ctx.hasher.verify(user.pin_hash, approver.pin) : false;
    if (!ok) {
      const next = onFailure(state, now);
      await trx
        .updateTable('users')
        .set({
          failed_attempts: next.failedAttempts,
          last_failed_at: next.lastFailedAt,
          locked_until: next.lockedUntil,
        })
        .where('id', '=', user.id)
        .execute();
      await writeAudit(trx, {
        branchId,
        userId: user.id,
        action: 'APPROVER_PIN_FAILED',
        entity: 'user',
        entityId: user.id,
      });
      return { error: invalid };
    }
    await trx
      .updateTable('users')
      .set({
        failed_attempts: CLEAN_STATE.failedAttempts,
        last_failed_at: null,
        locked_until: null,
      })
      .where('id', '=', user.id)
      .execute();
    return { userId: user.id, roleId: user.role_id };
  });
  if ('error' in outcome) throw outcome.error;
  const perms = await ctx.permissions.get(outcome.roleId);
  if (!perms.has('bill.discount.unlimited'))
    throw new AppError(403, 'APPROVER_INVALID', 'That user cannot approve discounts');
  return outcome.userId;
}

export async function applyDiscount(
  ctx: AppContext,
  a: Actor,
  billId: string,
  input: DiscountInput,
) {
  const hasPercent = input.percentBps !== undefined;
  const hasAmount = input.amountPaisa !== undefined;
  if (hasPercent === hasAmount) throw bad('Give either percentBps or amountPaisa');
  const discount: Discount = hasPercent
    ? { kind: 'PERCENT_BPS', bps: input.percentBps! }
    : { kind: 'AMOUNT', paisa: asPaisa(input.amountPaisa!) };
  const reason = input.reason?.trim();

  // Approver is checked first and separately (own transaction, see verifyApprover).
  const head = await ctx.db
    .selectFrom('bills')
    .select(['subtotal_paisa', 'status'])
    .where('id', '=', billId)
    .where('branch_id', '=', a.branchId)
    .executeTakeFirst();
  if (!head) throw new AppError(404, 'NOT_FOUND', 'bill not found');
  const proposed = computeBill({
    subtotalPaisa: asPaisa(head.subtotal_paisa),
    discount,
    roundToRupee: false,
  }).discountPaisa;
  let approvedBy: string | null = null;
  if (proposed > 0) {
    if (!reason || reason.length < 3) throw bad('A reason is required for a discount');
    const me = await ctx.db
      .selectFrom('users')
      .select('discount_limit_bps')
      .where('id', '=', a.userId)
      .executeTakeFirstOrThrow();
    if (discountNeedsApproval(proposed, asPaisa(head.subtotal_paisa), me.discount_limit_bps)) {
      if (a.permissions.has('bill.discount.unlimited')) approvedBy = a.userId;
      else if (!input.approver)
        throw new AppError(
          403,
          'DISCOUNT_APPROVAL_REQUIRED',
          'This discount is above your limit; a manager must approve it',
          { limitBps: me.discount_limit_bps },
        );
      else approvedBy = await verifyApprover(ctx, a.branchId, input.approver);
    }
  }

  return withTx(ctx.db, async (trx) => {
    const orderRef = await trx
      .selectFrom('bills')
      .select('order_id')
      .where('id', '=', billId)
      .executeTakeFirstOrThrow();
    await lockOrder(trx, a.branchId, orderRef.order_id); // same lock order as every other command
    const bill = await trx
      .selectFrom('bills')
      .selectAll()
      .where('id', '=', billId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (bill.status !== 'PRE_BILLED')
      throw new AppError(409, 'BILL_NOT_PAYABLE', `A ${bill.status} bill cannot be changed`);

    const totals = await repriceBill(trx, a, bill, discount, 'CASH_OTHER');
    await trx
      .updateTable('bills')
      .set({
        discount_reason: totals.discountPaisa > 0 ? reason! : null,
        discount_approved_by: totals.discountPaisa > 0 ? approvedBy : null,
      })
      .where('id', '=', billId)
      .execute();
    await audit(
      trx,
      a,
      'BILL_DISCOUNT',
      billId,
      { discountPaisa: bill.discount_paisa, totalPaisa: bill.total_paisa },
      { discountPaisa: totals.discountPaisa, totalPaisa: totals.totalPaisa, approvedBy },
      reason,
    );
    return getBillView(trx, a.branchId, billId);
  });
}

// ─────────────────────────────────── void ───────────────────────────────────

/** Cancels an unpaid bill and reopens the order for changes (audited; needs bill.void). */
export function voidBill(ctx: AppContext, a: Actor, billId: string, reason: string) {
  return withTx(ctx.db, async (trx) => {
    const ref = await trx
      .selectFrom('bills')
      .select('order_id')
      .where('id', '=', billId)
      .where('branch_id', '=', a.branchId)
      .executeTakeFirst();
    if (!ref) throw new AppError(404, 'NOT_FOUND', 'bill not found');
    const order = await lockOrder(trx, a.branchId, ref.order_id);
    const bill = await trx
      .selectFrom('bills')
      .selectAll()
      .where('id', '=', billId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (bill.status !== 'PRE_BILLED')
      throw new AppError(
        409,
        'BILL_NOT_PAYABLE',
        `A ${bill.status} bill cannot be voided; use a credit note`,
      );
    if (!canTransitionOrder(order.status as 'BILLED', 'OPEN'))
      throw new AppError(409, 'ORDER_NOT_EDITABLE', `Order is ${order.status}`);
    await trx.updateTable('bills').set({ status: 'VOID' }).where('id', '=', billId).execute();
    await trx.updateTable('orders').set({ status: 'OPEN' }).where('id', '=', order.id).execute();
    await bumpVersion(trx, order.id);
    await audit(
      trx,
      a,
      'BILL_VOID',
      billId,
      { status: 'PRE_BILLED', totalPaisa: bill.total_paisa },
      { status: 'VOID' },
      reason,
    );
    return getBillView(trx, a.branchId, billId);
  });
}

// ─────────────────────────────────── settle ───────────────────────────────────

export interface TenderBody {
  methodId: string;
  amountPaisa: number;
  tenderedPaisa?: number | undefined;
  tipPaisa?: number | undefined;
  reference?: string | undefined;
  /** Required for (and only for) the khata method: whose account carries the credit. */
  khataAccountId?: string | undefined;
}

export interface SettleResult {
  bill: BillView;
  changeDuePaisa: number;
  receipts: number;
  replayed: boolean;
}

/** Receipt data for a settled bill (shared by the first print and duplicates). */
async function receiptDoc(
  q: Queryable,
  branchId: string,
  bill: BillView,
  duplicate: number,
): Promise<{ doc: ReceiptDoc; branchTz: string }> {
  const [branch, order, cashier] = await Promise.all([
    q
      .selectFrom('branches')
      .select(['name', 'name_ur', 'address', 'phone', 'timezone', 'ntn', 'strn'])
      .where('id', '=', branchId)
      .executeTakeFirstOrThrow(),
    q
      .selectFrom('orders')
      .leftJoin('users', 'users.id', 'orders.waiter_id')
      .select(['users.full_name as waiter'])
      .where('orders.id', '=', bill.orderId)
      .executeTakeFirstOrThrow(),
    q
      .selectFrom('bills')
      .leftJoin('users', 'users.id', 'bills.settled_by')
      .select(['users.full_name as cashier'])
      .where('bills.id', '=', bill.id)
      .executeTakeFirstOrThrow(),
  ]);
  const itemLines = await q
    .selectFrom('bill_lines')
    .innerJoin('order_items', 'order_items.id', 'bill_lines.order_item_id')
    .select([
      'bill_lines.id as id',
      'order_items.id as item_id',
      'order_items.name_ur_snapshot as name_ur',
    ])
    .where('bill_lines.bill_id', '=', bill.id)
    .execute();
  const mods = itemLines.length
    ? await q
        .selectFrom('order_item_modifiers')
        .select(['order_item_id', 'name_snapshot'])
        .where(
          'order_item_id',
          'in',
          itemLines.map((l) => l.item_id),
        )
        .execute()
    : [];
  const at = bill.settledAt ?? new Date();
  const doc: ReceiptDoc = {
    restaurant: branch.name,
    restaurantUr: branch.name_ur,
    address: branch.address,
    phone: branch.phone,
    ntn: branch.ntn,
    strn: branch.strn,
    taxLabel: bill.taxRateBps ? `Sales tax ${bill.taxRateBps / 100}%` : null,
    billNo: bill.billNo,
    orderNo: bill.orderNo,
    orderType: bill.orderType as ReceiptDoc['orderType'],
    tableCode: bill.tableCode,
    waiter: order.waiter,
    cashier: cashier.cashier,
    dateTime: `${new Intl.DateTimeFormat('en-GB', { timeZone: branch.timezone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(at)} ${clockTime(at, branch.timezone)}`,
    lines: bill.lines.map((l) => ({
      qty: l.qty,
      name: l.description,
      nameUr: itemLines.find((x) => x.id === l.id)?.name_ur ?? null,
      amountPaisa: l.netPaisa,
      modifiers: mods
        .filter((m) => m.order_item_id === itemLines.find((x) => x.id === l.id)?.item_id)
        .map((m) => m.name_snapshot),
    })),
    subtotalPaisa: bill.subtotalPaisa,
    discountPaisa: bill.discountPaisa,
    serviceChargePaisa: bill.serviceChargePaisa,
    taxPaisa: bill.taxPaisa,
    roundOffPaisa: bill.roundOffPaisa,
    totalPaisa: bill.totalPaisa,
    khataCustomer: bill.khata?.customer ?? null,
    payments: bill.payments.map((p) => ({
      method: p.method,
      amountPaisa: p.amountPaisa,
      tenderedPaisa: p.tenderedPaisa,
      changePaisa: p.changePaisa,
    })),
    tipPaisa: bill.payments.reduce((n, p) => n + p.tipPaisa, 0),
    duplicate,
    openDrawer: duplicate === 0 && bill.payments.some((p) => p.tenderedPaisa !== null),
  };
  return { doc, branchTz: branch.timezone };
}

async function queueReceipts(
  q: Queryable,
  a: Actor,
  bill: BillView,
  duplicate: number,
  at: Date,
): Promise<number> {
  const printers = await q
    .selectFrom('printers')
    .select(['id', 'paper_mm'])
    .where('branch_id', '=', a.branchId)
    .where('kind', '=', 'RECEIPT')
    .where('is_active', '=', true)
    .orderBy('name')
    .execute();
  if (printers.length === 0) return 0;
  const { doc } = await receiptDoc(q, a.branchId, bill, duplicate);
  const lang = await q
    .selectFrom('settings')
    .select('value')
    .where('branch_id', '=', a.branchId)
    .where('key', '=', 'receipt.language')
    .executeTakeFirst();
  const urdu = lang?.value === 'ur';
  let n = 0;
  for (const p of printers) {
    const inserted = await enqueuePrintJob(q, {
      branchId: a.branchId,
      printerId: p.id,
      kind: 'RECEIPT',
      refType: 'bill',
      refId: bill.id,
      title: `${duplicate ? `DUPLICATE #${duplicate} ` : ''}Bill #${bill.billNo}`,
      payload: urdu
        ? renderReceiptBitmap(doc, p.paper_mm as 58 | 80)
        : renderReceipt(doc, p.paper_mm as 58 | 80),
      idempotencyKey: `receipt:${bill.id}:p${duplicate}:${p.id}`,
      createdBy: a.userId,
      at,
    });
    if (inserted) n++;
  }
  return n;
}

/**
 * Takes payment and settles the bill in ONE transaction (ARCHITECTURE §6): payments are written
 * first (each with its own idempotency key), then the bill flips to SETTLED — the database
 * refuses that unless the payments add up to the total exactly. Replaying the same
 * Idempotency-Key returns the original result without writing anything.
 */
export async function settleBill(
  ctx: AppContext,
  a: Actor,
  billId: string,
  tenders: TenderBody[],
  idempotencyKey: string,
): Promise<SettleResult> {
  return withTx(ctx.db, async (trx): Promise<SettleResult> => {
    const ref = await trx
      .selectFrom('bills')
      .select('order_id')
      .where('id', '=', billId)
      .where('branch_id', '=', a.branchId)
      .executeTakeFirst();
    if (!ref) throw new AppError(404, 'NOT_FOUND', 'bill not found');
    const order = await lockOrder(trx, a.branchId, ref.order_id);
    const bill = await trx
      .selectFrom('bills')
      .selectAll()
      .where('id', '=', billId)
      .forUpdate()
      .executeTakeFirstOrThrow();

    // ── replay / double-click: same key → the original result
    const mine = await trx
      .selectFrom('payments')
      .select('id')
      .where('bill_id', '=', billId)
      .where('idempotency_key', 'like', `${idempotencyKey}:%`)
      .execute();
    if (bill.status === 'SETTLED') {
      if (mine.length > 0) {
        const view = await getBillView(trx, a.branchId, billId);
        return { bill: view, changeDuePaisa: view.changeDuePaisa, receipts: 0, replayed: true };
      }
      throw new AppError(409, 'BILL_ALREADY_SETTLED', 'This bill was already paid');
    }
    if (bill.status !== 'PRE_BILLED')
      throw new AppError(409, 'BILL_NOT_PAYABLE', `A ${bill.status} bill cannot be paid`);

    // ── the cashier's own open shift, in the bill's business day
    const shift = await trx
      .selectFrom('shifts')
      .select(['id', 'business_day_id'])
      .where('opened_by', '=', a.userId)
      .where('status', '=', 'OPEN')
      .forShare() // a shift close (FOR UPDATE) waits for this payment, so it can never miss it
      .executeTakeFirst();
    if (!shift || shift.business_day_id !== bill.business_day_id)
      throw new AppError(409, 'SHIFT_NOT_OPEN', 'Open your shift before taking payment');

    // ── tenders
    const methods = await trx
      .selectFrom('payment_methods')
      .selectAll()
      .where('branch_id', '=', a.branchId)
      .where('is_active', '=', true)
      .where('id', 'in', [...new Set(tenders.map((t) => t.methodId))])
      .execute();
    if (methods.length !== new Set(tenders.map((t) => t.methodId)).size)
      throw bad('Unknown or inactive payment method');
    const isKhata = (t: TenderBody): boolean =>
      methods.find((m) => m.id === t.methodId)?.code === 'KHATA';
    const khataTenders = tenders.filter(isKhata);
    if (khataTenders.length > 1) throw bad('Only one khata tender per bill');
    if (tenders.some((t) => !isKhata(t) && t.khataAccountId))
      throw bad('khataAccountId only belongs on the khata tender');
    const khataTender = khataTenders[0];
    if (khataTender) {
      if (!a.permissions.has('khata.collect'))
        throw new AppError(403, 'PERMISSION_DENIED', 'You do not have permission for this action', {
          permission: 'khata.collect',
        });
      if (!khataTender.khataAccountId)
        throw new AppError(400, 'VALIDATION_FAILED', 'Choose the customer’s khata account');
      if (khataTender.tipPaisa) throw bad('A tip cannot be put on khata');
    }
    // The tax rate depends on HOW the bill is paid (all digital vs anything else), which is only known
    // now: price the bill with that class, then the tenders must match the resulting total exactly.
    const payClass = taxClassOf(
      tenders.map((t) => ({
        tenderClass: methods.find((m) => m.id === t.methodId)!.tender_class as
          'CASH_OTHER' | 'DIGITAL',
      })),
    );
    const taxCtx = await loadTaxContext(trx, a.branchId);
    const settleTotal =
      taxCtx.enabled || bill.tax_paisa > 0
        ? (
            await repriceBill(
              trx,
              a,
              bill,
              { kind: 'AMOUNT', paisa: asPaisa(bill.discount_paisa) },
              payClass,
            )
          ).totalPaisa
        : asPaisa(bill.total_paisa);
    const result = validateTenders(
      settleTotal,
      tenders.map((t) => {
        const m = methods.find((x) => x.id === t.methodId)!;
        return {
          methodId: m.id,
          tenderClass: m.tender_class as 'CASH_OTHER' | 'DIGITAL',
          isCash: m.opens_drawer,
          needsReference: m.needs_reference,
          amountPaisa: asPaisa(t.amountPaisa),
          tenderedPaisa: t.tenderedPaisa === undefined ? undefined : asPaisa(t.tenderedPaisa),
          tipPaisa: t.tipPaisa === undefined ? undefined : asPaisa(t.tipPaisa),
          reference: t.reference,
        };
      }),
    );

    const now = ctx.clock.now();
    for (const [i, t] of result.applied.entries()) {
      const paid = await trx
        .insertInto('payments')
        .values({
          bill_id: billId,
          shift_id: shift.id,
          method_id: t.methodId,
          tender_class: t.tenderClass,
          amount_paisa: t.amountPaisa,
          tendered_paisa: t.tenderedPaisa,
          change_paisa: t.changePaisa,
          tip_paisa: t.tipPaisa,
          reference: t.reference,
          idempotency_key: `${idempotencyKey}:${i}`,
          received_by: a.userId,
          received_at: now,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      if (khataTender && t.methodId === khataTender.methodId) {
        // credit sale: the customer's ledger takes the charge in this same transaction
        await chargeKhata(trx, a, {
          accountId: khataTender.khataAccountId!,
          billId,
          paymentId: paid.id,
          amountPaisa: t.amountPaisa,
          at: now,
        });
      }
    }
    await trx
      .updateTable('bills')
      .set({
        status: 'SETTLED',
        tax_payment_class: result.taxClass,
        settled_at: now,
        settled_by: a.userId,
        shift_id: shift.id,
      })
      .where('id', '=', billId)
      .execute();
    await trx
      .updateTable('orders')
      .set({ status: 'SETTLED', closed_at: now })
      .where('id', '=', order.id)
      .execute();
    await bumpVersion(trx, order.id);

    const view = await getBillView(trx, a.branchId, billId);
    const receipts = await queueReceipts(trx, a, view, 0, now);
    if (receipts > 0)
      await trx.updateTable('bills').set({ print_count: 1 }).where('id', '=', billId).execute();
    await audit(
      trx,
      a,
      'BILL_SETTLE',
      billId,
      { status: 'PRE_BILLED' },
      {
        status: 'SETTLED',
        totalPaisa: settleTotal,
        taxPaymentClass: result.taxClass,
        changeDuePaisa: result.changeDuePaisa,
        tenders: result.applied.map((t) => ({
          methodId: t.methodId,
          amountPaisa: t.amountPaisa,
          tipPaisa: t.tipPaisa,
        })),
      },
    );
    return {
      bill: { ...view, printCount: receipts > 0 ? 1 : 0 },
      changeDuePaisa: result.changeDuePaisa,
      receipts,
      replayed: false,
    };
  });
}

// ─────────────────────────────────── reprint ───────────────────────────────────

/** Prints a copy marked DUPLICATE #n. Needs bill.reprint and a reason; audited (rule 7). */
export function reprintBill(ctx: AppContext, a: Actor, billId: string, reason: string) {
  return withTx(ctx.db, async (trx) => {
    const bill = await trx
      .selectFrom('bills')
      .select(['id', 'status', 'print_count'])
      .where('id', '=', billId)
      .where('branch_id', '=', a.branchId)
      .forUpdate()
      .executeTakeFirst();
    if (!bill) throw new AppError(404, 'NOT_FOUND', 'bill not found');
    if (bill.status !== 'SETTLED')
      throw new AppError(409, 'BILL_NOT_PAYABLE', 'Only a settled bill has a receipt to reprint');
    const copy = Math.max(1, bill.print_count);
    const view = await getBillView(trx, a.branchId, billId);
    const jobs = await queueReceipts(trx, a, view, copy, ctx.clock.now());
    if (jobs === 0) throw new AppError(409, 'NO_PRINTER', 'No receipt printer is configured');
    await trx
      .updateTable('bills')
      .set({ print_count: bill.print_count + 1 })
      .where('id', '=', billId)
      .execute();
    await audit(
      trx,
      a,
      'BILL_REPRINT',
      billId,
      { printCount: bill.print_count },
      { printCount: bill.print_count + 1, duplicate: copy },
      reason,
    );
    return { id: billId, duplicate: copy, printers: jobs };
  });
}

export type { Paisa };
