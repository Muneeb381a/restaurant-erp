import { randomUUID } from 'node:crypto';
import express, { Router, type Express } from 'express';
import { sql } from 'kysely';
import { branchRouter } from '../modules/admin/branch.routes';
import { configRouters, stationPrintersRouter } from '../modules/admin/config.routes';
import { devicesRouter } from '../modules/admin/devices.routes';
import { rolesRouter } from '../modules/admin/roles.routes';
import { usersRouter } from '../modules/admin/users.routes';
import { auditRouter } from '../modules/audit/audit.routes';
import { authRouter } from '../modules/auth/auth.routes';
import type { AppContext } from './context';
import { errorHandler, notFound } from './errors';

export function createApp(ctx: AppContext): Express {
  const { db, logger } = ctx;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // Request id (honour inbound header for tracing across proxy) + child logger.
  app.use((req, res, next) => {
    const inbound = req.header('x-request-id');
    req.id = inbound && inbound.length <= 100 ? inbound : randomUUID();
    req.log = logger.child({ reqId: req.id });
    res.setHeader('x-request-id', req.id);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      req.log.info({ method: req.method, url: req.originalUrl, status: res.statusCode, ms }, 'req');
    });
    next();
  });

  app.get('/health', async (req, res) => {
    try {
      await sql`select 1`.execute(db);
      res.json({ status: 'ok', checks: { db: 'ok' } });
    } catch (err) {
      req.log.error({ err }, 'health: db check failed');
      res.status(503).json({ status: 'degraded', checks: { db: 'down' } });
    }
  });

  const v1 = Router();
  v1.use('/auth', authRouter(ctx));
  v1.use('/audit-log', auditRouter(ctx));
  v1.use('/users', usersRouter(ctx));
  v1.use('/devices', devicesRouter(ctx));
  v1.use('/stations', stationPrintersRouter(ctx)); // before CRUD: owns /:id/printers
  for (const [path, router] of Object.entries(configRouters(ctx))) v1.use(path, router);
  v1.use('/', rolesRouter(ctx)); // /roles, /permissions
  v1.use('/', branchRouter(ctx)); // /branch, /settings
  app.use('/api/v1', v1);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
