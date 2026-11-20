import { createConnection } from 'node:net';
import { sql } from 'kysely';
import type { AppContext } from '../../http/context';
import type { Queryable } from '../../shared/tx';
import { withTx } from '../../shared/tx';

// ───────────────────────────────── transport ─────────────────────────────────

export interface PrintTarget {
  host: string;
  port: number;
}

/** How bytes reach a printer. The real one is raw TCP (port 9100); tests use real sockets too. */
export interface PrintTransport {
  send(target: PrintTarget, bytes: Uint8Array, timeoutMs: number): Promise<void>;
}

/** ESC/POS over TCP: connect, write, flush, close. Resolves only once the data was handed off. */
export class TcpTransport implements PrintTransport {
  send(target: PrintTarget, bytes: Uint8Array, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err?: Error): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (err) reject(err);
        else resolve();
      };
      const socket = createConnection({ host: target.host, port: target.port });
      socket.setTimeout(timeoutMs, () =>
        done(new Error(`printer ${target.host}:${target.port} timed out`)),
      );
      socket.once('error', (e) => done(e));
      socket.once('connect', () => {
        socket.write(Buffer.from(bytes), (err) => {
          if (err) return done(err);
          socket.end(() => done());
        });
      });
    });
  }
}

// ──────────────────────────────────── outbox ────────────────────────────────────

export interface NewPrintJob {
  branchId: string;
  printerId: string;
  kind: 'KOT' | 'KOT_CANCEL' | 'RECEIPT' | 'TEST' | 'REPORT' | 'DRAWER';
  refType: string | null;
  refId: string | null;
  title: string;
  payload: Uint8Array;
  /** Same key = same job: creating it twice is a no-op (rule 4). */
  idempotencyKey: string;
  createdBy: string | null;
  at: Date;
}

/** Adds a job inside the caller's transaction so it commits atomically with the KOT. */
export async function enqueuePrintJob(q: Queryable, j: NewPrintJob): Promise<boolean> {
  const res = await q
    .insertInto('print_jobs')
    .values({
      branch_id: j.branchId,
      printer_id: j.printerId,
      kind: j.kind,
      ref_type: j.refType,
      ref_id: j.refId,
      title: j.title,
      payload: Buffer.from(j.payload),
      idempotency_key: j.idempotencyKey,
      created_by: j.createdBy,
      created_at: j.at,
      next_attempt_at: j.at,
    })
    .onConflict((oc) => oc.column('idempotency_key').doNothing())
    .returning('id')
    .executeTakeFirst();
  return !!res;
}

let lanPrinting = true;
/**
 * The cloud API runs no print worker and cannot reach a restaurant's LAN: a NETWORK printer there would take the
 * job and never print it ("printed" on screen, nothing on paper). In the cloud only a print helper's AGENT printer
 * counts; everything else falls back to the browser's print modal. Called once when the cloud app is built.
 */
export function disableLanPrinting(): void {
  lanPrinting = false;
}
export const lanPrintingEnabled = (): boolean => lanPrinting;

export async function stationPrinters(
  q: Queryable,
  branchId: string,
  stationId: string,
  at: Date = new Date(),
) {
  const chosen = await q
    .selectFrom('station_printers')
    .innerJoin('printers', 'printers.id', 'station_printers.printer_id')
    .select(['printers.id as id', 'printers.paper_mm as paper_mm'])
    .where('station_printers.station_id', '=', stationId)
    .where('printers.branch_id', '=', branchId)
    .where('printers.is_active', '=', true)
    .where('printers.kind', '=', 'KOT')
    .$if(!lanPrinting, (qb) => qb.where('printers.conn_type', '=', 'AGENT'))
    .orderBy('printers.name')
    .execute();
  if (chosen.length > 0) return chosen;
  // nothing chosen for this station: the print helper's kitchen printer takes it, so nobody has to map stations
  const viaHelper = await q
    .selectFrom('printers')
    .select(['id', 'paper_mm'])
    .where('branch_id', '=', branchId)
    .where('is_active', '=', true)
    .where('archived_at', 'is', null)
    .where('kind', '=', 'KOT')
    .where('conn_type', '=', 'AGENT')
    .orderBy('name')
    .execute();
  if (viaHelper.length > 0) return viaHelper;
  return counterPrinters(q, branchId, at);
}

/**
 * A restaurant that never mapped a station to a printer (one printer on the counter) must still get its tickets:
 * with no station-to-printer choice anywhere in the branch, a ticket goes to the branch's kitchen printer, or when
 * there is none, to its receipt printer. Once ANY station is mapped the choices are respected and a station left
 * unmapped stays unprinted (it may work from the screen). A helper's printer counts only while the helper is online.
 */
