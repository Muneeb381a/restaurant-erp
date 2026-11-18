import type { NextFunction, Request, Response } from 'express';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Logger } from 'pino';
import type { ControlDB } from './types';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * What is safe to keep about a failed request's address: the path with the restaurant code kept (it
 * says where) and every id, number and long token replaced by `:id`; the query string is dropped.
 * `/api/v1/r/acme/orders/6f1c…/items/42?x=1` → `/r/acme/orders/:id/items/:id`.
 */
export function routeShape(url: string): string {
  const path = (url.split('?')[0] ?? '').replace(/^\/api\/v1/, '');
  const shaped = path
    .replace(UUID, ':id')
    .split('/')
    .map((seg, n, all) => {
      if (all[n - 1] === 'r' && all[0] === '' && n === 2) return seg; // the restaurant code
      return /^\d+$/.test(seg) || seg.length > 40 ? ':id' : seg;
    })
    .join('/');
  return shaped.slice(0, 200) || '/';
}

/** The restaurant code in a cloud address, if any. */
export const slugOf = (url: string): string | null =>
  /^\/api\/v1\/r\/([a-z0-9-]+)(?:[/?]|$)/.exec(url)?.[1] ?? null;

export interface ErrorEvent {
  slug: string | null;
  status: number;
  code: string | null;
  method: string;
  route: string;
  requestId: string | null;
}

export async function recordError(db: Kysely<ControlDB>, e: ErrorEvent): Promise<void> {
  await db
    .insertInto('error_events')
    .values({
      tenant_id: e.slug ? sql<string>`(select id from tenants where slug = ${e.slug})` : null,
      status: e.status,
      code: e.code,
      method: e.method.slice(0, 10),
      route: e.route,
      request_id: e.requestId,
    })
    .execute();
  // keep the table small: a purge on roughly 1 in 50 failures is plenty
  if (Math.random() < 0.02)
    await sql`delete from error_events where at < now() - interval '30 days'`.execute(db);
}

/**
 * Records every 5xx answer in the control database. The record is written BEFORE the response is
 * finished (bounded to one second), because a serverless function may be frozen the moment it answers.
 * Recording can never fail the request: any problem is logged and ignored.
 */
export function captureServerErrors(db: Kysely<ControlDB>, logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const end = res.end.bind(res) as (...a: unknown[]) => Response;
    (res as { end: unknown }).end = (...args: unknown[]): Response => {
      if (res.statusCode < 500 || res.locals.errorRecorded) return end(...args);
      res.locals.errorRecorded = true;
      const code = typeof res.locals.errorCode === 'string' ? res.locals.errorCode : null;
      const write = recordError(db, {
        slug: slugOf(req.originalUrl),
        status: res.statusCode,
        code,
        method: req.method,
        route: routeShape(req.originalUrl),
        requestId: req.id ?? null,
      }).catch((err: unknown) => logger.warn({ err }, 'could not record the server error'));
      void Promise.race([write, new Promise((r) => setTimeout(r, 1000))]).then(() => end(...args));
      return res;
    };
    next();
  };
}

export interface RecentError {
  id: string;
  at: Date;
  slug: string | null;
  status: number;
  code: string | null;
  method: string;
  route: string;
  requestId: string | null;
}

export async function recentErrors(
  db: Kysely<ControlDB>,
  opts: { tenantId?: string; hours?: number; limit?: number },
): Promise<RecentError[]> {
  let q = db
    .selectFrom('error_events as e')
    .leftJoin('tenants as t', 't.id', 'e.tenant_id')
    .select(['e.id', 'e.at', 't.slug', 'e.status', 'e.code', 'e.method', 'e.route', 'e.request_id'])
    .where('e.at', '>', sql<Date>`now() - make_interval(hours => ${opts.hours ?? 24})`)
    .orderBy('e.at', 'desc')
    .limit(Math.min(opts.limit ?? 100, 500));
  if (opts.tenantId) q = q.where('e.tenant_id', '=', opts.tenantId);
  const rows = await q.execute();
  return rows.map((r) => ({
    id: String(r.id),
    at: r.at,
    slug: r.slug,
    status: r.status,
    code: r.code,
    method: r.method,
    route: r.route,
    requestId: r.request_id,
  }));
}

/** Failures in the last `hours`, per restaurant (tenant id → count). */
export async function errorCounts(db: Kysely<ControlDB>, hours = 24): Promise<Map<string, number>> {
  const rows = await db
    .selectFrom('error_events')
    .select(['tenant_id', sql<string>`count(*)`.as('n')])
    .where('at', '>', sql<Date>`now() - make_interval(hours => ${hours})`)
    .where('tenant_id', 'is not', null)
    .groupBy('tenant_id')
    .execute();
  return new Map(rows.map((r) => [r.tenant_id as string, Number(r.n)]));
}
