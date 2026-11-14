import type { ServerResponse } from 'node:http';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Router } from 'express';
import { Router as makeRouter } from 'express';
import type { AppContext } from './context';
import { authenticate, resolveBranch } from '../modules/auth/middleware';

/**
 * Live updates over Server-Sent Events. The server only says *that something changed* (a topic, no
 * data): clients refetch through the normal API, so permissions and branch scoping stay in one place
 * and nothing sensitive travels on the stream. Events are published after a successful write request.
 * One API process serves a restaurant, so an in-process hub is enough (see ADR 0011).
 */

export type Topic = 'orders' | 'day' | 'khata' | 'menu' | 'printers' | 'misc';

export class EventHub {
  private readonly clients = new Map<string, Set<ServerResponse>>();

  add(branchId: string, res: ServerResponse): () => void {
    let set = this.clients.get(branchId);
    if (!set) this.clients.set(branchId, (set = new Set()));
    set.add(res);
    return () => {
      set.delete(res);
      if (set.size === 0) this.clients.delete(branchId);
    };
  }

  publish(branchId: string, topic: Topic): void {
    const set = this.clients.get(branchId);
    if (!set) return;
    const frame = `event: change\ndata: ${JSON.stringify({ topic })}\n\n`;
    for (const res of set) res.write(frame);
  }

  count(branchId?: string): number {
    if (branchId) return this.clients.get(branchId)?.size ?? 0;
    return [...this.clients.values()].reduce((n, s) => n + s.size, 0);
  }
}

export const hub = new EventHub();

/** Which part of the screen a write touches (first path segment of the request). */
export function topicOf(path: string): Topic {
  const seg = path.split('/').filter(Boolean)[0] ?? '';
  if (['orders', 'bills', 'floor'].includes(seg)) return 'orders';
  if (['shifts', 'business-days', 'cash-movements', 'drawer', 'reports'].includes(seg))
    return 'day';
  if (seg === 'khata') return 'khata';
  if (
    ['menu', 'items', 'categories', 'variants', 'modifier-groups', 'modifiers', 'deals'].includes(
      seg,
    )
  )
    return 'menu';
  if (['printers', 'print-jobs', 'kots', 'stations'].includes(seg)) return 'printers';
  return 'misc';
}

/** After a successful write, tell this branch's screens to refresh. */
export const notifyOnWrite: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    res.on('finish', () => {
      if (res.statusCode < 400 && req.branchId) hub.publish(req.branchId, topicOf(req.path));
    });
  }
  next();
};

export function eventsRouter(ctx: AppContext, heartbeatMs = 20_000, enabled = true): Router {
  const r = makeRouter();
  if (!enabled) {
    // the screens read this as "poll instead" and stop retrying the stream
    r.get('/events', (_req, res) => {
      res.status(501).type('application/problem+json').json({
        type: 'urn:erp:error:LIVE_DISABLED',
        title: 'Live updates are off on this server; screens refresh on a timer',
        status: 501,
        code: 'LIVE_DISABLED',
      });
    });
    return r;
  }
  r.get('/events', authenticate(ctx), resolveBranch(ctx), (req, res) => {
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    res.write('event: ready\ndata: {}\n\n');
    const remove = hub.add(req.branchId!, res);
    const beat = setInterval(() => res.write(': keep-alive\n\n'), heartbeatMs);
    req.on('close', () => {
      clearInterval(beat);
      remove();
    });
  });
  return r;
}
