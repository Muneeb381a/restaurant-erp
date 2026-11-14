import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCloudMode, loadEnv } from './config/env';
import { buildCloudApp } from './control/boot';
import { createLogger } from './shared/logger';

/**
 * Entry point of the Vercel function (see scripts/vercel-build.mjs and docs/DEPLOY-VERCEL-NEON.md).
 * It is the same cloud-mode API as `pnpm start`, exported as a request handler instead of listening
 * on a port. The SQL migration folders are copied next to this file at build time.
 */
process.env.ERP_API_ROOT ??= path.dirname(fileURLToPath(import.meta.url));

const env = loadEnv();
if (!isCloudMode(env))
  throw new Error('The Vercel deployment runs in cloud mode: set CONTROL_DATABASE_URL');

const { app } = buildCloudApp(env, createLogger(env.LOG_LEVEL));
export default app;
