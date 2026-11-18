import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import type { Kysely, Selectable } from 'kysely';
import pg from 'pg';
import type { Logger } from 'pino';
import { MIGRATION_SETS, migrateUp } from '../db/migrate';
import { AppError } from '../http/errors';
import { CLEAN_STATE, isLocked, onFailure, type LockState } from '../modules/auth/lockout';
import type { PasswordHasher } from '../modules/auth/password';
import {
  formatRefreshToken,
  hashSecret,
  parseRefreshToken,
  randomSecret,
  secureEquals,
  signAccessToken,
} from '../modules/auth/tokens';
import { bootstrapRestaurant, generateTempPassword, resetOwnerPassword } from './bootstrap';
import { ProvisionError, type Provisioner } from './provisioner';
import { errorCounts } from './error-log';
import type { TenantRegistry } from './registry';
import type { SecretBox } from './secret-box';
import { checkSlug } from './slug';
import type { ControlDB, TenantsTable } from './types';

export interface PlatformDeps {
  control: Kysely<ControlDB>;
  registry: TenantRegistry;
  provisioner: Provisioner;
  box: SecretBox;
  hasher: PasswordHasher;
  logger: Logger;
  platformJwtSecret: string;
  accessTtlSeconds?: number;
  refreshTtlSeconds?: number;
  now?: () => Date;
  /** Brings a restaurant database up to date. Tests may replace it. */
  migrate?: (directUrl: string) => Promise<string[]>;
}

export interface AdminPrincipal {
  id: string;
  username: string;
  fullName: string;
  sessionId: string;
}

const clock = (d: PlatformDeps): Date => (d.now ? d.now() : new Date());
const ACCESS_TTL = 30 * 60;
const REFRESH_TTL = 8 * 60 * 60;
/** A restaurant stuck in PROVISIONING this long (the request died) may be retried. */
const STALE_PROVISIONING_MS = 10 * 60_000;

const defaultMigrate = async (directUrl: string): Promise<string[]> => [
  ...(await migrateUp(directUrl, 'core')),
  ...(await migrateUp(directUrl, 'phase2')),
];

// ───────────────────────────────── audit ─────────────────────────────────

export async function audit(
  d: PlatformDeps,
  adminId: string | null,
  action: string,
  tenantId: string | null,
  detail: Record<string, unknown> = {},
  ip?: string,
): Promise<void> {
  await d.control
    .insertInto('platform_audit_log')
    .values({ admin_id: adminId, action, tenant_id: tenantId, detail, ip: ip ?? null })
    .execute();
}

// ───────────────────────────────── admins and sessions ─────────────────────────────────

const invalid = (): AppError =>
  new AppError(401, 'INVALID_CREDENTIALS', 'Wrong username or password');
let dummy: Promise<string> | null = null;

export interface AdminTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

async function issue(
  d: PlatformDeps,
  adminId: string,
  sessionId: string,
  secret: string,
  now: Date,
) {
  const access = await signAccessToken(
    d.platformJwtSecret,
    { userId: adminId, sessionId },
    d.accessTtlSeconds ?? ACCESS_TTL,
    now,
  );
  return {
    accessToken: access.token,
    refreshToken: formatRefreshToken(sessionId, secret),
    expiresAt: access.expiresAt,
  } satisfies AdminTokens;
}

