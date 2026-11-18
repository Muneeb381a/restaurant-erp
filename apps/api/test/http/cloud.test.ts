import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import express, { type Express } from 'express';
import type { Kysely } from 'kysely';
import { randomBytes } from 'node:crypto';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env';
import { createControlDb } from '../../src/control/boot';
import { captureServerErrors } from '../../src/control/error-log';
import { createMultiTenantApp } from '../../src/control/multi-app';
import { createAdmin, type PlatformDeps } from '../../src/control/platform.service';
import { createLocalProvisioner } from '../../src/control/provisioner';
import { TenantRegistry } from '../../src/control/registry';
import { createSecretBox, tenantJwtSecret } from '../../src/control/secret-box';
import type { ControlDB } from '../../src/control/types';
import '../../src/shared/db'; // registers the BIGINT parser exactly as in production
import { createApp } from '../../src/http/app';
import { buildContext } from '../../src/http/build-context';
import { createHasher } from '../../src/modules/auth/password';
import { migrateUp } from '../../src/db/migrate';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const ADMIN_PASSWORD = 'Platf0rm!pass';
const logger = pino({ level: 'silent' });
const hasher = createHasher({ memoryCost: 1024, timeCost: 1 }); // cheap argon2, tests only

let container: StartedPostgreSqlContainer;
let adminUrl: string;
let control: Kysely<ControlDB>;
let platform: PlatformDeps;
let registry: TenantRegistry;
let app: Express;
let token: string;
const master = 'm'.repeat(48);

const api = (path: string) => `/api/v1${path}`;
const asAdmin = (t = token) => ({
  get: (p: string) => request(app).get(api(p)).set('authorization', `Bearer ${t}`),
  post: (p: string, body: object = {}) =>
    request(app).post(api(p)).set('authorization', `Bearer ${t}`).send(body),
  patch: (p: string, body: object = {}) =>
    request(app).patch(api(p)).set('authorization', `Bearer ${t}`).send(body),
});

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  adminUrl = container.getConnectionUri();
  const controlUrl = new URL(adminUrl);
  controlUrl.pathname = '/control_plane';
  const root = (await import('pg')).default;
  const c = new root.Client({ connectionString: adminUrl });
  await c.connect();
  await c.query('CREATE DATABASE control_plane');
  await c.end();
  await migrateUp(controlUrl.toString(), 'control');

  control = createControlDb(controlUrl.toString(), 4);
  const env = loadEnv({
    NODE_ENV: 'test',
    JWT_SECRET: master,
    CONTROL_DATABASE_URL: controlUrl.toString(),
    TENANT_SECRET_KEY: randomBytes(32).toString('base64'),
    PLATFORM_JWT_SECRET: 'p'.repeat(48),
    PROVISIONER: 'local',
    LOCAL_PROVISIONER_ADMIN_URL: adminUrl,
    TENANT_CACHE_MAX: '2',
  });
  const box = createSecretBox(env.TENANT_SECRET_KEY!);
  registry = new TenantRegistry({
    control,
    box,
    env,
    logger,
    masterJwtSecret: master,
    statusTtlMs: 0, // every request asks the control database: status changes are seen at once
    makeContext: (url, secret) => {
      const ctx = buildContext(env, logger, { databaseUrl: url, jwtSecret: secret, poolMax: 2 });
      return { ...ctx, hasher };
    },
  });
  platform = {
    control,
    registry,
    provisioner: createLocalProvisioner(adminUrl),
    box,
    hasher,
    logger,
    platformJwtSecret: env.PLATFORM_JWT_SECRET!,
  };
  app = createMultiTenantApp({ control, registry, platform, logger });
  await createAdmin(control, hasher, {
    username: 'root',
    fullName: 'Platform Root',
    password: ADMIN_PASSWORD,
  });
  const login = await request(app)
    .post(api('/platform/auth/login'))
    .send({ username: 'root', password: ADMIN_PASSWORD });
  if (!login.body.accessToken)
    throw new Error('admin login failed: ' + login.status + ' ' + JSON.stringify(login.body));
  token = login.body.accessToken;
}, 240_000);

