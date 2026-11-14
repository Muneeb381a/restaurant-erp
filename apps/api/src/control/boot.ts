import type { Express } from 'express';
import { Kysely, PostgresDialect } from 'kysely';
import type { Logger } from 'pino';
import type { Env } from '../config/env';
import { createHasher } from '../modules/auth/password';
import { createPool } from '../shared/db';
import { createMultiTenantApp } from './multi-app';
import { createLocalProvisioner, createNeonProvisioner, type Provisioner } from './provisioner';
import type { PlatformDeps } from './platform.service';
import { TenantRegistry } from './registry';
import { createSecretBox } from './secret-box';
import type { ControlDB } from './types';

export function createControlDb(url: string, poolMax = 3): Kysely<ControlDB> {
  return new Kysely<ControlDB>({
    dialect: new PostgresDialect({ pool: createPool(url, poolMax) }),
  });
}

export function provisionerFromEnv(env: Env): Provisioner {
  if (env.PROVISIONER === 'neon')
    return createNeonProvisioner({
      apiKey: env.NEON_API_KEY!,
      regionId: env.NEON_REGION_ID!,
      ...(env.NEON_ORG_ID ? { orgId: env.NEON_ORG_ID } : {}),
      ...(env.NEON_PG_VERSION ? { pgVersion: env.NEON_PG_VERSION } : {}),
    });
  return createLocalProvisioner(env.LOCAL_PROVISIONER_ADMIN_URL!);
}

export interface CloudApp {
  app: Express;
  platform: PlatformDeps;
  registry: TenantRegistry;
  close: () => Promise<void>;
}

/** Everything cloud mode needs, from the environment. Used by the long-running server and the Vercel function alike. */
export function buildCloudApp(env: Env, logger: Logger): CloudApp {
  if (!env.CONTROL_DATABASE_URL) throw new Error('CONTROL_DATABASE_URL is not set');
  if (env.NODE_ENV === 'production' && env.JWT_SECRET.startsWith('dev-only'))
    throw new Error('Refusing to start in production with the dev JWT_SECRET');
  const control = createControlDb(env.CONTROL_DATABASE_URL);
  const box = createSecretBox(env.TENANT_SECRET_KEY!);
  const registry = new TenantRegistry({
    control,
    box,
    env,
    logger,
    masterJwtSecret: env.JWT_SECRET,
  });
  const platform: PlatformDeps = {
    control,
    registry,
    provisioner: provisionerFromEnv(env),
    box,
    hasher: createHasher(),
    logger,
    platformJwtSecret: env.PLATFORM_JWT_SECRET!,
  };
  return {
    app: createMultiTenantApp({
      control,
      registry,
      platform,
      logger,
      trustProxyHops: env.TRUST_PROXY_HOPS ?? 1,
    }),
    platform,
    registry,
    close: async () => {
      await registry.closeAll();
      await control.destroy();
    },
  };
}