export async function createAdmin(
  control: Kysely<ControlDB>,
  hasher: PasswordHasher,
  input: { username: string; fullName: string; password: string },
): Promise<string> {
  const row = await control
    .insertInto('platform_admins')
    .values({
      username: input.username,
      full_name: input.fullName,
      password_hash: await hasher.hash(input.password),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function loginAdmin(
  d: PlatformDeps,
  input: { username: string; password: string; ip?: string },
): Promise<AdminTokens> {
  const now = clock(d);
  const admin = await d.control
    .selectFrom('platform_admins')
    .selectAll()
    .where('username', '=', input.username.toLowerCase())
    .executeTakeFirst();
  if (!admin || !admin.is_active) {
    dummy ??= d.hasher.hash('not-a-real-password');
    await d.hasher.verify(await dummy, input.password); // same work as a real check: no timing tell
    await audit(
      d,
      null,
      'PLATFORM_LOGIN_FAILED',
      null,
      { reason: 'unknown_or_inactive' },
      input.ip,
    );
    throw invalid();
  }
  const state: LockState = {
    failedAttempts: admin.failed_attempts,
    lastFailedAt: admin.last_failed_at,
    lockedUntil: admin.locked_until,
  };
  if (isLocked(state, now)) {
    await audit(d, admin.id, 'PLATFORM_LOGIN_BLOCKED_LOCKED', null, {}, input.ip);
    throw new AppError(423, 'ACCOUNT_LOCKED', 'Account temporarily locked', {
      retryAfterSeconds: Math.ceil((state.lockedUntil!.getTime() - now.getTime()) / 1000),
    });
  }
  if (!(await d.hasher.verify(admin.password_hash, input.password))) {
    const next = onFailure(state, now);
    await d.control
      .updateTable('platform_admins')
      .set({
        failed_attempts: next.failedAttempts,
        last_failed_at: next.lastFailedAt,
        locked_until: next.lockedUntil,
      })
      .where('id', '=', admin.id)
      .execute();
    await audit(
      d,
      admin.id,
      next.lockedUntil ? 'PLATFORM_LOGIN_LOCKED' : 'PLATFORM_LOGIN_FAILED',
      null,
      { failedAttempts: next.failedAttempts },
      input.ip,
    );
    throw invalid();
  }
  await d.control
    .updateTable('platform_admins')
    .set({
      failed_attempts: CLEAN_STATE.failedAttempts,
      last_failed_at: null,
      locked_until: null,
    })
    .where('id', '=', admin.id)
    .execute();
  const sessionId = randomUUID();
  const secret = randomSecret();
  await d.control
    .insertInto('platform_sessions')
    .values({
      id: sessionId,
      admin_id: admin.id,
      refresh_hash: hashSecret(secret),
      expires_at: new Date(now.getTime() + (d.refreshTtlSeconds ?? REFRESH_TTL) * 1000),
    })
    .execute();
  await audit(d, admin.id, 'PLATFORM_LOGIN', null, {}, input.ip);
  return issue(d, admin.id, sessionId, secret, now);
}

/** Rotating refresh, like the restaurant login: an old secret presented again ends the session. */
export async function refreshAdmin(d: PlatformDeps, refreshToken: string): Promise<AdminTokens> {
  const parsed = parseRefreshToken(refreshToken);
  if (!parsed) throw new AppError(401, 'UNAUTHENTICATED', 'Invalid refresh token');
  const now = clock(d);
  const s = await d.control
    .selectFrom('platform_sessions')
    .innerJoin('platform_admins', 'platform_admins.id', 'platform_sessions.admin_id')
    .select([
      'platform_sessions.id as id',
      'platform_sessions.admin_id as admin_id',
      'platform_sessions.refresh_hash as refresh_hash',
      'platform_sessions.expires_at as expires_at',
      'platform_sessions.revoked_at as revoked_at',
      'platform_admins.is_active as is_active',
    ])
    .where('platform_sessions.id', '=', parsed.sessionId)
    .executeTakeFirst();
  if (!s || s.revoked_at || !s.is_active || s.expires_at.getTime() <= now.getTime())
    throw new AppError(401, 'UNAUTHENTICATED', 'Invalid refresh token');
  if (!secureEquals(hashSecret(parsed.secret), s.refresh_hash)) {
    await d.control
      .updateTable('platform_sessions')
      .set({ revoked_at: now })
      .where('id', '=', s.id)
      .execute();
    await audit(d, s.admin_id, 'PLATFORM_REFRESH_REUSED', null, { sessionId: s.id });
    throw new AppError(401, 'REFRESH_REUSED', 'Refresh token was already used');
  }
  const secret = randomSecret();
  await d.control
    .updateTable('platform_sessions')
    .set({
      refresh_hash: hashSecret(secret),
      expires_at: new Date(now.getTime() + (d.refreshTtlSeconds ?? REFRESH_TTL) * 1000),
    })
    .where('id', '=', s.id)
    .execute();
  return issue(d, s.admin_id, s.id, secret, now);
}

export async function logoutAdmin(d: PlatformDeps, sessionId: string): Promise<void> {
  await d.control
    .updateTable('platform_sessions')
    .set({ revoked_at: clock(d) })
    .where('id', '=', sessionId)
    .where('revoked_at', 'is', null)
    .execute();
}

// ───────────────────────────────── restaurants ─────────────────────────────────

type TenantRow = Selectable<TenantsTable>;

/** What the admin screen may see. Never the connection strings. */
export function presentTenant(t: TenantRow) {
  return {
    id: t.id,
    slug: t.slug,
    name: t.name,
    status: t.status,
    plan: t.plan,
    provider: t.provider,
    region: t.region,
    ownerName: t.owner_name,
    ownerUsername: t.owner_username,
    contactPhone: t.contact_phone,
    notes: t.notes,
    lastError: t.last_error,
    createdAt: t.created_at,
    activatedAt: t.activated_at,
    suspendedAt: t.suspended_at,
    suspendedReason: t.suspended_reason,
  };
}

const tenantOrThrow = async (d: PlatformDeps, id: string): Promise<TenantRow> => {
  const t = await d.control
    .selectFrom('tenants')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!t) throw new AppError(404, 'TENANT_NOT_FOUND', 'No such restaurant');
  return t;
};

export async function listTenants(d: PlatformDeps) {
  const rows = await d.control
    .selectFrom('tenants')
    .selectAll()
    .orderBy('created_at', 'desc')
    .execute();
  const failures = await errorCounts(d.control, 24);
  return rows.map((r) => ({ ...presentTenant(r), errors24h: failures.get(r.id) ?? 0 }));
}

export async function getTenant(d: PlatformDeps, id: string) {
  return presentTenant(await tenantOrThrow(d, id));
}

/** The login screen asks this before it shows anything: is this restaurant code real, and what is it called? */
export async function publicTenantInfo(d: PlatformDeps, slug: string) {
  const t = await d.control
    .selectFrom('tenants')
    .select(['slug', 'name', 'status'])
    .where('slug', '=', slug.toLowerCase())
    .executeTakeFirst();
  if (!t || t.status === 'ARCHIVED' || t.status === 'FAILED' || t.status === 'PROVISIONING')
    throw new AppError(404, 'TENANT_NOT_FOUND', 'No restaurant with that code');
  return { slug: t.slug, name: t.name, available: t.status === 'ACTIVE' };
}

export interface NewTenant {
  name: string;
  slug: string;
  ownerName: string;
  ownerUsername?: string | undefined;
  contactPhone?: string | undefined;
  notes?: string | undefined;
  plan?: string | undefined;
}

export interface Provisioned {
  tenant: ReturnType<typeof presentTenant>;
  /** Shown once. It is not stored anywhere in clear. */
  owner: { username: string; temporaryPassword: string };
}

export async function createTenant(
  d: PlatformDeps,
  admin: AdminPrincipal,
  input: NewTenant,
  ip?: string,
): Promise<Provisioned> {
  const slug = input.slug.toLowerCase();
  const problem = checkSlug(slug);
  if (problem)
    throw new AppError(
      400,
      'TENANT_SLUG_INVALID',
      problem === 'RESERVED'
        ? 'That code is used by the app itself. Choose another'
        : 'Use 3 to 40 lowercase letters, digits and single hyphens',
      { problem },
    );
  const ownerUsername = (input.ownerUsername ?? 'owner').toLowerCase();
  let row: TenantRow;
  try {
    row = await d.control
      .insertInto('tenants')
      .values({
        slug,
        name: input.name,
        provider: d.provisioner.provider,
        owner_name: input.ownerName,
        owner_username: ownerUsername,
        contact_phone: input.contactPhone ?? null,
        notes: input.notes ?? null,
        plan: input.plan ?? 'STANDARD',
        created_by: admin.id,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  } catch (e) {
    if ((e as { code?: string }).code === '23505')
      throw new AppError(409, 'TENANT_SLUG_TAKEN', 'A restaurant with that code already exists');
    throw e;
  }
  await audit(d, admin.id, 'TENANT_CREATE', row.id, { slug, name: input.name }, ip);
  return runProvisioning(d, admin, row.id, ip);
}

/**
 * Creates the database, brings it up to date and puts the owner in. Every step can be repeated, so
 * after a failure "retry" continues where it stopped instead of starting over.
 */
export async function runProvisioning(
  d: PlatformDeps,
  admin: AdminPrincipal,
  tenantId: string,
  ip?: string,
): Promise<Provisioned> {
  let t = await tenantOrThrow(d, tenantId);
  if (t.status !== 'PROVISIONING' && t.status !== 'FAILED')
    throw new AppError(
      409,
      'TENANT_BAD_STATE',
      `Cannot provision a restaurant that is ${t.status}`,
    );
  const fail = async (step: string, e: unknown, extra = ''): Promise<never> => {
    const message = `${step}: ${e instanceof Error ? e.message : String(e)}${extra}`;
    d.logger.error({ tenant: t.slug, step, err: e }, 'provisioning failed');
    await d.control
      .updateTable('tenants')
      .set({ status: 'FAILED', last_error: message.slice(0, 500) })
      .where('id', '=', t.id)
      .execute();
    await audit(
      d,
      admin.id,
      'TENANT_PROVISION_FAILED',
      t.id,
      { step, message: message.slice(0, 300) },
      ip,
    );
    throw new AppError(502, 'PROVISIONING_FAILED', message.slice(0, 300), { tenantId: t.id, step });
  };
  await d.control
    .updateTable('tenants')
    .set({ status: 'PROVISIONING', last_error: null })
    .where('id', '=', t.id)
    .execute();

  // 1. the database
  if (!t.db_url_enc || !t.db_direct_url_enc) {
    try {
      const db = await d.provisioner.provision(t.slug);
      await d.control
        .updateTable('tenants')
        .set({
          provider_ref: db.providerRef,
          region: db.region,
          db_url_enc: d.box.encrypt(db.url),
          db_direct_url_enc: d.box.encrypt(db.directUrl),
        })
        .where('id', '=', t.id)
        .execute();
    } catch (e) {
      const maybe = e instanceof ProvisionError && e.mayHaveCreated;
      await fail(
        'create database',
        e,
        maybe ? ' (a project may have been created: check the provider before retrying)' : '',
      );
    }
    t = await tenantOrThrow(d, t.id);
  }
  const directUrl = d.box.decrypt(t.db_direct_url_enc!);

  // 2. the schema
  try {
    await (d.migrate ?? defaultMigrate)(directUrl);
  } catch (e) {
    await fail('migrate', e);
  }

  // 3. the restaurant and its owner
  const temporaryPassword = generateTempPassword();
  try {
    const out = await bootstrapRestaurant(
      directUrl,
      {
        restaurantName: t.name,
        ownerName: t.owner_name,
        ownerUsername: t.owner_username,
        ownerPassword: temporaryPassword,
        phone: t.contact_phone,
      },
      d.hasher,
    );
    // already set up by an earlier attempt whose answer was lost: give the owner a fresh password
    if (!out.created)
      await resetOwnerPassword(directUrl, t.owner_username, temporaryPassword, d.hasher);
  } catch (e) {
    await fail('set up restaurant', e);
  }

  const done = await d.control
    .updateTable('tenants')
    .set({ status: 'ACTIVE', activated_at: new Date(), last_error: null })
    .where('id', '=', t.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await audit(d, admin.id, 'TENANT_ACTIVATED', t.id, { slug: t.slug }, ip);
  return {
    tenant: presentTenant(done),
    owner: { username: t.owner_username, temporaryPassword },
  };
}

export async function retryProvisioning(
  d: PlatformDeps,
  admin: AdminPrincipal,
  id: string,
  ip?: string,
) {
  const t = await tenantOrThrow(d, id);
  const stale = Date.now() - t.created_at.getTime() > STALE_PROVISIONING_MS;
  if (t.status === 'PROVISIONING' && !stale)
    throw new AppError(
      409,
      'TENANT_BAD_STATE',
      'This restaurant is still being set up. Wait a few minutes',
    );
  return runProvisioning(d, admin, id, ip);
}

export async function updateTenant(
  d: PlatformDeps,
  admin: AdminPrincipal,
  id: string,
  patch: { name?: string; plan?: string; notes?: string | null; contactPhone?: string | null },
  ip?: string,
) {
  const before = await tenantOrThrow(d, id);
  const set = {
    ...(patch.name !== undefined && { name: patch.name }),
    ...(patch.plan !== undefined && { plan: patch.plan }),
    ...(patch.notes !== undefined && { notes: patch.notes }),
    ...(patch.contactPhone !== undefined && { contact_phone: patch.contactPhone }),
  };
  const row = await d.control
    .updateTable('tenants')
    .set(set)
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await audit(
    d,
    admin.id,
    'TENANT_UPDATE',
    id,
    { before: { name: before.name, plan: before.plan }, after: set },
    ip,
  );
  d.registry.evict(before.slug).catch(() => undefined);
  return presentTenant(row);
}

async function setStatus(
  d: PlatformDeps,
  admin: AdminPrincipal,
  id: string,
  from: TenantRow['status'][],
  to: TenantRow['status'],
  extra: Partial<TenantRow>,
  action: string,
  detail: Record<string, unknown>,
  ip?: string,
) {
  const before = await tenantOrThrow(d, id);
  if (!from.includes(before.status))
    throw new AppError(
      409,
      'TENANT_BAD_STATE',
      `A restaurant that is ${before.status} cannot become ${to}`,
    );
  const row = await d.control
    .updateTable('tenants')
    .set({ status: to, ...extra })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await audit(d, admin.id, action, id, detail, ip);
  await d.registry.evict(before.slug); // takes effect at once on this instance, within seconds elsewhere
  return presentTenant(row);
}

export const suspendTenant = (
  d: PlatformDeps,
  a: AdminPrincipal,
  id: string,
  reason: string,
  ip?: string,
) =>
  setStatus(
    d,
    a,
    id,
    ['ACTIVE'],
    'SUSPENDED',
    { suspended_at: new Date(), suspended_reason: reason },
    'TENANT_SUSPEND',
    { reason },
    ip,
  );

export const activateTenant = (d: PlatformDeps, a: AdminPrincipal, id: string, ip?: string) =>
  setStatus(
    d,
    a,
    id,
    ['SUSPENDED'],
    'ACTIVE',
    { suspended_at: null, suspended_reason: null },
    'TENANT_ACTIVATE',
    {},
    ip,
  );

/** Archiving hides the restaurant and stops its logins. Its data stays where it is: nothing is deleted. */
export const archiveTenant = (d: PlatformDeps, a: AdminPrincipal, id: string, ip?: string) =>
  setStatus(
    d,
    a,
    id,
    ['ACTIVE', 'SUSPENDED', 'FAILED'],
    'ARCHIVED',
    { archived_at: new Date() },
    'TENANT_ARCHIVE',
    {},
    ip,
  );

export async function resetOwner(d: PlatformDeps, admin: AdminPrincipal, id: string, ip?: string) {
  const t = await tenantOrThrow(d, id);
  if (!t.db_direct_url_enc || (t.status !== 'ACTIVE' && t.status !== 'SUSPENDED'))
    throw new AppError(409, 'TENANT_BAD_STATE', 'This restaurant has no working database yet');
  const temporaryPassword = generateTempPassword();
  const ok = await resetOwnerPassword(
    d.box.decrypt(t.db_direct_url_enc),
    t.owner_username,
    temporaryPassword,
    d.hasher,
  );
  if (!ok) throw new AppError(404, 'NOT_FOUND', 'The owner login was not found in that restaurant');
  await audit(d, admin.id, 'TENANT_OWNER_RESET', id, { owner: t.owner_username }, ip);
  return { username: t.owner_username, temporaryPassword };
}

// ───────────────────────────────── health and upgrades ─────────────────────────────────

const countMigrations = async (dir: string): Promise<number> =>
  (await readdir(dir)).filter((f) => f.endsWith('.sql')).length;

/** Technical state only: reachable, how up to date, how big. Nothing from the restaurant's business. */
export async function tenantHealth(d: PlatformDeps, id: string) {
  const t = await tenantOrThrow(d, id);
  const out = {
    reachable: false,
    latencyMs: null as number | null,
    migrations: { applied: 0, available: 0, upToDate: false },
    databaseBytes: null as number | null,
    error: null as string | null,
  };
  if (!t.db_direct_url_enc) return { ...out, error: 'No database yet' };
  const client = new pg.Client({
    connectionString: d.box.decrypt(t.db_direct_url_enc),
    connectionTimeoutMillis: 10_000,
  });
  try {
    const started = Date.now();
    await client.connect();
    await client.query('SELECT 1');
    out.latencyMs = Date.now() - started;
    out.reachable = true;
    const applied =
      (await client.query<{ n: string }>('SELECT count(*)::text AS n FROM pgmigrations')).rows[0]
        ?.n ?? '0';
    const applied2 =
      (await client.query<{ n: string }>('SELECT count(*)::text AS n FROM pgmigrations_phase2'))
        .rows[0]?.n ?? '0';
    const available =
      (await countMigrations(MIGRATION_SETS.core.dir)) +
      (await countMigrations(MIGRATION_SETS.phase2.dir));
    out.migrations = {
      applied: Number(applied) + Number(applied2),
      available,
      upToDate: Number(applied) + Number(applied2) >= available,
    };
    out.databaseBytes = Number(
      (await client.query<{ n: string }>('SELECT pg_database_size(current_database())::text AS n'))
        .rows[0]?.n ?? 0,
    );
  } catch (e) {
    out.error = e instanceof Error ? e.message.slice(0, 200) : 'unreachable';
  } finally {
    await client.end().catch(() => undefined);
  }
  return out;
}

/** After a new version is deployed: bring one restaurant's database up to date. */
export async function migrateTenant(d: PlatformDeps, admin: AdminPrincipal | null, id: string) {
  const t = await tenantOrThrow(d, id);
  if (!t.db_direct_url_enc)
    throw new AppError(409, 'TENANT_BAD_STATE', 'This restaurant has no database yet');
  const applied = await (d.migrate ?? defaultMigrate)(d.box.decrypt(t.db_direct_url_enc));
  await audit(d, admin?.id ?? null, 'TENANT_MIGRATE', id, { applied });
  return { applied };
}

export async function auditTrail(
  d: PlatformDeps,
  opts: { tenantId?: string | undefined; limit: number },
) {
  let q = d.control
    .selectFrom('platform_audit_log')
    .leftJoin('platform_admins', 'platform_admins.id', 'platform_audit_log.admin_id')
    .leftJoin('tenants', 'tenants.id', 'platform_audit_log.tenant_id')
    .select([
      'platform_audit_log.id as id',
      'platform_audit_log.at as at',
      'platform_audit_log.action as action',
      'platform_audit_log.detail as detail',
      'platform_audit_log.ip as ip',
      'platform_admins.username as admin',
      'tenants.slug as tenant',
    ])
    .orderBy('platform_audit_log.id', 'desc')
    .limit(opts.limit);
  if (opts.tenantId) q = q.where('platform_audit_log.tenant_id', '=', opts.tenantId);
  return q.execute();
}
