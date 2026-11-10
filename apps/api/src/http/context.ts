import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { DB } from '../db/types';
import type { Clock } from '../shared/clock';
import type { PasswordHasher } from '../modules/auth/password';
import type { PermissionCache } from '../modules/auth/permissions-cache';

/** Everything a request handler may depend on. Built once in main.ts (or per test). */
export interface AppContext {
  db: Kysely<DB>;
  logger: Logger;
  clock: Clock;
  hasher: PasswordHasher;
  permissions: PermissionCache;
  auth: {
    jwtSecret: string;
    accessTtlSeconds: number;
    refreshTtlSeconds: number;
  };
}

export interface Principal {
  userId: string;
  username: string;
  fullName: string;
  roleId: string;
  roleCode: string;
  /** NULL = owner-level user not tied to one branch. */
  userBranchId: string | null;
  sessionId: string;
  deviceId: string | null;
  discountLimitBps: number;
}
