import { loadEnv } from './config/env';
import { buildContext } from './http/build-context';
import { createApp } from './http/app';
import { TcpTransport } from './modules/printing/print.service';
import { startFiscalWorker } from './modules/fiscal/fiscal.worker';
import { startPrintWorker } from './modules/printing/print.worker';
import { createLogger } from './shared/logger';

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const ctx = buildContext(env, logger);

if (env.NODE_ENV === 'production' && env.JWT_SECRET.startsWith('dev-only')) {
  throw new Error('Refusing to start in production with the dev JWT_SECRET');
}

// In development one process does everything. In production the separate `worker` service
// (ops/docker-compose.yml) runs the queue, so the API does not.
const embeddedWorker = (env.EMBEDDED_WORKER ?? String(env.NODE_ENV !== 'production')) === 'true';
const stopPrint = embeddedWorker ? startPrintWorker(ctx, new TcpTransport()) : null;
const stopFiscal = embeddedWorker ? startFiscalWorker(ctx) : null;

const server = createApp(ctx).listen(env.PORT, () => {
  logger.info({ port: env.PORT, embeddedWorker }, 'api listening');
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  server.close();
  await stopPrint?.();
  await stopFiscal?.();
  await ctx.db.destroy();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
