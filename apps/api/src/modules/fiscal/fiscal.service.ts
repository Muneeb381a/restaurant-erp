import {
  FiscalError,
  MockFiscalProvider,
  type FiscalInvoice,
  type FiscalProvider,
} from '@erp/fiscal-adapters';
import { sql } from 'kysely';
import type { AppContext } from '../../http/context';
import { AppError } from '../../http/errors';
import { withTx, type Queryable } from '../../shared/tx';
import { writeAudit } from '../audit/audit.service';
import type { Actor } from '../orders/orders.service';

/**
 * Fiscal reporting outbox (rule 4 + rule 9): a bill or credit note is queued in the transaction that
 * creates it; this worker reports it to the authority with retries. Printing a receipt and taking
 * the money never wait for the internet.
 */

export type FiscalDocType = 'BILL' | 'CREDIT_NOTE';
const LEASE_MS = 2 * 60_000;
/** 30 s, 1 m, 2 m, 5 m, 10 m, 30 m, then hourly. */
export const FISCAL_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000];
export const fiscalBackoffMs = (attempt: number): number =>
  FISCAL_BACKOFF_MS[Math.min(Math.max(attempt, 1), FISCAL_BACKOFF_MS.length) - 1] as number;

/** The providers this build can talk to. Real authority drivers are added here (OPEN-QUESTIONS #20). */
const mock = new MockFiscalProvider();
export const defaultFiscalProviders = (code: string): FiscalProvider | undefined =>
  code === 'MOCK' ? mock : undefined;

/** The provider code when fiscal reporting is on for the branch; null when it is off. */
export async function activeFiscalProvider(q: Queryable, branchId: string): Promise<string | null> {
  const rows = await q
    .selectFrom('settings')
    .select(['key', 'value'])
    .where('branch_id', '=', branchId)
    .where('key', 'in', ['fiscal.provider', 'tax.enabled'])
    .execute();
  const get = (k: string): unknown => rows.find((r) => r.key === k)?.value;
  const code = get('fiscal.provider');
  return get('tax.enabled') === true && typeof code === 'string' && code !== 'OFF' ? code : null;
}

/** Queues a document for reporting inside the caller's transaction (idempotent per document). */
export async function enqueueFiscal(
  trx: Queryable,
  branchId: string,
  docType: FiscalDocType,
  docId: string,
  at: Date,
): Promise<boolean> {
  const provider = await activeFiscalProvider(trx, branchId);
  if (!provider) return false;
  const inserted = await trx
    .insertInto('fiscal_jobs')
    .values({
      branch_id: branchId,
      doc_type: docType,
      doc_id: docId,
      provider: provider as 'MOCK',
      idempotency_key: `${provider}:${docType}:${docId}`,
      next_attempt_at: at,
    })
    .onConflict((oc) => oc.column('idempotency_key').doNothing())
    .returning('id')
    .executeTakeFirst();
  if (inserted) {
    await (
      docType === 'BILL'
        ? trx.updateTable('bills').set({ fiscal_status: 'PENDING' }).where('id', '=', docId)
        : trx.updateTable('credit_notes').set({ fiscal_status: 'PENDING' }).where('id', '=', docId)
    ).execute();
  }
  return !!inserted;
}

// ───────────────────────────── building the document ─────────────────────────────

async function seller(q: Queryable, branchId: string) {
  const b = await q
    .selectFrom('branches')
    .select(['name', 'ntn', 'strn'])
    .where('id', '=', branchId)
    .executeTakeFirstOrThrow();
  return { name: b.name, ntn: b.ntn, strn: b.strn };
}