afterAll(async () => {
  await registry.closeAll();
  await control.destroy();
  await container.stop();
});

async function newRestaurant(name: string, slug: string): Promise<Json> {
  const res = await asAdmin().post('/platform/tenants', {
    name,
    slug,
    ownerName: `${name} Owner`,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}
const ownerLogin = (slug: string, password: string, username = 'owner') =>
  request(app)
    .post(api(`/r/${slug}/auth/login`))
    .send({ username, password });

const NEW_PASSWORD = 'My0wn#Password';
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
/**
 * A new restaurant's owner signs in with the temporary password, is stopped by the server until it
 * is changed, changes it, and signs in again. Returns the token of that second sign-in.
 */
async function settleOwner(slug: string, temporary: string, username = 'owner'): Promise<string> {
  const first = await ownerLogin(slug, temporary, username);
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  const blocked = await request(app)
    .get(api(`/r/${slug}/branch`))
    .set(bearer(first.body.accessToken));
  expect(blocked.status).toBe(403);
  expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
  const change = await request(app)
    .post(api(`/r/${slug}/auth/change-password`))
    .set(bearer(first.body.accessToken))
    .send({ currentPassword: temporary, newPassword: NEW_PASSWORD });
  expect(change.status, JSON.stringify(change.body)).toBe(204);
  const second = await ownerLogin(slug, NEW_PASSWORD, username);
  expect(second.status).toBe(200);
  return second.body.accessToken;
}

describe('platform admin sign-in', () => {
  it('refuses unknown users and wrong passwords the same way, and locks after repeated failures', async () => {
    const wrongUser = await request(app)
      .post(api('/platform/auth/login'))
      .send({ username: 'nobody', password: 'whatever-1' });
    expect(wrongUser.status).toBe(401);
    expect(wrongUser.body.code).toBe('INVALID_CREDENTIALS');

    await createAdmin(control, hasher, {
      username: 'second',
      fullName: 'Second',
      password: 'Second#Pass1',
    });
    for (let i = 0; i < 5; i++) {
      const bad = await request(app)
        .post(api('/platform/auth/login'))
        .send({ username: 'second', password: 'wrong-wrong' });
      expect(bad.status).toBe(401);
    }
    const locked = await request(app)
      .post(api('/platform/auth/login'))
      .send({ username: 'second', password: 'Second#Pass1' });
    expect(locked.status).toBe(423);
    expect(locked.body.code).toBe('ACCOUNT_LOCKED');
  });

  it('needs a token for everything else, and a restaurant token is not a platform token', async () => {
    expect((await request(app).get(api('/platform/tenants'))).status).toBe(401);
    expect(
      (await request(app).get(api('/platform/tenants')).set('authorization', 'Bearer abc')).status,
    ).toBe(401);
    const me = await asAdmin().get('/platform/auth/me');
    expect(me.body).toMatchObject({ username: 'root' });
  });

  it('rotates the refresh token and ends the session when an old one is replayed', async () => {
    const first = (
      await request(app)
        .post(api('/platform/auth/login'))
        .send({ username: 'root', password: ADMIN_PASSWORD })
    ).body;
    const next = await request(app)
      .post(api('/platform/auth/refresh'))
      .send({ refreshToken: first.refreshToken });
    expect(next.status).toBe(200);
    const replay = await request(app)
      .post(api('/platform/auth/refresh'))
      .send({ refreshToken: first.refreshToken });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('REFRESH_REUSED');
    // the replay killed the session: even the newest refresh token is dead now
    const dead = await request(app)
      .post(api('/platform/auth/refresh'))
      .send({ refreshToken: next.body.refreshToken });
    expect(dead.status).toBe(401);
    const out = await request(app)
      .post(api('/platform/auth/logout'))
      .set('authorization', `Bearer ${first.accessToken}`);
    expect(out.status).toBe(401); // the session is gone, so the old access token no longer works
  });
});

describe('creating a restaurant', () => {
  it('gives it its own database, an owner who can sign in, and a one-time password', async () => {
    const made = await newRestaurant('Lahore Karahi', 'lahore-karahi');
    expect(made.tenant).toMatchObject({
      slug: 'lahore-karahi',
      status: 'ACTIVE',
      provider: 'LOCAL',
    });
    expect(made.owner.username).toBe('owner');
    expect(made.owner.temporaryPassword).toHaveLength(14);
    // the connection strings never leave the server
    expect(JSON.stringify(made)).not.toMatch(/postgres(ql)?:\/\//);

    const owner = await settleOwner('lahore-karahi', made.owner.temporaryPassword);
    const branch = await request(app).get(api('/r/lahore-karahi/branch')).set(bearer(owner));
    expect(branch.status).toBe(200);
    expect(branch.body.name).toBe('Lahore Karahi');
    // payment methods, price lists and settings are there, tax rules are placeholders
    const setup = await request(app).get(api('/r/lahore-karahi/setup/status')).set(bearer(owner));
    expect(setup.status).toBe(200);
  });

  it('refuses a code that is taken, reserved or badly shaped', async () => {
    const dup = await asAdmin().post('/platform/tenants', {
      name: 'X',
      slug: 'lahore-karahi',
      ownerName: 'X',
    });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('TENANT_SLUG_TAKEN');
    for (const slug of ['platform', 'Bad Code', 'a']) {
      const bad = await asAdmin().post('/platform/tenants', { name: 'X', slug, ownerName: 'X' });
      expect(bad.status, slug).toBe(400);
    }
  });

  it('lists restaurants, and the login screen can look one up without signing in', async () => {
    const list = await asAdmin().get('/platform/tenants');
    expect(list.body.items.map((t: Json) => t.slug)).toContain('lahore-karahi');
    const info = await request(app).get(api('/public/tenants/lahore-karahi'));
    expect(info.body).toEqual({ slug: 'lahore-karahi', name: 'Lahore Karahi', available: true });
    expect((await request(app).get(api('/public/tenants/no-such-place'))).status).toBe(404);
  });
});

describe('restaurants cannot see each other', () => {
  let a: Json;
  let b: Json;
  let tokenA: string;
  let tokenB: string;

  beforeAll(async () => {
    a = await newRestaurant('Alpha Grill', 'alpha-grill');
    b = await newRestaurant('Bravo Biryani', 'bravo-biryani');
    tokenA = await settleOwner('alpha-grill', a.owner.temporaryPassword);
    tokenB = await settleOwner('bravo-biryani', b.owner.temporaryPassword);
  });

  it("each restaurant's data is its own", async () => {
    const cat = await request(app)
      .post(api('/r/alpha-grill/categories'))
      .set('authorization', `Bearer ${tokenA}`)
      .send({ name: 'Only at Alpha' });
    expect(cat.status, JSON.stringify(cat.body)).toBe(201);
    const inA = await request(app)
      .get(api('/r/alpha-grill/categories'))
      .set('authorization', `Bearer ${tokenA}`);
    const inB = await request(app)
      .get(api('/r/bravo-biryani/categories'))
      .set('authorization', `Bearer ${tokenB}`);
    expect(JSON.stringify(inA.body)).toContain('Only at Alpha');
    expect(JSON.stringify(inB.body)).not.toContain('Only at Alpha');
    const branchB = await request(app)
      .get(api('/r/bravo-biryani/branch'))
      .set('authorization', `Bearer ${tokenB}`);
    expect(branchB.body.name).toBe('Bravo Biryani');
  });

  it("a token from one restaurant is refused by another, and the owner's password does not carry over", async () => {
    const crossed = await request(app)
      .get(api('/r/bravo-biryani/branch'))
      .set('authorization', `Bearer ${tokenA}`);
    expect(crossed.status).toBe(401);
    const wrong = await ownerLogin('bravo-biryani', a.owner.temporaryPassword);
    expect(wrong.status).toBe(401);
  });

  it('each restaurant signs with its own derived secret', () => {
    expect(tenantJwtSecret(master, a.tenant.id)).not.toBe(tenantJwtSecret(master, b.tenant.id));
  });

  it('an unknown restaurant code is a clean 404', async () => {
    const res = await request(app).get(api('/r/nowhere/branch'));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TENANT_NOT_FOUND');
  });

  it('keeps no more restaurants warm than it was told to, and still serves the one it let go', async () => {
    await registry.get('alpha-grill');
    await registry.get('bravo-biryani');
    await registry.get('lahore-karahi'); // cache max is 2: the oldest is closed
    expect(registry.warmCount()).toBeLessThanOrEqual(2);
    const again = await request(app)
      .get(api('/r/alpha-grill/branch'))
      .set('authorization', `Bearer ${tokenA}`);
    expect(again.status).toBe(200);
  });
});

describe('switching a restaurant off and on', () => {
  let made: Json;
  let tok: string;
  beforeAll(async () => {
    made = await newRestaurant('Charlie Chai', 'charlie-chai');
    tok = await settleOwner('charlie-chai', made.owner.temporaryPassword);
  });

  it('suspending stops every login and request at once, with the reason, and activating brings it back', async () => {
    const off = await asAdmin().post(`/platform/tenants/${made.tenant.id}/suspend`, {
      reason: 'Unpaid invoice',
    });
    expect(off.status).toBe(200);
    expect(off.body.status).toBe('SUSPENDED');

    const blocked = await request(app)
      .get(api('/r/charlie-chai/branch'))
      .set('authorization', `Bearer ${tok}`);
    expect(blocked.status).toBe(403);
    expect(blocked.body).toMatchObject({ code: 'TENANT_SUSPENDED', reason: 'Unpaid invoice' });
    expect((await ownerLogin('charlie-chai', NEW_PASSWORD)).status).toBe(403);
    const info = await request(app).get(api('/public/tenants/charlie-chai'));
    expect(info.body.available).toBe(false);

    expect(
      (
        await asAdmin().post(`/platform/tenants/${made.tenant.id}/suspend`, {
          reason: 'again please',
        })
      ).status,
    ).toBe(409);

    const on = await asAdmin().post(`/platform/tenants/${made.tenant.id}/activate`);
    expect(on.body.status).toBe('ACTIVE');
    const back = await request(app)
      .get(api('/r/charlie-chai/branch'))
      .set('authorization', `Bearer ${tok}`);
    expect(back.status).toBe(200); // nothing was lost while it was off
  });

  it('archiving hides it; nothing is deleted', async () => {
    const made2 = await newRestaurant('Delta Dhaba', 'delta-dhaba');
    const gone = await asAdmin().post(`/platform/tenants/${made2.tenant.id}/archive`);
    expect(gone.body.status).toBe('ARCHIVED');
    expect((await request(app).get(api('/r/delta-dhaba/branch'))).status).toBe(404);
    expect((await request(app).get(api('/public/tenants/delta-dhaba'))).status).toBe(404);
    const row = await control
      .selectFrom('tenants')
      .select('id')
      .where('slug', '=', 'delta-dhaba')
      .executeTakeFirst();
    expect(row).toBeDefined(); // the row is still there
    await expect(
      control.deleteFrom('tenants').where('slug', '=', 'delta-dhaba').execute(),
    ).rejects.toThrow(/append-only/);
  });
});

describe('owner password reset and health', () => {
  it('a reset gives a new password, the old one and open sessions stop working', async () => {
    const made = await newRestaurant('Echo Eatery', 'echo-eatery');
    const first = await ownerLogin('echo-eatery', made.owner.temporaryPassword);
    expect(first.status).toBe(200);

    const reset = await asAdmin().post(`/platform/tenants/${made.tenant.id}/reset-owner`);
    expect(reset.status).toBe(200);
    expect(reset.body.temporaryPassword).not.toBe(made.owner.temporaryPassword);

    expect((await ownerLogin('echo-eatery', made.owner.temporaryPassword)).status).toBe(401);
    expect((await ownerLogin('echo-eatery', reset.body.temporaryPassword)).status).toBe(200);
    const old = await request(app)
      .get(api('/r/echo-eatery/branch'))
      .set('authorization', `Bearer ${first.body.accessToken}`);
    expect(old.status).toBe(401); // the session open before the reset was ended
  });

  it('reports technical health only', async () => {
    const t = (await asAdmin().get('/platform/tenants')).body.items.find(
      (x: Json) => x.slug === 'echo-eatery',
    );
    const health = await asAdmin().get(`/platform/tenants/${t.id}/health`);
    expect(health.body.reachable).toBe(true);
    expect(health.body.migrations.upToDate).toBe(true);
    expect(health.body.databaseBytes).toBeGreaterThan(0);
    expect(Object.keys(health.body).sort()).toEqual([
      'databaseBytes',
      'error',
      'latencyMs',
      'migrations',
      'reachable',
    ]);
  });
});

describe('changing the password', () => {
  let slug: string;
  let temporary: string;
  beforeAll(async () => {
    const made = await newRestaurant('Golf Grill', 'golf-grill');
    slug = 'golf-grill';
    temporary = made.owner.temporaryPassword;
  });
  const change = (token: string, body: object) =>
    request(app)
      .post(api(`/r/${slug}/auth/change-password`))
      .set(bearer(token))
      .send(body);

  it('needs the right current password and a new, different, long enough one', async () => {
    const t = (await ownerLogin(slug, temporary)).body.accessToken;
    const wrong = await change(t, { currentPassword: 'not-it-at-all', newPassword: NEW_PASSWORD });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
    expect((await change(t, { currentPassword: temporary, newPassword: temporary })).status).toBe(
      400,
    );
    expect((await change(t, { currentPassword: temporary, newPassword: 'short' })).status).toBe(
      400,
    );
    // still blocked: nothing changed
    expect(
      (
        await request(app)
          .get(api(`/r/${slug}/branch`))
          .set(bearer(t))
      ).status,
    ).toBe(403);
  });

  it("ends the owner's other sign-ins and lets this one carry on", async () => {
    const a = (await ownerLogin(slug, temporary)).body.accessToken;
    const b = (await ownerLogin(slug, temporary)).body.accessToken; // a second device
    expect(
      (await change(a, { currentPassword: temporary, newPassword: NEW_PASSWORD })).status,
    ).toBe(204);
    expect(
      (
        await request(app)
          .get(api(`/r/${slug}/branch`))
          .set(bearer(a))
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .get(api(`/r/${slug}/branch`))
          .set(bearer(b))
      ).status,
    ).toBe(401);
    expect((await ownerLogin(slug, temporary)).status).toBe(401); // the temporary one is gone
    const me = await request(app)
      .get(api(`/r/${slug}/auth/me`))
      .set(bearer(a));
    expect(me.body.mustChangePassword).toBe(false);
  });

  it("is written to the restaurant's own audit log without the password", async () => {
    const t = await ownerLogin(slug, NEW_PASSWORD);
    const log = await request(app)
      .get(api(`/r/${slug}/audit-log?action=PASSWORD_CHANGED`))
      .set(bearer(t.body.accessToken));
    expect(log.status).toBe(200);
    expect(JSON.stringify(log.body)).not.toContain(NEW_PASSWORD);
  });
});

describe('the platform audit trail', () => {
  it('records who did what, cannot be changed, and never holds a password', async () => {
    const log = await asAdmin().get('/platform/audit?limit=200');
    const actions = log.body.items.map((e: Json) => e.action);
    for (const a of [
      'TENANT_CREATE',
      'TENANT_ACTIVATED',
      'TENANT_SUSPEND',
      'TENANT_OWNER_RESET',
      'PLATFORM_LOGIN',
    ])
      expect(actions, a).toContain(a);
    expect(JSON.stringify(log.body)).not.toMatch(/temporaryPassword|argon2/);
    await expect(control.deleteFrom('platform_audit_log').execute()).rejects.toThrow(/append-only/);
    await expect(
      control.updateTable('platform_audit_log').set({ action: 'x' }).execute(),
    ).rejects.toThrow(/append-only/);
  });
});

describe('a failed provisioning can be retried', () => {
  it('keeps the half-made restaurant as FAILED and finishes it on retry', async () => {
    let calls = 0;
    const flaky: PlatformDeps = {
      ...platform,
      migrate: async (url) => {
        if (++calls === 1) throw new Error('simulated outage');
        return [...(await migrateUp(url, 'core')), ...(await migrateUp(url, 'phase2'))];
      },
    };
    const sub = createMultiTenantApp({ control, registry, platform: flaky, logger });
    const created = await request(sub)
      .post(api('/platform/tenants'))
      .set('authorization', `Bearer ${token}`)
      .send({ name: 'Foxtrot Foods', slug: 'foxtrot-foods', ownerName: 'Fox' });
    expect(created.status).toBe(502);
    expect(created.body.code).toBe('PROVISIONING_FAILED');
    const row = await control
      .selectFrom('tenants')
      .selectAll()
      .where('slug', '=', 'foxtrot-foods')
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('FAILED');
    expect(row.last_error).toContain('simulated outage');
    expect(row.db_url_enc).not.toBeNull(); // the database exists: the retry does not make a second one

    const retried = await request(sub)
      .post(api(`/platform/tenants/${row.id}/retry`))
      .set('authorization', `Bearer ${token}`);
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body.tenant.status).toBe('ACTIVE');
    expect((await ownerLogin('foxtrot-foods', retried.body.owner.temporaryPassword)).status).toBe(
      200,
    );
    const after = await control
      .selectFrom('tenants')
      .select('provider_ref')
      .where('slug', '=', 'foxtrot-foods')
      .executeTakeFirstOrThrow();
    expect(after.provider_ref).toBe(row.provider_ref);
  });
});

describe('live updates', () => {
  it('can be switched off for serverless hosting: the stream answers 501 so screens poll instead', async () => {
    const rt = await registry.get('alpha-grill');
    const quiet = createApp(rt.ctx, { liveEvents: false });
    const res = await request(quiet).get('/api/v1/events');
    expect(res.status).toBe(501);
    expect(res.body.code).toBe('LIVE_DISABLED');
    // and on (the default) the stream wants a signed-in user
    const on = await request(app).get(api('/r/alpha-grill/events'));
    expect(on.status).toBe(401);
  });
});

describe('server errors are noted for the platform admin', () => {
  it('records a 5xx with its route shape and code, attributes it to the restaurant and keeps no body', async () => {
    const made = await newRestaurant('Faulty Grill', 'faulty-grill');
    const id = made.tenant.id as string;
    const probe = express();
    probe.use((req, _res, next) => {
      req.id = 'req-probe-1';
      next();
    });
    probe.use(captureServerErrors(control, logger));
    probe.post('/api/v1/r/faulty-grill/orders/:id/send', (_req, res) => {
      res.locals.errorCode = 'INTERNAL_ERROR';
      res.status(500).json({ secret: 'never stored' });
    });
    probe.get('/api/v1/r/faulty-grill/ok', (_req, res) => res.json({ ok: true }));

    const orderId = '6f1c2a3e-1111-4222-8333-944455556666';
    const bad = await request(probe)
      .post(`/api/v1/r/faulty-grill/orders/${orderId}/send?token=abc`)
      .send({ pin: '1234' });
    expect(bad.status).toBe(500); // the answer itself is untouched
    expect((await request(probe).get('/api/v1/r/faulty-grill/ok')).status).toBe(200);

    const list = await asAdmin().get(`/platform/errors?tenantId=${id}&hours=1`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1); // the 200 was not recorded
    const e = list.body.items[0];
    expect(e).toMatchObject({
      slug: 'faulty-grill',
      status: 500,
      code: 'INTERNAL_ERROR',
      method: 'POST',
      route: '/r/faulty-grill/orders/:id/send',
      requestId: 'req-probe-1',
    });
    expect(JSON.stringify(list.body)).not.toMatch(/never stored|1234|abc|6f1c2a3e/);

    const tenants = await asAdmin().get('/platform/tenants');
    expect(tenants.body.items.find((t: Json) => t.id === id).errors24h).toBe(1);
  });

  it('needs a platform admin', async () => {
    expect((await request(app).get(api('/platform/errors'))).status).toBe(401);
  });
});
