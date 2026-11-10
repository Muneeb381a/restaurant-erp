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
import { billingRouter } from '../modules/billing/billing.routes';
import { shiftRouter } from '../modules/day/shift.routes';
import { khataRouter } from '../modules/khata/khata.routes';
import { fiscalRouter } from '../modules/fiscal/fiscal.routes';
import { taxRouter } from '../modules/tax/tax.routes';
import { kitchenRouter } from '../modules/kitchen/kitchen.routes';
import { menuRouter } from '../modules/menu/menu.routes';
import { ordersRouter } from '../modules/orders/orders.routes';
import type { AppContext } from './context';
import { errorHandler, notFound } from './errors';
import { eventsRouter, notifyOnWrite } from './events';

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
  v1.use(notifyOnWrite);
  v1.use('/', eventsRouter(ctx)); // GET /events (live change notifications)
  v1.use('/auth', authRouter(ctx));
  v1.use('/audit-log', auditRouter(ctx));
  v1.use('/users', usersRouter(ctx));
  v1.use('/devices', devicesRouter(ctx));
  v1.use('/', kitchenRouter(ctx)); // before the CRUD routers: owns /printers/health
  v1.use('/stations', stationPrintersRouter(ctx)); // before CRUD: owns /:id/printers
  for (const [path, router] of Object.entries(configRouters(ctx))) v1.use(path, router);
  v1.use('/', ordersRouter(ctx)); // /business-days /shifts /floor /orders
  v1.use('/', khataRouter(ctx)); // /khata/accounts…
  v1.use('/', fiscalRouter(ctx)); // /fiscal/summary /fiscal/jobs /fiscal/reconciliation
  v1.use('/', taxRouter(ctx)); // /tax/categories /tax/rules /tax/readiness
  v1.use('/', shiftRouter(ctx)); // shift close/reopen, cash movements, day close, Z-report
  v1.use('/', billingRouter(ctx)); // /orders/:id/bill /bills/…
  v1.use('/', menuRouter(ctx)); // /categories /items /variants /modifier-groups /menu …
  v1.use('/', rolesRouter(ctx)); // /roles, /permissions
  v1.use('/', branchRouter(ctx)); // /branch, /settings
  app.use('/api/v1', v1);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