export async function buildInvoice(
  q: Queryable,
  job: { branch_id: string; doc_type: string; doc_id: string; idempotency_key: string },
): Promise<FiscalInvoice> {
  const sellerInfo = await seller(q, job.branch_id);
  if (job.doc_type === 'BILL') {
    const bill = await q
      .selectFrom('bills')
      .innerJoin('business_days', 'business_days.id', 'bills.business_day_id')
      .selectAll('bills')
      .select('business_days.business_date as business_date')
      .where('bills.id', '=', job.doc_id)
      .executeTakeFirstOrThrow();
    const lines = await q
      .selectFrom('bill_lines')
      .selectAll()
      .where('bill_id', '=', bill.id)
      .orderBy('id')
      .execute();
    return {
      kind: 'INVOICE',
      documentNo: bill.bill_no,
      originalInvoiceNo: null,
      businessDate: bill.business_date,
      issuedAt: (bill.settled_at ?? bill.created_at).toISOString(),
      seller: sellerInfo,
      lines: lines.map((l) => ({
        description: l.description,
        qty: Number(l.qty),
        unitPricePaisa: l.unit_price_paisa ?? 0,
        netPaisa: l.net_paisa,
        taxPaisa: l.tax_paisa,
        taxRateBps: l.tax_rate_bps,
      })),
      subtotalPaisa: bill.subtotal_paisa,
      discountPaisa: bill.discount_paisa,
      serviceChargePaisa: bill.service_charge_paisa,
      taxPaisa: bill.tax_paisa,
      totalPaisa: bill.total_paisa,
      paymentClass: (bill.tax_payment_class ?? 'CASH_OTHER') as 'CASH_OTHER' | 'DIGITAL',
      idempotencyKey: job.idempotency_key,
    };
  }
  const cn = await q
    .selectFrom('credit_notes')
    .innerJoin('business_days', 'business_days.id', 'credit_notes.business_day_id')
    .innerJoin('bills', 'bills.id', 'credit_notes.bill_id')
    .selectAll('credit_notes')
    .select([
      'business_days.business_date as business_date',
      'bills.fiscal_invoice_no as original_no',
      'bills.tax_payment_class as pay_class',
    ])
    .where('credit_notes.id', '=', job.doc_id)
    .executeTakeFirstOrThrow();
  const lines = await q
    .selectFrom('credit_note_lines')
    .innerJoin('bill_lines', 'bill_lines.id', 'credit_note_lines.bill_line_id')
    .select([
      'bill_lines.description as description',
      'credit_note_lines.qty as qty',
      'bill_lines.unit_price_paisa as unit',
      'credit_note_lines.net_paisa as net',
      'credit_note_lines.tax_paisa as tax',
      'bill_lines.tax_rate_bps as rate',
    ])
    .where('credit_note_lines.credit_note_id', '=', cn.id)
    .execute();
  return {
    kind: 'CREDIT_NOTE',
    documentNo: cn.cn_no,
    originalInvoiceNo: cn.original_no,
    businessDate: cn.business_date,
    issuedAt: cn.created_at.toISOString(),
    seller: sellerInfo,
    lines: lines.map((l) => ({
      description: l.description,
      qty: Number(l.qty),
      unitPricePaisa: l.unit ?? 0,
      netPaisa: l.net,
      taxPaisa: l.tax,
      taxRateBps: l.rate,
    })),
    subtotalPaisa: cn.net_paisa,
    discountPaisa: 0,
    serviceChargePaisa: 0,
    taxPaisa: cn.tax_paisa,
    totalPaisa: cn.total_paisa,
    paymentClass: (cn.pay_class ?? 'CASH_OTHER') as 'CASH_OTHER' | 'DIGITAL',
    idempotencyKey: job.idempotency_key,
  };
}

// ─────────────────────────────────── the worker ───────────────────────────────────

export interface FiscalPass {
  submitted: number;
  retrying: number;
  rejected: number;
  deferred: number;
}

/**
 * Reports due documents. The claim is transactional (`SKIP LOCKED`, with a lease for crashed workers);
 * the provider is called OUTSIDE any transaction; the outcome is recorded in a second one. A document
 * the authority refuses is parked (`permanent`) until someone retries it; a network problem backs off.
 */
