import { loadEnv } from './config/env';
import { createApp } from './http/app';
import { createDb, createPool } from './shared/db';
import { createLogger } from './shared/logger';

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const pool = createPool(env.DATABASE_URL);
const db = createDb(pool);

const server = createApp({ db, logger }).listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'api listening');
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  server.close();
  await db.destroy();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
