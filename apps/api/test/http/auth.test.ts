import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCK_DURATION_MS } from '../../src/modules/auth/lockout';
import { ACCESS_TTL, PASSWORD, PIN, REFRESH_TTL, startApp, type TestApp } from './app-harness';

let t: TestApp;
const post = (url: string, body: object, headers: Record<string, string> = {}) =>
  request(t.app).post(`/api/v1${url}`).set(headers).send(body);

/** Creates a fresh branch user so lockout/session tests never interfere with each other. */
let seq = 0;
async function freshUser(
  role = 'CASHIER',
  opts: { active?: boolean; pin?: boolean } = {},
): Promise<string> {
  const username = `tmp${++seq}`;
  await t.kdb
    .insertInto('users')
    .values({
      branch_id: t.branchId,
      role_id: await t.roleId(role),
      username,
      full_name: username,
      password_hash: await t.ctx.hasher.hash(PASSWORD),
      pin_hash: opts.pin === false ? null : await t.ctx.hasher.hash(PIN),
      is_active: opts.active ?? true,
    })
    .execute();
  return username;
}

beforeAll(async () => {
  t = await startApp();
}, 180_000);
afterAll(async () => {
  await t.stop();
});

describe('login', () => {
  it('password login returns tokens, and /me reflects role + permissions', async () => {
    const res = await post('/auth/login', { username: 'manager', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toMatch(/^[0-9a-f-]{36}\./);
    const me = await t.as(res.body.accessToken).get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ username: 'manager', role: 'MANAGER', branchId: t.branchId });
    expect(me.body.permissions).toContain('bill.refund');
    expect(me.body.permissions).not.toContain('user.manage');
  });

  it('PIN login works, is case-insensitive on username, and validates PIN format', async () => {
    expect((await post('/auth/login-pin', { username: 'CASHIER', pin: PIN })).status).toBe(200);
    const bad = await post('/auth/login-pin', { username: 'cashier', pin: '12' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('VALIDATION_FAILED');
    const letters = await post('/auth/login-pin', { username: 'cashier', pin: 'abcd' });
    expect(letters.status).toBe(400);
  });

  it('a user without a PIN cannot PIN-login (and the error is the generic one)', async () => {
    const u = await freshUser('CASHIER', { pin: false });
    const res = await post('/auth/login-pin', { username: u, pin: '1234' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('wrong password and unknown user are indistinguishable', async () => {
    const wrong = await post('/auth/login', { username: 'cashier', password: 'nope-nope-nope' });
    const unknown = await post('/auth/login', { username: 'ghost', password: 'nope-nope-nope' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
    expect({ ...unknown.body, requestId: 0 }).toEqual({ ...wrong.body, requestId: 0 });
  });

  it('inactive users cannot log in', async () => {
    const u = await freshUser('CASHIER', { active: false });
    const res = await post('/auth/login', { username: u, password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('rejects requests without or with a garbage bearer token', async () => {
    expect((await request(t.app).get('/api/v1/auth/me')).status).toBe(401);
    const res = await request(t.app)
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer not.a.jwt');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });
});

describe('lockout (5 failures / 10 min)', () => {
  it('locks after 5 wrong PINs, even a correct PIN is refused, and unlocks after 10 minutes', async () => {
    const u = await freshUser();
    for (let i = 0; i < 5; i++) {
      const r = await post('/auth/login-pin', { username: u, pin: '9999' });
      expect(r.body.code).toBe('INVALID_CREDENTIALS');
    }
    const locked = await post('/auth/login-pin', { username: u, pin: PIN });
    expect(locked.status).toBe(423);
    expect(locked.body.code).toBe('ACCOUNT_LOCKED');
    expect(locked.body.retryAfterSeconds).toBeGreaterThan(0);

    t.clock.advance(LOCK_DURATION_MS - 1000);
    expect((await post('/auth/login-pin', { username: u, pin: PIN })).status).toBe(423);
    t.clock.advance(2000);
    expect((await post('/auth/login-pin', { username: u, pin: PIN })).status).toBe(200);
  });

  it('a successful login resets the failure counter', async () => {
    const u = await freshUser();
    for (let i = 0; i < 3; i++) await post('/auth/login-pin', { username: u, pin: '9999' });
    expect((await post('/auth/login-pin', { username: u, pin: PIN })).status).toBe(200);
    for (let i = 0; i < 4; i++) await post('/auth/login-pin', { username: u, pin: '9999' });
    expect((await post('/auth/login-pin', { username: u, pin: PIN })).status).toBe(200); // 4 < 5 → not locked
  });

  it('failures older than the window do not accumulate', async () => {
    const u = await freshUser();
    for (let i = 0; i < 4; i++) await post('/auth/login-pin', { username: u, pin: '9999' });
    t.clock.advance(11 * 60_000);
    await post('/auth/login-pin', { username: u, pin: '9999' }); // count restarts at 1
    expect((await post('/auth/login-pin', { username: u, pin: PIN })).status).toBe(200);
  });

  it('password and PIN failures share one counter', async () => {
    const u = await freshUser();
    for (let i = 0; i < 3; i++) await post('/auth/login', { username: u, password: 'wrong-wrong' });
    for (let i = 0; i < 2; i++) await post('/auth/login-pin', { username: u, pin: '9999' });
    expect((await post('/auth/login', { username: u, password: PASSWORD })).status).toBe(423);
  });

  it('concurrent guesses cannot bypass the counter', async () => {
    const u = await freshUser();
    await Promise.all(
      Array.from({ length: 8 }, () => post('/auth/login-pin', { username: u, pin: '9999' })),
    );
    const row = await t.kdb
      .selectFrom('users')
      .select(['failed_attempts', 'locked_until'])
      .where('username', '=', u)
      .executeTakeFirstOrThrow();
    expect(row.locked_until).not.toBeNull();
    expect(row.failed_attempts).toBeGreaterThanOrEqual(5);
  });
});

describe('sessions and refresh rotation', () => {
  it('rotates the refresh token; replaying the old one revokes the session', async () => {
    const u = await freshUser();
    const first = (await post('/auth/login', { username: u, password: PASSWORD })).body;
    const second = await post('/auth/refresh', { refreshToken: first.refreshToken });
    expect(second.status).toBe(200);
    expect(second.body.refreshToken).not.toBe(first.refreshToken);
    expect((await t.as(second.body.accessToken).get('/auth/me')).status).toBe(200);

    const replay = await post('/auth/refresh', { refreshToken: first.refreshToken });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('REFRESH_REUSED');

    // the whole session is dead, including the newest tokens
    expect((await post('/auth/refresh', { refreshToken: second.body.refreshToken })).status).toBe(
      401,
    );
    expect((await t.as(second.body.accessToken).get('/auth/me')).status).toBe(401);
  });

  it('logout revokes the session immediately', async () => {
    const u = await freshUser();
    const s = (await post('/auth/login', { username: u, password: PASSWORD })).body;
    expect((await t.as(s.accessToken).post('/auth/logout')).status).toBe(204);
    expect((await t.as(s.accessToken).get('/auth/me')).status).toBe(401);
    expect((await post('/auth/refresh', { refreshToken: s.refreshToken })).status).toBe(401);
  });

  it('access tokens expire after 15 minutes; refresh still works; refresh expires too', async () => {
    const u = await freshUser();
    const s = (await post('/auth/login', { username: u, password: PASSWORD })).body;
    t.clock.advance((ACCESS_TTL + 1) * 1000);
    expect((await t.as(s.accessToken).get('/auth/me')).status).toBe(401);
    const r = await post('/auth/refresh', { refreshToken: s.refreshToken });
    expect(r.status).toBe(200);
    expect((await t.as(r.body.accessToken).get('/auth/me')).status).toBe(200);
    t.clock.advance((REFRESH_TTL + 1) * 1000);
    expect((await post('/auth/refresh', { refreshToken: r.body.refreshToken })).status).toBe(401);
  });

  it('rejects malformed refresh tokens and tokens for deactivated users', async () => {
    expect((await post('/auth/refresh', { refreshToken: 'garbage' })).status).toBe(401);
    const u = await freshUser();
    const s = (await post('/auth/login', { username: u, password: PASSWORD })).body;
    await t.kdb.updateTable('users').set({ is_active: false }).where('username', '=', u).execute();
    expect((await t.as(s.accessToken).get('/auth/me')).status).toBe(401);
    expect((await post('/auth/refresh', { refreshToken: s.refreshToken })).status).toBe(401);
  });

  it('stores only a hash of the refresh secret', async () => {
    const u = await freshUser();
    const s = (await post('/auth/login', { username: u, password: PASSWORD })).body;
    const secret = (s.refreshToken as string).split('.')[1]!;
    const rows = await t.kdb.selectFrom('sessions').select('refresh_hash').execute();
    expect(rows.some((r) => r.refresh_hash === secret)).toBe(false);
  });
});

describe('device tokens', () => {
  it('binds the session to the device; revoking the device kills its sessions', async () => {
    const owner = await t.login('OWNER');
    const reg = await t.as(owner.token).post('/devices', { name: 'Counter 1', kind: 'COUNTER' });
    expect(reg.status).toBe(201);
    expect(reg.body.token).toBeTruthy();
    expect(reg.body.token_hash).toBeUndefined();
    const list = await t.as(owner.token).get('/devices');
    expect(JSON.stringify(list.body)).not.toContain(reg.body.token);

    const u = await freshUser();
    const ok = await post(
      '/auth/login',
      { username: u, password: PASSWORD },
      { 'x-device-token': reg.body.token },
    );
    expect(ok.status).toBe(200);
    const sess = await t.kdb
      .selectFrom('sessions')
      .select('device_id')
      .where(
        'user_id',
        '=',
        (
          await t.kdb
            .selectFrom('users')
            .select('id')
            .where('username', '=', u)
            .executeTakeFirstOrThrow()
        ).id,
      )
      .executeTakeFirstOrThrow();
    expect(sess.device_id).toBe(reg.body.id);

    const bad = await post(
      '/auth/login',
      { username: u, password: PASSWORD },
      { 'x-device-token': 'nope' },
    );
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe('DEVICE_INVALID');

    const revoke = await t.as(owner.token).patch(`/devices/${reg.body.id}`, { isActive: false });
    expect(revoke.status).toBe(200);
    expect((await t.as(ok.body.accessToken).get('/auth/me')).status).toBe(401);
    expect(
      (
        await post(
          '/auth/login',
          { username: u, password: PASSWORD },
          { 'x-device-token': reg.body.token },
        )
      ).body.code,
    ).toBe('DEVICE_INVALID');
  });

  it('a device of another branch cannot be used by a branch-bound user', async () => {
    const owner = await t.login('OWNER');
    const reg = await t
      .as(owner.token, t.otherBranchId)
      .post('/devices', { name: 'Other', kind: 'CAPTAIN' });
    expect(reg.status).toBe(201);
    const res = await post(
      '/auth/login',
      { username: 'cashier', password: PASSWORD },
      { 'x-device-token': reg.body.token },
    );
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
  });
});

describe('auth audit trail', () => {
  it('records LOGIN / LOGIN_FAILED / LOGIN_LOCKED / LOGOUT without credentials', async () => {
    const u = await freshUser();
    await post('/auth/login-pin', { username: u, pin: '5555' });
    for (let i = 0; i < 4; i++) await post('/auth/login-pin', { username: u, pin: '5555' });
    t.clock.advance(LOCK_DURATION_MS + 1000);
    const s = (await post('/auth/login-pin', { username: u, pin: PIN })).body;
    await t.as(s.accessToken).post('/auth/logout');

    const user = await t.kdb
      .selectFrom('users')
      .select('id')
      .where('username', '=', u)
      .executeTakeFirstOrThrow();
    const rows = await t.kdb
      .selectFrom('audit_log')
      .selectAll()
      .where('user_id', '=', user.id)
      .orderBy('id')
      .execute();
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual([
      'LOGIN_FAILED',
      'LOGIN_FAILED',
      'LOGIN_FAILED',
      'LOGIN_FAILED',
      'LOGIN_LOCKED',
      'LOGIN',
      'LOGOUT',
    ]);
    // Free-form columns only (ids are random hex and could contain "4321" by chance).
    const dump = JSON.stringify(rows.map((r) => [r.before, r.after, r.reason]));
    for (const secret of ['5555', PIN, PASSWORD, s.accessToken, s.refreshToken])
      expect(dump).not.toContain(secret);
  });
});