export async function processFiscalJobs(
  ctx: AppContext,
  resolve: (code: string) => FiscalProvider | undefined = defaultFiscalProviders,
  limit = 20,
): Promise<FiscalPass> {
  const pass: FiscalPass = { submitted: 0, retrying: 0, rejected: 0, deferred: 0 };
  for (let i = 0; i < limit; i++) {
    const now = ctx.clock.now();
    const job = await withTx(ctx.db, async (trx) => {
      const row = await trx
        .selectFrom('fiscal_jobs')
        .selectAll()
        .where((eb) =>
          eb.or([
            eb.and([
              eb('status', 'in', ['PENDING', 'FAILED']),
              eb('permanent', '=', false),
              eb('next_attempt_at', '<=', now),
            ]),
            eb.and([
              eb('status', '=', 'IN_FLIGHT'),
              eb('updated_at', '<', new Date(now.getTime() - LEASE_MS)),
            ]),
          ]),
        )
        .orderBy('created_at')
        .limit(1)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!row) return null;
      await trx
        .updateTable('fiscal_jobs')
        .set({ status: 'IN_FLIGHT', attempts: row.attempts + 1, updated_at: now })
        .where('id', '=', row.id)
        .execute();
      return { ...row, attempts: row.attempts + 1 };
    });
    if (!job) break;

    const provider = resolve(job.provider);
    try {
      if (!provider) throw new FiscalError(`No driver for provider ${job.provider}`, true);
      const request = await buildInvoice(ctx.db, job);
      // a credit note can only be reported once its original invoice has a fiscal number
      if (request.kind === 'CREDIT_NOTE' && !request.originalInvoiceNo) {
        await ctx.db
          .updateTable('fiscal_jobs')
          .set({
            status: 'PENDING',
            attempts: job.attempts - 1,
            next_attempt_at: new Date(now.getTime() + 15_000),
            last_error: 'waiting for the original invoice to be reported',
            updated_at: now,
          })
          .where('id', '=', job.id)
          .execute();
        pass.deferred++;
        continue;
      }
      const result = await provider.submit(request);
      await withTx(ctx.db, async (trx) => {
        await trx
          .updateTable('fiscal_jobs')
          .set({
            status: 'DONE',
            request: JSON.stringify(request),
            response: JSON.stringify(result.raw ?? {}),
            last_error: null,
            updated_at: now,
          })
          .where('id', '=', job.id)
          .execute();
        const done = {
          fiscal_status: 'SUBMITTED' as const,
          fiscal_invoice_no: result.invoiceNo,
          fiscal_qr: result.qr,
          fiscal_submitted_at: now,
        };
        if (job.doc_type === 'BILL')
          await trx.updateTable('bills').set(done).where('id', '=', job.doc_id).execute();
        else await trx.updateTable('credit_notes').set(done).where('id', '=', job.doc_id).execute();
      });
      pass.submitted++;
    } catch (e) {
      const err =
        e instanceof FiscalError
          ? e
          : new FiscalError(e instanceof Error ? e.message : String(e), true);
      await withTx(ctx.db, async (trx) => {
        await trx
          .updateTable('fiscal_jobs')
          .set({
            status: 'FAILED',
            permanent: !err.retryable,
            last_error: err.message.slice(0, 500),
            next_attempt_at: new Date(
              now.getTime() + (err.retryable ? fiscalBackoffMs(job.attempts) : 0),
            ),
            updated_at: now,
          })
          .where('id', '=', job.id)
          .execute();
        if (!err.retryable) {
          const failed = { fiscal_status: 'FAILED' as const };
          if (job.doc_type === 'BILL')
            await trx.updateTable('bills').set(failed).where('id', '=', job.doc_id).execute();
          else
            await trx
              .updateTable('credit_notes')
              .set(failed)
              .where('id', '=', job.doc_id)
              .execute();
        }
      });
      if (err.retryable) pass.retrying++;
      else pass.rejected++;
    }
  }
  return pass;
}

// ─────────────────────────────────── admin ───────────────────────────────────

export async function fiscalSummary(q: Queryable, branchId: string) {
  const rows = await q
    .selectFrom('fiscal_jobs')
    .select(['status', 'permanent', sql<number>`count(*)::int`.as('n')])
    .where('branch_id', '=', branchId)
    .groupBy(['status', 'permanent'])
    .execute();
  const n = (f: (r: (typeof rows)[number]) => boolean): number =>
    rows.filter(f).reduce((s, r) => s + r.n, 0);
  return {
    pending: n((r) => r.status === 'PENDING' || r.status === 'IN_FLIGHT'),
    retrying: n((r) => r.status === 'FAILED' && !r.permanent),
    rejected: n((r) => r.status === 'FAILED' && r.permanent),
    done: n((r) => r.status === 'DONE'),
  };
}

export async function listFiscalJobs(
  q: Queryable,
  branchId: string,
  status: 'open' | 'rejected' | 'all',
  limit: number,
) {
  let query = q
    .selectFrom('fiscal_jobs')
    .select([
      'id',
      'doc_type as docType',
      'doc_id as docId',
      'provider',
      'status',
      'permanent',
      'attempts',
      'next_attempt_at as nextAttemptAt',
      'last_error as lastError',
      'created_at as createdAt',
    ])
    .where('branch_id', '=', branchId)
    .orderBy('created_at', 'desc')
    .limit(limit);
  if (status === 'open') query = query.where('status', '!=', 'DONE');
  if (status === 'rejected') query = query.where('permanent', '=', true);
  return query.execute();
}

