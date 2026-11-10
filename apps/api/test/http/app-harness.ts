import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { pino } from 'pino';
import request from 'supertest';
import type { Express } from 'express';
import '../../src/shared/db'; // registers the BIGINT → number parser, exactly as in production
import type { DB } from '../../src/db/types';
import { createApp } from '../../src/http/app';
import type { AppContext } from '../../src/http/context';
import { createHasher } from '../../src/modules/auth/password';
import { PermissionCache } from '../../src/modules/auth/permissions-cache';
import type { Clock } from '../../src/shared/clock';
import { startDb, type TestDb } from '../db/harness';

export class MutableClock implements Clock {
  constructor(private t = new Date('2026-08-01T10:00:00Z')) {}
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t = new Date(this.t.getTime() + ms);
  }
}

export const ROLES = [
  'OWNER',
  'MANAGER',
  'CASHIER',
  'CAPTAIN',
  'KITCHEN',
  'STORE',
  'ACCOUNTANT',
] as const;
export type RoleCode = (typeof ROLES)[number];

export const PASSWORD = 'Passw0rd!x';
export const PIN = '4321';
export const ACCESS_TTL = 15 * 60;
export const REFRESH_TTL = 12 * 60 * 60;

export interface TestApp {
  app: Express;
  ctx: AppContext;
  tdb: TestDb;
  kdb: Kysely<DB>;
  clock: MutableClock;
  branchId: string;
  otherBranchId: string;
  /** username for each role: `<role>` in branch 1 (OWNER is owner-level, no branch). */
  username: (role: RoleCode) => string;
  roleId: (code: string) => Promise<string>;
  /** Logs in with the password and returns the bearer token + refresh token. */
  login: (role: RoleCode | string) => Promise<{ token: string; refreshToken: string }>;
  /** Authorised request helper; owner-level users automatically send x-branch-id. */
  as: (
    token: string,
    branchId?: string,
  ) => {
    get: (url: string) => request.Test;
    post: (url: string, body?: object) => request.Test;
    patch: (url: string, body?: object) => request.Test;
    put: (url: string, body?: object) => request.Test;
    delete: (url: string) => request.Test;
  };
  stop: () => Promise<void>;
}

export async function startApp(): Promise<TestApp> {
  const tdb = await startDb(['core']);
  const kdb = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: tdb.url, max: 6 }) }),
  });
  const clock = new MutableClock();
  const ctx: AppContext = {
    db: kdb,
    logger: pino({ level: 'silent' }),
    clock,
    hasher: createHasher({ memoryCost: 1024, timeCost: 1 }), // cheap argon2 for tests only
    permissions: new PermissionCache(kdb, clock),
    auth: {
      jwtSecret: 'test-secret-test-secret-test-secret-123',
      accessTtlSeconds: ACCESS_TTL,
      refreshTtlSeconds: REFRESH_TTL,
    },
  };
  const app = createApp(ctx);

  const mkBranch = async (code: string) =>
    (
      await kdb
        .insertInto('branches')
        .values({ code, name: code })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  const branchId = await mkBranch('B1');
  const otherBranchId = await mkBranch('B2');

  const passwordHash = await ctx.hasher.hash(PASSWORD);
  const pinHash = await ctx.hasher.hash(PIN);
  const roleRows = await kdb.selectFrom('roles').select(['id', 'code']).execute();
  const roleIdSync = (code: string): string => roleRows.find((r) => r.code === code)!.id;

  for (const role of ROLES) {
    await kdb
      .insertInto('users')
      .values({
        branch_id: role === 'OWNER' ? null : branchId,
        role_id: roleIdSync(role),
        username: role.toLowerCase(),
        full_name: role,
        password_hash: passwordHash,
        pin_hash: pinHash,
      })
      .execute();
  }
  // A manager of the *other* branch, for scoping tests.
  await kdb
    .insertInto('users')
    .values({
      branch_id: otherBranchId,
      role_id: roleIdSync('MANAGER'),
      username: 'manager2',
      full_name: 'Manager 2',
      password_hash: passwordHash,
      pin_hash: pinHash,
    })
    .execute();

  const login: TestApp['login'] = async (role) => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: role.toLowerCase(), password: PASSWORD });
    if (res.status !== 200)
      throw new Error(`login(${role}) failed: ${res.status} ${JSON.stringify(res.body)}`);
    return { token: res.body.accessToken as string, refreshToken: res.body.refreshToken as string };
  };

  const as: TestApp['as'] = (token, forBranch) => {
    const withAuth = (t: request.Test): request.Test => {
      t.set('Authorization', `Bearer ${token}`);
      t.set('x-branch-id', forBranch ?? branchId); // ignored for branch-bound users
      return t;
    };
    return {
      get: (url) => withAuth(request(app).get(`/api/v1${url}`)),
      post: (url, body = {}) => withAuth(request(app).post(`/api/v1${url}`)).send(body),
      patch: (url, body = {}) => withAuth(request(app).patch(`/api/v1${url}`)).send(body),
      put: (url, body = {}) => withAuth(request(app).put(`/api/v1${url}`)).send(body),
      delete: (url) => withAuth(request(app).delete(`/api/v1${url}`)),
    };
  };

  return {
    app,
    ctx,
    tdb,
    kdb,
    clock,
    branchId,
    otherBranchId,
    username: (role) => role.toLowerCase(),
    roleId: async (code) => roleIdSync(code),
    login,
    as,
    stop: async () => {
      await kdb.destroy();
      await tdb.stop();
    },
  };
}
