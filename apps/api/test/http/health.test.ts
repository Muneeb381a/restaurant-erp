import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DB } from '../../src/db/types';
import { createApp } from '../../src/http/app';
import { startDb, type TestDb } from '../db/harness';

let tdb: TestDb;
let kdb: Kysely<DB>;
const logger = pino({ level: 'silent' });

beforeAll(async () => {
  tdb = await startDb(['core']);
  kdb = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: tdb.url }) }),
  });
}, 180_000);

afterAll(async () => {
  await kdb.destroy();
  await tdb.stop();
});

describe('GET /health', () => {
  it('is ok when the database answers, and echoes a request id', async () => {
    const res = await request(createApp({ db: kdb, logger }))
      .get('/health')
      .set('x-request-id', 'abc-123');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', checks: { db: 'ok' } });
    expect(res.headers['x-request-id']).toBe('abc-123');
  });

  it('is 503 when the database is down', async () => {
    const dead = new Kysely<DB>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({
          connectionString: 'postgres://x:y@127.0.0.1:1/none',
          connectionTimeoutMillis: 500,
        }),
      }),
    });
    const res = await request(createApp({ db: dead, logger })).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    await dead.destroy();
  });
});

describe('error model', () => {
  it('returns RFC 7807 problem+json with a stable code for unknown routes', async () => {
    const res = await request(createApp({ db: kdb, logger })).get('/nope');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(res.body.requestId).toBeTruthy();
  });
});