/** Puts a parked or backing-off job back in the queue (audited). */
export function retryFiscalJob(ctx: AppContext, a: Actor, id: string) {
  return withTx(ctx.db, async (trx) => {
    const job = await trx
      .selectFrom('fiscal_jobs')
      .selectAll()
      .where('id', '=', id)
      .where('branch_id', '=', a.branchId)
      .forUpdate()
      .executeTakeFirst();
    if (!job) throw new AppError(404, 'NOT_FOUND', 'fiscal job not found');
    if (job.status === 'DONE')
      throw new AppError(409, 'CONFLICT', 'This document was already reported');
    const now = ctx.clock.now();
    await trx
      .updateTable('fiscal_jobs')
      .set({ status: 'PENDING', permanent: false, next_attempt_at: now, updated_at: now })
      .where('id', '=', id)
      .execute();
    await (
      job.doc_type === 'BILL'
        ? trx.updateTable('bills').set({ fiscal_status: 'PENDING' }).where('id', '=', job.doc_id)
        : trx
            .updateTable('credit_notes')
            .set({ fiscal_status: 'PENDING' })
            .where('id', '=', job.doc_id)
    ).execute();
    await writeAudit(trx, {
      branchId: a.branchId,
      userId: a.userId,
      deviceId: a.deviceId,
      action: 'FISCAL_RETRY',
      entity: 'fiscal_job',
      entityId: id,
      before: { status: job.status, lastError: job.last_error },
      after: { status: 'PENDING' },
      ip: a.ip,
    });
    return { id, status: 'PENDING' as const };
  });
}

/**
 * Day reconciliation: what was sold and taxed versus what the authority has been told. Anything in
 * `unreported` needs attention before the tax return is filed.
 */
export async function fiscalReconciliation(q: Queryable, branchId: string, businessDate: string) {
  const day = await q
    .selectFrom('business_days')
    .select('id')
    .where('branch_id', '=', branchId)
    .where('business_date', '=', businessDate)
    .executeTakeFirst();
  if (!day) throw new AppError(404, 'NOT_FOUND', 'no business day on that date');
  const big = (expr: ReturnType<typeof sql>) => sql<number>`COALESCE(${expr}, 0)::bigint`;
  const bills = await q
    .selectFrom('bills')
    .select([
      'fiscal_status as status',
      sql<number>`count(*)::int`.as('n'),
      big(sql`sum(total_paisa)`).as('total'),
      big(sql`sum(tax_paisa)`).as('tax'),
    ])
    .where('business_day_id', '=', day.id)
    .where('status', '=', 'SETTLED')
    .groupBy('fiscal_status')
    .execute();
  const notes = await q
    .selectFrom('credit_notes')
    .select([
      'fiscal_status as status',
      sql<number>`count(*)::int`.as('n'),
      big(sql`sum(total_paisa)`).as('total'),
      big(sql`sum(tax_paisa)`).as('tax'),
    ])
    .where('business_day_id', '=', day.id)
    .groupBy('fiscal_status')
    .execute();
  const unreported = await q
    .selectFrom('bills')
    .select([
      'id',
      'bill_no as billNo',
      'total_paisa as totalPaisa',
      'tax_paisa as taxPaisa',
      'fiscal_status as status',
    ])
    .where('business_day_id', '=', day.id)
    .where('status', '=', 'SETTLED')
    .where('fiscal_status', 'in', ['PENDING', 'FAILED'])
    .orderBy('bill_no')
    .execute();
  const sum = (
    rows: typeof bills,
    f: (r: (typeof bills)[number]) => number,
    only?: string,
  ): number => rows.filter((r) => !only || r.status === only).reduce((n, r) => n + f(r), 0);
  const by = (rows: typeof bills) =>
    Object.fromEntries(
      rows.map((r) => [r.status, { count: r.n, totalPaisa: r.total, taxPaisa: r.tax }]),
    );
  return {
    businessDate,
    bills: by(bills),
    creditNotes: by(notes),
    taxSoldPaisa: sum(bills, (r) => r.tax),
    taxReportedPaisa: sum(bills, (r) => r.tax, 'SUBMITTED'),
    taxReversedReportedPaisa: sum(notes, (r) => r.tax, 'SUBMITTED'),
    balanced:
      unreported.length === 0 &&
      !notes.some((n) => n.status === 'PENDING' || n.status === 'FAILED'),
    unreported,
  };
}
