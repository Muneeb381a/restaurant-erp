import { loadEnv } from './config/env';
import { createApp } from './http/app';
import type { AppContext } from './http/context';
import { createHasher } from './modules/auth/password';
import { PermissionCache } from './modules/auth/permissions-cache';
import { systemClock } from './shared/clock';
import { createDb, createPool } from './shared/db';
import { createLogger } from './shared/logger';

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const pool = createPool(env.DATABASE_URL);
const db = createDb(pool);

const ctx: AppContext = {
  db,
  logger,
  clock: systemClock,
  hasher: createHasher(),
  permissions: new PermissionCache(db, systemClock),
  auth: {
    jwtSecret: env.JWT_SECRET,
    accessTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
    refreshTtlSeconds: env.REFRESH_TOKEN_TTL_SECONDS,
  },
};

if (env.NODE_ENV === 'production' && env.JWT_SECRET.startsWith('dev-only')) {
  throw new Error('Refusing to start in production with the dev JWT_SECRET');
}

const server = createApp(ctx).listen(env.PORT, () => {
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