export async function counterPrinters(q: Queryable, branchId: string, at: Date) {
  const mapped = await q
    .selectFrom('station_printers')
    .innerJoin('printers', 'printers.id', 'station_printers.printer_id')
    .select('station_printers.station_id')
    .where('printers.branch_id', '=', branchId)
    .where('printers.is_active', '=', true)
    .limit(1)
    .executeTakeFirst();
  if (mapped) return [];
  for (const kind of ['KOT', 'RECEIPT'] as const) {
    const found = await q
      .selectFrom('printers')
      .leftJoin('print_agents', 'print_agents.id', 'printers.agent_id')
      .select(['printers.id as id', 'printers.paper_mm as paper_mm'])
      .where('printers.branch_id', '=', branchId)
      .where('printers.is_active', '=', true)
      .where('printers.archived_at', 'is', null)
      .where('printers.kind', '=', kind)
      .$if(!lanPrinting, (qb) => qb.where('printers.conn_type', '=', 'AGENT'))
      .where((eb) =>
        eb.or([
          eb('printers.conn_type', '!=', 'AGENT'),
          eb('print_agents.last_seen_at', '>', new Date(at.getTime() - 90_000)),
        ]),
      )
      .orderBy('printers.name')
      .execute();
    if (found.length > 0) return found;
  }
  return [];
}

// ────────────────────────────────── the worker ──────────────────────────────────

export const SEND_TIMEOUT_MS = 3000;
export const LEASE_MS = 30_000;
/** A kitchen ticket older than this is useless; the job is parked as DEAD instead of retried. */
export const MAX_JOB_AGE_MS = 2 * 60 * 60_000;
const MAX_JOBS_PER_PRINTER_PER_RUN = 50;

/** 2 s, 4 s, 8 s, 16 s, then every 30 s. */
export function backoffMs(attempts: number): number {
  return Math.min(2 ** attempts * 1000, 30_000);
}

export interface RunResult {
  printed: number;
  failed: number;
  dead: number;
}

/**
 * One pass of the print worker (called every second by the worker process).
 *
 *  - Jobs of one printer print strictly in order (a ticket never overtakes an older one): a
 *    per-printer advisory lock serialises the claim, and a job in flight blocks its successors.
 *  - Different printers run in parallel; two workers never claim the same job (the claim happens
 *    in a transaction under that lock and marks the job IN_FLIGHT with a lease).
 *  - Transport errors → FAILED with exponential backoff; the head job keeps its place, so when
 *    the printer comes back the queue drains in order. Success is recorded right after the
 *    bytes were flushed (plain TCP printers give no acknowledgement), so a duplicate can only
 *    happen if the process dies in the instant between the write and this update.
 *  - A crashed worker's IN_FLIGHT jobs are recovered when their lease expires.
 */
export async function processPrintJobs(
  ctx: AppContext,
  transport: PrintTransport,
): Promise<RunResult> {
  const now = ctx.clock.now();
  const result: RunResult = { printed: 0, failed: 0, dead: 0 };

  await ctx.db
    .updateTable('print_jobs')
    .set({ status: 'PENDING', lease_until: null })
    .where('status', '=', 'IN_FLIGHT')
    .where('lease_until', '<', now)
    .execute();

  const due = await ctx.db
    .selectFrom('print_jobs')
    .innerJoin('printers', 'printers.id', 'print_jobs.printer_id')
    .select('print_jobs.printer_id as printer_id')
    .distinct()
    .where('printers.conn_type', '!=', 'AGENT') // those are fetched by the print helper (agent.service)
    .where('print_jobs.status', 'in', ['PENDING', 'FAILED'])
    .where('print_jobs.next_attempt_at', '<=', now)
    .execute();

  await Promise.all(due.map((d) => drainPrinter(ctx, transport, d.printer_id, result)));
  return result;
}

export async function claimHead(ctx: AppContext, printerId: string, now: Date) {
  return withTx(ctx.db, async (trx) => {
    const lock = await sql<{
      ok: boolean;
    }>`select pg_try_advisory_xact_lock(hashtextextended(${'printer:' + printerId}, 0)) as ok`.execute(
      trx,
    );
    if (!lock.rows[0]!.ok) return null; // another worker is claiming for this printer

    const busy = await trx
      .selectFrom('print_jobs')
      .select('id')
      .where('printer_id', '=', printerId)
      .where('status', '=', 'IN_FLIGHT')
      .where('lease_until', '>=', now)
      .limit(1)
      .executeTakeFirst();
    if (busy) return null; // keep order: wait for the job in flight

    const head = await trx
      .selectFrom('print_jobs')
      .selectAll()
      .where('printer_id', '=', printerId)
      .where('status', 'in', ['PENDING', 'FAILED'])
      .orderBy('seq')
      .limit(1)
      .forUpdate()
      .executeTakeFirst();
    if (!head || head.next_attempt_at > now) return null; // head-of-line backoff: later jobs wait too

    await trx
      .updateTable('print_jobs')
      .set({
        status: 'IN_FLIGHT',
        attempts: head.attempts + 1,
        lease_until: new Date(now.getTime() + LEASE_MS),
      })
      .where('id', '=', head.id)
      .execute();
    const printer = await trx
      .selectFrom('printers')
      .selectAll()
      .where('id', '=', printerId)
      .executeTakeFirstOrThrow();
    return { job: { ...head, attempts: head.attempts + 1 }, printer };
  });
}

