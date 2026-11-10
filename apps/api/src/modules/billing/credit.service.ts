import {
  assertCanTakeOut,
  computeRefund,
  type RefundableLine,
  type RefundRequestLine,
} from '@erp/domain';
import { renderReport, type PaperMm, type ReportDoc } from '@erp/printing';
import { sql } from 'kysely';
import type { AppContext } from '../../http/context';
import { AppError } from '../../http/errors';
import { withTx, type Queryable } from '../../shared/tx';
import { writeAudit } from '../audit/audit.service';
import { enqueueFiscal } from '../fiscal/fiscal.service';
import { refundToKhata } from '../khata/khata.service';
import { nextDocNo, openBusinessDay } from '../orders/orders.repo';
import type { Actor } from '../orders/orders.service';
import { enqueuePrintJob } from '../printing/print.service';
import { shiftReport } from '../reports/cash-report';

const bad = (message: string): AppError => new AppError(400, 'VALIDATION_FAILED', message);

const milli = (qty: string | number): number => Math.round(Number(qty) * 1000);

export interface CreditNoteInput {
  /** Return everything that is still returnable. */
  all?: boolean | undefined;
  /** Or specific lines; `qty` may have up to three decimals (weights). */
  lines?: { billLineId: string; qty: number }[] | undefined;
  reason: string;
  methodId: string;
  reference?: string | undefined;
}

// ───────────────────────────────── reads ─────────────────────────────────

/** A settled bill's lines with how much of each has already been returned. */
export async function getRefundable(q: Queryable, branchId: string, billId: string) {
  const bill = await q
    .selectFrom('bills')
    .selectAll()
    .where('id', '=', billId)
    .where('branch_id', '=', branchId)
    .executeTakeFirst();
  if (!bill) throw new AppError(404, 'NOT_FOUND', 'bill not found');
  const lines = await q
    .selectFrom('bill_lines')
    .selectAll()
    .where('bill_id', '=', billId)
    .orderBy('id')
    .execute();
  const returned = await q
    .selectFrom('credit_note_lines')
    .select(['bill_line_id', sql<string>`SUM(qty)::text`.as('qty')])
    .where(
      'bill_line_id',
      'in',
      lines.length ? lines.map((l) => l.id) : ['00000000-0000-0000-0000-000000000000'],
    )
    .groupBy('bill_line_id')
    .execute();
  const refundedMilli = (id: string): number =>
    milli(returned.find((r) => r.bill_line_id === id)?.qty ?? 0);
  const refundable: RefundableLine[] = lines.map((l) => ({
    id: l.id,
    netPaisa: l.net_paisa,
    qtyMilli: milli(l.qty),
    refundedQtyMilli: refundedMilli(l.id),
    taxPaisa: l.tax_paisa,
  }));
  return { bill, lines, refundable };
}

export async function creditNotesOf(q: Queryable, billId: string) {
  const rows = await q
    .selectFrom('credit_notes')
    .leftJoin('payment_methods', 'payment_methods.id', 'credit_notes.refund_method_id')
    .select([
      'credit_notes.id as id',
      'credit_notes.cn_no as cnNo',
      'credit_notes.total_paisa as totalPaisa',
      'credit_notes.reason as reason',
      'credit_notes.created_at as createdAt',
      'payment_methods.name as method',
    ])
    .where('credit_notes.bill_id', '=', billId)
    .orderBy('credit_notes.created_at')
    .execute();
  return rows;
}

export async function refundableView(ctx: AppContext, branchId: string, billId: string) {
  const { bill, lines, refundable } = await getRefundable(ctx.db, branchId, billId);
  const notes = await creditNotesOf(ctx.db, billId);
  return {
    billId: bill.id,
    billNo: bill.bill_no,
    status: bill.status,
    totalPaisa: bill.total_paisa,
    refundedPaisa: notes.reduce((n, c) => n + c.totalPaisa, 0),
    lines: lines.map((l, i) => ({
      id: l.id,
      description: l.description,
      qty: Number(l.qty),
      refundedQty: refundable[i]!.refundedQtyMilli / 1000,
      remainingQty: (refundable[i]!.qtyMilli - refundable[i]!.refundedQtyMilli) / 1000,
      netPaisa: l.net_paisa,
    })),
    creditNotes: notes,
  };
}

// ─────────────────────────────── create / preview ───────────────────────────────

