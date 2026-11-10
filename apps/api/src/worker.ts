import { loadEnv } from './config/env';
import { buildContext } from './http/build-context';
import { TcpTransport } from './modules/printing/print.service';
import { startFiscalWorker } from './modules/fiscal/fiscal.worker';
import { startPrintWorker } from './modules/printing/print.worker';
import { createLogger } from './shared/logger';

// Outbox worker. Today it drains the print queue; fiscal submissions (M7) and WhatsApp
// summaries (Phase 2) join the same process.
const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const ctx = buildContext(env, logger);
const stopPrint = startPrintWorker(ctx, new TcpTransport());
const stopFiscal = startFiscalWorker(ctx);
logger.info('worker started: print queue, fiscal queue');

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'worker shutting down');
  await stopPrint();
  await stopFiscal();
  await ctx.db.destroy();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
