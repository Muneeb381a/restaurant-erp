import type { AppContext } from '../../http/context';
import { AppError } from '../../http/errors';
import { writeAudit } from '../audit/audit.service';
import { hashSecret, randomSecret, secureEquals } from '../auth/tokens';
import { backoffMs, claimHead, MAX_JOB_AGE_MS } from './print.service';

/**
 * The print helper (ADR 0029): a small program on the counter computer. It finds the printers installed
 * there, asks this server for waiting print jobs, prints them and reports back. Jobs stay in print_jobs,
 * so order, retries and "never twice for the same bill" work exactly as for a LAN printer.
 */

/** A helper counts as online if it called in within this long (it polls every two seconds). */
export const ONLINE_MS = 90_000;

export interface AgentPrinterSeen {
  name: string;
  isDefault?: boolean | undefined;
}

export interface AgentPrincipal {
  id: string;
  branchId: string;
  name: string;
}

/** The key is "<agent id>.<secret>"; only the secret's hash is stored. */
export async function authenticateAgent(
  ctx: AppContext,
  key: string | undefined,
): Promise<AgentPrincipal> {
  const bad = (): AppError =>
    new AppError(
      401,
      'UNAUTHENTICATED',
      'This print helper is not recognised. Install it again from Admin, Settings.',
    );
  if (!key) throw bad();
  const dot = key.indexOf('.');
  if (dot < 1) throw bad();
  const id = key.slice(0, dot);
  if (!/^[0-9a-f-]{36}$/.test(id)) throw bad();
  const row = await ctx.db
    .selectFrom('print_agents')
    .select(['id', 'branch_id', 'name', 'key_hash', 'revoked_at'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row || row.revoked_at || !secureEquals(row.key_hash, hashSecret(key.slice(dot + 1))))
    throw bad();
  return { id: row.id, branchId: row.branch_id, name: row.name };
}

export async function createAgent(
  ctx: AppContext,
  a: { branchId: string; userId: string },
  name: string,
): Promise<{ id: string; key: string }> {
  const secret = randomSecret();
  const row = await ctx.db
    .insertInto('print_agents')
    .values({ branch_id: a.branchId, name, key_hash: hashSecret(secret) })
    .returning('id')
    .executeTakeFirstOrThrow();
  await writeAudit(ctx.db, {
    branchId: a.branchId,
    userId: a.userId,
    action: 'PRINT_AGENT_CREATE',
    entity: 'print_agent',
    entityId: row.id,
    after: { name },
  });
  return { id: row.id, key: `${row.id}.${secret}` }; // shown once
}

export async function listAgents(ctx: AppContext, branchId: string) {
  const agents = await ctx.db
    .selectFrom('print_agents')
    .selectAll()
    .where('branch_id', '=', branchId)
    .where('revoked_at', 'is', null)
    .orderBy('created_at')
    .execute();
  if (agents.length === 0) return [];
  const printers = await ctx.db
    .selectFrom('printers')
    .select(['id', 'agent_id', 'kind', 'agent_printer', 'is_active', 'last_error', 'last_ok_at'])
    .where(
      'agent_id',
      'in',
      agents.map((x) => x.id),
    )
    .where('archived_at', 'is', null)
    .execute();
  const queued = await ctx.db
    .selectFrom('print_jobs')
    .innerJoin('printers', 'printers.id', 'print_jobs.printer_id')
    .select(['printers.agent_id as agent_id', (eb) => eb.fn.countAll<string>().as('n')])
    .where(
      'printers.agent_id',
      'in',
      agents.map((x) => x.id),
    )
    .where('print_jobs.status', 'in', ['PENDING', 'FAILED', 'IN_FLIGHT'])
    .groupBy('printers.agent_id')
    .execute();
  const now = ctx.clock.now().getTime();
  return agents.map((x) => ({
    id: x.id,
    name: x.name,
    computer: x.computer,
    lastSeenAt: x.last_seen_at,
    online: !!x.last_seen_at && now - x.last_seen_at.getTime() < ONLINE_MS,
    printersSeen: x.printers_seen as unknown as AgentPrinterSeen[],
    printers: printers
      .filter((p) => p.agent_id === x.id)
      .map((p) => ({
        id: p.id,
        kind: p.kind,
        windowsName: p.agent_printer,
        lastError: p.last_error,
        lastOkAt: p.last_ok_at,
      })),
    queued: Number(queued.find((q) => q.agent_id === x.id)?.n ?? 0),
  }));
}

export async function revokeAgent(
  ctx: AppContext,
  a: { branchId: string; userId: string },
  id: string,
): Promise<void> {
  const res = await ctx.db
    .updateTable('print_agents')
    .set({ revoked_at: ctx.clock.now() })
    .where('id', '=', id)
    .where('branch_id', '=', a.branchId)
    .where('revoked_at', 'is', null)
    .returning('id')
    .executeTakeFirst();
  if (!res) throw new AppError(404, 'NOT_FOUND', 'print helper not found');
  // its printers are switched off (their old jobs stay in the history)
  await ctx.db
    .updateTable('printers')
    .set({ is_active: false, archived_at: ctx.clock.now() })
    .where('agent_id', '=', id)
    .execute();
  await writeAudit(ctx.db, {
    branchId: a.branchId,
    userId: a.userId,
    action: 'PRINT_AGENT_REVOKE',
    entity: 'print_agent',
    entityId: id,
    after: null,
  });
}

/** Which of the helper's printers prints receipts and kitchen tickets (both use the same one unless changed). */
export async function setAgentPrinter(
  ctx: AppContext,
  a: { branchId: string; userId: string },
  id: string,
  windowsName: string,
): Promise<void> {
  const agent = await ctx.db
    .selectFrom('print_agents')
    .select('id')
    .where('id', '=', id)
    .where('branch_id', '=', a.branchId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  if (!agent) throw new AppError(404, 'NOT_FOUND', 'print helper not found');
  await ctx.db
    .updateTable('printers')
    .set({ agent_printer: windowsName })
    .where('agent_id', '=', id)
    .execute();
  await writeAudit(ctx.db, {
    branchId: a.branchId,
    userId: a.userId,
    action: 'PRINT_AGENT_PRINTER',
    entity: 'print_agent',
    entityId: id,
    after: { windowsName },
  });
}

/**
 * The helper says hello: which computer it runs on and which printers it found. The first time, the
 * server makes the two printers it needs (receipts and kitchen tickets) on the printer the helper chose,
 * so nobody configures anything.
 */
export async function agentHello(
  ctx: AppContext,
  agent: AgentPrincipal,
  input: {
    computer?: string | undefined;
    printers: AgentPrinterSeen[];
    chosen?: string | undefined;
  },
) {
  const now = ctx.clock.now();
  await ctx.db
    .updateTable('print_agents')
    .set({
      last_seen_at: now,
      computer: input.computer ?? null,
      printers_seen: JSON.stringify(input.printers) as never,
    })
    .where('id', '=', agent.id)
    .execute();

  let rows = await ctx.db
    .selectFrom('printers')
    .select(['id', 'kind', 'agent_printer'])
    .where('agent_id', '=', agent.id)
    .where('archived_at', 'is', null)
    .execute();
  const pick =
    input.chosen ?? input.printers.find((p) => p.isDefault)?.name ?? input.printers[0]?.name;
  if (rows.length === 0 && pick) {
    for (const kind of ['RECEIPT', 'KOT'] as const) {
      await ctx.db
        .insertInto('printers')
        .values({
          branch_id: agent.branchId,
          name: `${pick} (${kind === 'RECEIPT' ? 'receipts' : 'kitchen'})`,
          kind,
          conn_type: 'AGENT',
          paper_mm: 80,
          agent_id: agent.id,
          agent_printer: pick,
        })
        .execute();
    }
    rows = await ctx.db
      .selectFrom('printers')
      .select(['id', 'kind', 'agent_printer'])
      .where('agent_id', '=', agent.id)
      .where('archived_at', 'is', null)
      .execute();
  }
  return {
    agent: agent.name,
    printers: rows.map((r) => ({ kind: r.kind, windowsName: r.agent_printer })),
  };
}

export interface ClaimedJob {
  id: string;
  title: string;
  kind: string;
  printer: string;
  attempts: number;
  payloadBase64: string;
}

/** Hands the helper the next job of each of its printers (strictly in order: the next one waits for the result). */
export async function claimAgentJobs(
  ctx: AppContext,
  agent: AgentPrincipal,
): Promise<ClaimedJob[]> {
  const now = ctx.clock.now();
  await ctx.db
    .updateTable('print_agents')
    .set({ last_seen_at: now })
    .where('id', '=', agent.id)
    .execute();
  // a job the helper took and never answered (computer switched off mid-print) is offered again after its lease
  await ctx.db
    .updateTable('print_jobs')
    .set({ status: 'PENDING', lease_until: null })
    .where('status', '=', 'IN_FLIGHT')
    .where('lease_until', '<', now)
    .where(
      'printer_id',
      'in',
      ctx.db.selectFrom('printers').select('id').where('agent_id', '=', agent.id),
    )
    .execute();

  const printers = await ctx.db
    .selectFrom('printers')
    .select(['id', 'agent_printer'])
    .where('agent_id', '=', agent.id)
    .where('is_active', '=', true)
    .where('archived_at', 'is', null)
    .execute();
  const out: ClaimedJob[] = [];
  for (const p of printers) {
    const claimed = await claimHead(ctx, p.id, now);
    if (!claimed) continue;
    out.push({
      id: claimed.job.id,
      title: claimed.job.title,
      kind: claimed.job.kind,
      printer: p.agent_printer ?? '',
      attempts: claimed.job.attempts,
      payloadBase64: Buffer.from(claimed.job.payload).toString('base64'),
    });
  }
  return out;
}

/** The helper's answer for one job: printed, or it failed (then it is retried with a growing pause, or parked if too old). */
export async function agentJobResult(
  ctx: AppContext,
  agent: AgentPrincipal,
  jobId: string,
  result: { ok: boolean; error?: string | undefined },
): Promise<void> {
  const job = await ctx.db
    .selectFrom('print_jobs')
    .innerJoin('printers', 'printers.id', 'print_jobs.printer_id')
    .select([
      'print_jobs.id as id',
      'print_jobs.status as status',
      'print_jobs.attempts as attempts',
      'print_jobs.created_at as created_at',
      'printers.id as printer_id',
    ])
    .where('print_jobs.id', '=', jobId)
    .where('printers.agent_id', '=', agent.id)
    .executeTakeFirst();
  if (!job) throw new AppError(404, 'NOT_FOUND', 'print job not found');
  if (job.status === 'DONE' || job.status === 'DEAD') return; // a repeated answer changes nothing
  const at = ctx.clock.now();
  if (result.ok) {
    await ctx.db
      .updateTable('print_jobs')
      .set({ status: 'DONE', printed_at: at, lease_until: null, last_error: null })
      .where('id', '=', jobId)
      .execute();
    await ctx.db
      .updateTable('printers')
      .set({ last_ok_at: at, last_error: null })
      .where('id', '=', job.printer_id)
      .execute();
    return;
  }
  const error = (result.error ?? 'the helper could not print').slice(0, 300);
  const tooOld = at.getTime() - job.created_at.getTime() > MAX_JOB_AGE_MS;
  await ctx.db
    .updateTable('print_jobs')
    .set(
      tooOld
        ? {
            status: 'DEAD',
            lease_until: null,
            last_error: `gave up after ${Math.round(MAX_JOB_AGE_MS / 60_000)} min: ${error}`,
          }
        : {
            status: 'FAILED',
            lease_until: null,
            last_error: error,
            next_attempt_at: new Date(at.getTime() + backoffMs(job.attempts)),
          },
    )
    .where('id', '=', jobId)
    .execute();
  await ctx.db
    .updateTable('printers')
    .set({ last_error: error, last_error_at: at })
    .where('id', '=', job.printer_id)
    .execute();
}