function requestLines(input: CreditNoteInput, refundable: RefundableLine[]): RefundRequestLine[] {
  if (input.all === true) {
    const rest = refundable
      .filter((l) => l.qtyMilli - l.refundedQtyMilli > 0)
      .map((l) => ({ lineId: l.id, qtyMilli: l.qtyMilli - l.refundedQtyMilli }));
    if (rest.length === 0)
      throw new AppError(409, 'NOTHING_TO_REFUND', 'Everything on this bill was already returned');
    return rest;
  }
  if (!input.lines?.length) throw bad('Choose what to return');
  return input.lines.map((l) => {
    const m = Math.round(l.qty * 1000);
    if (Math.abs(l.qty * 1000 - m) > 1e-6) throw bad('A quantity can have at most three decimals');
    return { lineId: l.billLineId, qtyMilli: m };
  });
}

/**
 * Credit note on a SETTLED bill, in one transaction: lock the bill (serialises returns), compute the
 * refund in the domain, pay it back through the chosen method (cash comes out of the cashier's open
 * drawer; khata lowers the customer's balance), number it, audit it, print it. `dryRun` returns the
 * computed amounts and writes nothing (the UI previews with it; it never does the maths itself).
 */
export function createCreditNote(
  ctx: AppContext,
  a: Actor,
  billId: string,
  input: CreditNoteInput,
  idempotencyKey: string | null,
) {
  return withTx(ctx.db, async (trx) => {
    const head = await trx
      .selectFrom('bills')
      .select(['id', 'status'])
      .where('id', '=', billId)
      .where('branch_id', '=', a.branchId)
      .forUpdate()
      .executeTakeFirst();
    if (!head) throw new AppError(404, 'NOT_FOUND', 'bill not found');

    if (idempotencyKey) {
      const existing = await trx
        .selectFrom('credit_notes')
        .select(['id', 'bill_id', 'cn_no', 'total_paisa'])
        .where('idempotency_key', '=', idempotencyKey)
        .executeTakeFirst();
      if (existing) {
        if (existing.bill_id !== billId)
          throw new AppError(409, 'CONFLICT', 'That Idempotency-Key was used for another bill');
        return {
          id: existing.id,
          cnNo: existing.cn_no,
          totalPaisa: existing.total_paisa,
          lines: [],
          completesBill: false,
          replayed: true,
          dryRun: false,
          printers: 0,
        };
      }
    }
    if (head.status !== 'SETTLED')
      throw new AppError(
        409,
        'BILL_NOT_PAYABLE',
        `Only a settled bill can be credited (this one is ${head.status})`,
      );

    const { bill, lines, refundable } = await getRefundable(trx, a.branchId, billId);
    const result = computeRefund(
      {
        subtotalPaisa: bill.subtotal_paisa,
        discountPaisa: bill.discount_paisa,
        serviceChargePaisa: bill.service_charge_paisa,
        roundOffPaisa: bill.round_off_paisa,
        totalPaisa: bill.total_paisa,
      },
      refundable,
      requestLines(input, refundable),
    );
    const preview = {
      taxPaisa: result.taxPaisa,
      lines: result.lines.map((l) => ({
        billLineId: l.lineId,
        taxPaisa: l.taxPaisa,
        description: lines.find((x) => x.id === l.lineId)!.description,
        qty: l.qtyMilli / 1000,
        paisa: l.paisa,
      })),
      totalPaisa: result.totalPaisa,
      completesBill: result.completesBill,
    };
    if (idempotencyKey === null)
      return {
        ...preview,
        dryRun: true as const,
        replayed: false,
        id: null,
        cnNo: null,
        printers: 0,
      };

    // ── pay it back
    const method = await trx
      .selectFrom('payment_methods')
      .selectAll()
      .where('id', '=', input.methodId)
      .where('branch_id', '=', a.branchId)
      .where('is_active', '=', true)
      .executeTakeFirst();
    if (!method) throw bad('Unknown or inactive refund method');
    const reference = input.reference?.trim() || null;
    if (method.code !== 'KHATA' && method.needs_reference && !reference)
      throw bad('A reference is required for this refund method');

    const mine = await trx
      .selectFrom('shifts')
      .select('id')
      .where('opened_by', '=', a.userId)
      .where('status', '=', 'OPEN')
      .forShare()
      .executeTakeFirst();
    if (!mine)
      throw new AppError(409, 'SHIFT_NOT_OPEN', 'Open your shift before paying out a refund');
    const day = await openBusinessDay(trx, a.branchId);
    if (!day) throw new AppError(409, 'DAY_NOT_OPEN', 'There is no open business day');

    if (method.opens_drawer) {
      const report = await shiftReport(trx, a.branchId, mine.id);
      assertCanTakeOut(result.totalPaisa, report.expectedCashPaisa); // cash that is not in the drawer cannot be refunded
    }

    const now = ctx.clock.now();
    const cnNo = await nextDocNo(trx, a.branchId, day.id, 'CREDIT_NOTE');
    const cn = await trx
      .insertInto('credit_notes')
      .values({
        branch_id: a.branchId,
        business_day_id: day.id,
        bill_id: billId,
        cn_no: cnNo,
        reason: input.reason,
        net_paisa: result.totalPaisa - result.taxPaisa,
        tax_paisa: result.taxPaisa, // reversed at each line's original rate
        total_paisa: result.totalPaisa,
        refund_method_id: method.id,
        shift_id: mine.id,
        approved_by: a.userId,
        created_by: a.userId,
        created_at: now,
        idempotency_key: idempotencyKey,
        refund_reference: reference,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('credit_note_lines')
      .values(
        result.lines.map((l) => ({
          credit_note_id: cn.id,
          bill_line_id: l.lineId,
          qty: (l.qtyMilli / 1000).toFixed(3),
          net_paisa: l.paisa - l.taxPaisa,
          tax_paisa: l.taxPaisa,
        })),
      )
      .execute();

    await enqueueFiscal(trx, a.branchId, 'CREDIT_NOTE', cn.id, now);
    let khata: { customer: string; balancePaisa: number } | null = null;
    if (method.code === 'KHATA')
      khata = await refundToKhata(trx, a, {
        billId,
        creditNoteId: cn.id,
        amountPaisa: result.totalPaisa,
        at: now,
      });

    await writeAudit(trx, {
      branchId: a.branchId,
      userId: a.userId,
      deviceId: a.deviceId,
      action: 'CREDIT_NOTE',
      entity: 'bill',
      entityId: billId,
      before: { billTotalPaisa: bill.total_paisa },
      after: {
        cnNo,
        totalPaisa: result.totalPaisa,
        method: method.code,
        completesBill: result.completesBill,
        lines: preview.lines.map((l) => ({ billLineId: l.billLineId, qty: l.qty, paisa: l.paisa })),
      },
      reason: input.reason,
      ip: a.ip,
    });

    const branch = await trx
      .selectFrom('branches')
      .select(['name', 'timezone'])
      .where('id', '=', a.branchId)
      .executeTakeFirstOrThrow();
    const doc = creditNoteDoc({
      restaurant: branch.name,
      tz: branch.timezone,
      at: now,
      cnNo,
      billNo: bill.bill_no,
      lines: preview.lines,
      totalPaisa: result.totalPaisa,
      taxPaisa: result.taxPaisa,
      method: method.name,
      reason: input.reason,
      khataCustomer: khata?.customer ?? null,
      cash: method.opens_drawer,
    });
    const printersRows = await trx
      .selectFrom('printers')
      .select(['id', 'paper_mm'])
      .where('branch_id', '=', a.branchId)
      .where('kind', '=', 'RECEIPT')
      .where('is_active', '=', true)
      .orderBy('name')
      .execute();
    let printers = 0;
    for (const p of printersRows) {
      const ok = await enqueuePrintJob(trx, {
        branchId: a.branchId,
        printerId: p.id,
        kind: 'RECEIPT',
        refType: 'credit_note',
        refId: cn.id,
        title: `Credit note #${cnNo}`,
        payload: renderReport(doc, p.paper_mm as PaperMm),
        idempotencyKey: `credit-note:${cn.id}:${p.id}`,
        createdBy: a.userId,
        at: now,
      });
      if (ok) printers++;
    }
    return { id: cn.id, cnNo, ...preview, dryRun: false as const, replayed: false, printers };
  });
}

function creditNoteDoc(d: {
  restaurant: string;
  tz: string;
  at: Date;
  cnNo: number;
  billNo: number;
  lines: { description: string; qty: number; paisa: number }[];
  totalPaisa: number;
  taxPaisa: number;
  method: string;
  reason: string;
  khataCustomer: string | null;
  cash: boolean;
}): ReportDoc {
  const when = new Intl.DateTimeFormat('en-GB', {
    timeZone: d.tz,
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(d.at);
  return {
    title: 'CREDIT NOTE',
    restaurant: d.restaurant,
    subtitle: [`Credit note #${d.cnNo}`, `Against bill #${d.billNo}`, when],
    openDrawer: d.cash,
    sections: [
      {
        heading: 'Returned',
        rows: d.lines.map((l): [string, number] => [`${l.qty} x ${l.description}`, l.paisa]),
      },
      {
        heading: 'Refund',
        rows: [
          ['Method', d.method],
          ...(d.khataCustomer ? ([['Khata a/c', d.khataCustomer]] as [string, string][]) : []),
          ['Reason', d.reason],
          ...(d.taxPaisa > 0 ? ([['incl. tax reversed', d.taxPaisa]] as [string, number][]) : []),
          ['TOTAL REFUND', d.totalPaisa],
        ],
        boldLast: true,
      },
    ],
  };
}
