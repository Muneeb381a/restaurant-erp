import { loadEnv } from './config/env';
import { createLogger } from './shared/logger';

// Outbox worker (fiscal, print, WhatsApp) is implemented in M4/M7. M0 keeps the process
// alive so the compose stack has a `worker` service with the final shape.
const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
logger.info('worker started (no jobs registered yet)');
setInterval(() => undefined, 60_000);
