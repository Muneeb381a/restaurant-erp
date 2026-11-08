import { randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import { sql, type Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { DB } from '../db/types';
import { errorHandler, notFound } from './errors';

export interface AppDeps {
  db: Kysely<DB>;
  logger: Logger;
}

export function createApp({ db, logger }: AppDeps): Express {
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

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
