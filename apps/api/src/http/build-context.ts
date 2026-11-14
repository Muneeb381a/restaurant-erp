import type { Logger } from 'pino';
import type { Env } from '../config/env';
import { createHasher } from '../modules/auth/password';
import { PermissionCache } from '../modules/auth/permissions-cache';
import { MenuCache } from '../modules/menu/menu-cache';
import { systemClock } from '../shared/clock';
import { createDb, createPool } from '../shared/db';
import type { AppContext } from './context';

export interface ContextOverrides {
  /** This restaurant's database (cloud mode builds one context per restaurant). */
  databaseUrl?: string;
  /** This restaurant's own token-signing secret. */
  jwtSecret?: string;
  poolMax?: number;
}

/** The dependencies shared by the API process and the worker process. */
export function buildContext(env: Env, logger: Logger, o: ContextOverrides = {}): AppContext {
  const databaseUrl = o.databaseUrl ?? env.DATABASE_URL;
  if (!databaseUrl)
    throw new Error('No database URL: set DATABASE_URL or build a restaurant context');
  const db = createDb(createPool(databaseUrl, o.poolMax));
  return {
    db,
    logger,
    clock: systemClock,
    hasher: createHasher(),
    permissions: new PermissionCache(db, systemClock),
    menu: new MenuCache(),
    auth: {
      jwtSecret: o.jwtSecret ?? env.JWT_SECRET,
      accessTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
      refreshTtlSeconds: env.REFRESH_TOKEN_TTL_SECONDS,
    },
  };
}