async function drainPrinter(
  ctx: AppContext,
  transport: PrintTransport,
  printerId: string,
  result: RunResult,
): Promise<void> {
  for (let i = 0; i < MAX_JOBS_PER_PRINTER_PER_RUN; i++) {
    const now = ctx.clock.now();
    const claimed = await claimHead(ctx, printerId, now);
    if (!claimed) return;
    const { job, printer } = claimed;

    let error: string | null = null;
    let retryable = true;
    if (!printer.is_active) {
      error = 'printer is deactivated';
      retryable = false;
    } else if (printer.conn_type !== 'NETWORK' || !printer.host) {
      error = `unsupported connection (${printer.conn_type}${printer.host ? '' : ', no host'})`;
      retryable = false;
    } else {
      try {
        await transport.send(
          { host: printer.host, port: printer.port ?? 9100 },
          job.payload,
          SEND_TIMEOUT_MS,
        );
      } catch (e) {
        error = (e as Error).message;
      }
    }

    const at = ctx.clock.now();
    if (error === null) {
      await ctx.db
        .updateTable('print_jobs')
        .set({ status: 'DONE', printed_at: at, lease_until: null, last_error: null })
        .where('id', '=', job.id)
        .execute();
      await ctx.db
        .updateTable('printers')
        .set({ last_ok_at: at, last_error: null })
        .where('id', '=', printerId)
        .execute();
      result.printed++;
      continue;
    }

    const tooOld = at.getTime() - job.created_at.getTime() > MAX_JOB_AGE_MS;
    if (!retryable || tooOld) {
      await ctx.db
        .updateTable('print_jobs')
        .set({
          status: 'DEAD',
          lease_until: null,
          last_error:
            tooOld && retryable
              ? `gave up after ${Math.round(MAX_JOB_AGE_MS / 60_000)} min: ${error}`
              : error,
        })
        .where('id', '=', job.id)
        .execute();
      result.dead++;
      if (!retryable) continue; // a configuration problem of one job must not block the queue
    } else {
      await ctx.db
        .updateTable('print_jobs')
        .set({
          status: 'FAILED',
          lease_until: null,
          last_error: error,
          next_attempt_at: new Date(at.getTime() + backoffMs(job.attempts)),
        })
        .where('id', '=', job.id)
        .execute();
      result.failed++;
    }
    await ctx.db
      .updateTable('printers')
      .set({ last_error: error, last_error_at: at })
      .where('id', '=', printerId)
      .execute();
    return; // printer is down: stop for this printer, try again after the backoff
  }
}

// ───────────────────────────────── health & admin ─────────────────────────────────

export type PrinterState = 'OK' | 'OFFLINE' | 'UNKNOWN' | 'INACTIVE';

export async function getPrinterHealth(ctx: AppContext, branchId: string) {
  const printers = await ctx.db
    .selectFrom('printers')
    .selectAll()
    .where('branch_id', '=', branchId)
    .where('archived_at', 'is', null)
    .orderBy('name')
    .execute();
  const counts = await ctx.db
    .selectFrom('print_jobs')
    .select(['printer_id', 'status', (eb) => eb.fn.countAll<string>().as('n')])
    .where('branch_id', '=', branchId)
    .where('status', 'in', ['PENDING', 'FAILED', 'IN_FLIGHT', 'DEAD'])
    .groupBy(['printer_id', 'status'])
    .execute();
  const n = (printerId: string, ...statuses: string[]): number =>
    counts
      .filter((c) => c.printer_id === printerId && statuses.includes(c.status))
      .reduce((acc, c) => acc + Number(c.n), 0);

  return printers.map((p) => {
    const state: PrinterState = !p.is_active
      ? 'INACTIVE'
      : p.last_error // cleared by every successful print, set by every failed attempt
        ? 'OFFLINE'
        : p.last_ok_at
          ? 'OK'
          : 'UNKNOWN';
    return {
      id: p.id,
      name: p.name,
      kind: p.kind,
      host: p.host,
      port: p.port,
      state,
      queued: n(p.id, 'PENDING', 'FAILED', 'IN_FLIGHT'),
      dead: n(p.id, 'DEAD'),
      lastOkAt: p.last_ok_at,
      lastError: state === 'OFFLINE' ? p.last_error : null,
      lastErrorAt: p.last_error_at,
    };
  });
}
