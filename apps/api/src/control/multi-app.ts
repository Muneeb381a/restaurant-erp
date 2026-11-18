import { randomUUID } from 'node:crypto';
import express, { Router, type Express } from 'express';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Logger } from 'pino';
import { asyncHandler } from '../http/async-handler';
import { errorHandler, notFound } from '../http/errors';
import { captureServerErrors } from './error-log';
import { platformRouter } from './platform.routes';
import type { PlatformDeps } from './platform.service';
import type { TenantRegistry } from './registry';
import type { ControlDB } from './types';

/**
 * Cloud mode. One API serves the platform admin and every restaurant:
 *
 *   /api/v1/platform/…          the platform admin (restaurants, owners, switching off)
 *   /api/v1/public/tenants/:c   is this restaurant code real, and what is it called?
 *   /api/v1/r/<code>/…          that restaurant's own API, exactly as in single-restaurant mode
 *
 * The restaurant routes are not re-implemented here: the request is handed, with the prefix cut off,
 * to that restaurant's ordinary API instance, which talks only to that restaurant's database.
 */
export function createMultiTenantApp(deps: {
  control: Kysely<ControlDB>;
  registry: TenantRegistry;
  platform: PlatformDeps;
  logger: Logger;
  /** Proxies in front of the API (default 1: Vercel or any single reverse proxy). */
  trustProxyHops?: number;
}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', deps.trustProxyHops ?? 1);
  app.use((req, res, next) => {
    const inbound = req.header('x-request-id');
    req.id = inbound && inbound.length <= 100 ? inbound : randomUUID();
    req.log = deps.logger.child({ reqId: req.id });
    res.setHeader('x-request-id', req.id);
    next();
  });

  // every 5xx (any restaurant or the platform) is noted for the platform admin
  app.use(captureServerErrors(deps.control, deps.logger));

  app.get('/health', async (req, res) => {
    try {
      await sql`select 1`.execute(deps.control);
      res.json({ status: 'ok', mode: 'cloud', checks: { control: 'ok' } });
    } catch (err) {
      req.log.error({ err }, 'health: control database check failed');
      res.status(503).json({ status: 'degraded', mode: 'cloud', checks: { control: 'down' } });
    }
  });

  const v1 = Router();
  // only the platform routes read a JSON body here; a restaurant's own API parses its requests itself
  v1.use(['/platform', '/public'], express.json({ limit: '100kb' }));
  v1.use(platformRouter(deps.platform));
  v1.use(
    '/r/:slug',
    asyncHandler(async (req, res, next) => {
      const rt = await deps.registry.get(String(req.params.slug));
      // a restaurant's API lives under /api/v1; its health check at /health
      req.url = req.url === '/health' ? '/health' : `/api/v1${req.url === '/' ? '' : req.url}`;
      rt.app(req, res, next);
    }),
  );
  app.use('/api/v1', v1);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
