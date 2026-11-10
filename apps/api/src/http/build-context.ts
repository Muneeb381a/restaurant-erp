import type { Logger } from 'pino';
import type { Env } from '../config/env';
import { createHasher } from '../modules/auth/password';
import { PermissionCache } from '../modules/auth/permissions-cache';
import { MenuCache } from '../modules/menu/menu-cache';
import { systemClock } from '../shared/clock';
import { createDb, createPool } from '../shared/db';
import type { AppContext } from './context';

/** The dependencies shared by the API process and the worker process. */
export function buildContext(env: Env, logger: Logger): AppContext {
  const db = createDb(createPool(env.DATABASE_URL));
  return {
    db,
    logger,
    clock: systemClock,
    hasher: createHasher(),
    permissions: new PermissionCache(db, systemClock),
    menu: new MenuCache(),
    auth: {
      jwtSecret: env.JWT_SECRET,
      accessTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
      refreshTtlSeconds: env.REFRESH_TOKEN_TTL_SECONDS,
    },
  };
}
