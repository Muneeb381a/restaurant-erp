import { isCloudMode, loadEnv } from './config/env';
import { buildCloudApp } from './control/boot';
import { buildContext } from './http/build-context';
import { createApp } from './http/app';
import { TcpTransport } from './modules/printing/print.service';
import { startFiscalWorker } from './modules/fiscal/fiscal.worker';
import { startPrintWorker } from './modules/printing/print.worker';
import { createLogger } from './shared/logger';

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);

if (isCloudMode(env)) {
  // Cloud mode: many restaurants, each with its own database (docs/adr/0019-multi-restaurant-cloud.md).
  // The print and fiscal workers belong to a restaurant's own install and do not run here.
  const cloud = buildCloudApp(env, logger);
  const server = cloud.app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, mode: 'cloud' }, 'api listening');
  });
  const stop = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    server.close();
    await cloud.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
} else {
  const ctx = buildContext(env, logger);

  if (env.NODE_ENV === 'production' && env.JWT_SECRET.startsWith('dev-only')) {
    throw new Error('Refusing to start in production with the dev JWT_SECRET');
  }

  // In development one process does everything. In production the separate `worker` service
  // (ops/docker-compose.yml) runs the queue, so the API does not.
  const embeddedWorker = (env.EMBEDDED_WORKER ?? String(env.NODE_ENV !== 'production')) === 'true';
  const stopPrint = embeddedWorker ? startPrintWorker(ctx, new TcpTransport()) : null;
  const stopFiscal = embeddedWorker ? startFiscalWorker(ctx) : null;

  const server = createApp(ctx, {
    liveEvents: env.LIVE_EVENTS !== 'off',
    trustProxyHops: env.TRUST_PROXY_HOPS ?? 0,
  }).listen(env.PORT, () => {
    logger.info({ port: env.PORT, embeddedWorker }, 'api listening');
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    server.close();
    await stopPrint?.();
    await stopFiscal?.();
    await ctx.db.destroy();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
