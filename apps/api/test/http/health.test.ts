import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DB } from '../../src/db/types';
import { createApp } from '../../src/http/app';
import { startApp, type TestApp } from './app-harness';

let t: TestApp;

beforeAll(async () => {
  t = await startApp();
}, 180_000);

afterAll(async () => {
  await t.stop();
});

describe('GET /health', () => {
  it('is ok when the database answers, and echoes a request id', async () => {
    const res = await request(t.app).get('/health').set('x-request-id', 'abc-123');
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
    const res = await request(createApp({ ...t.ctx, db: dead })).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    await dead.destroy();
  });
});

describe('error model', () => {
  it('returns RFC 7807 problem+json with a stable code for unknown routes', async () => {
    const res = await request(t.app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(res.body.requestId).toBeTruthy();
  });

  it('returns VALIDATION_FAILED for malformed JSON', async () => {
    const res = await request(t.app)
      .post('/api/v1/auth/login')
      .set('content-type', 'application/json')
      .send('{"username": ');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });
});
