import { randomUUID } from 'node:crypto';
import type { AppContext, Principal } from '../../http/context';
import { AppError } from '../../http/errors';
import { withTx } from '../../shared/tx';
import { writeAudit } from '../audit/audit.service';
import { CLEAN_STATE, isLocked, onFailure, type LockState } from './lockout';
import type { PasswordHasher } from './password';
import {
  formatRefreshToken,
  hashSecret,
  parseRefreshToken,
  randomSecret,
  secureEquals,
  signAccessToken,
} from './tokens';

export interface LoginInput {
  username: string;
  secret: string;
  kind: 'password' | 'pin';
  deviceToken?: string | undefined;
  ip?: string | undefined;
}

export interface TokenPair {
  accessToken: string;
  accessExpiresAt: Date;
  refreshToken: string;
  refreshExpiresAt: Date;
}

// Verified against when the user does not exist, so response time does not reveal valid usernames.
const dummyHashes = new WeakMap<PasswordHasher, Promise<string>>();
function dummyHash(h: PasswordHasher): Promise<string> {
  let p = dummyHashes.get(h);
  if (!p) {
    p = h.hash(randomSecret());
    dummyHashes.set(h, p);
  }
  return p;
}

const invalid = (): AppError =>
  new AppError(401, 'INVALID_CREDENTIALS', 'Invalid username or credentials');

async function resolveDevice(ctx: AppContext, deviceToken: string | undefined) {
  if (!deviceToken) return null;
  const device = await ctx.db
    .selectFrom('devices')
    .select(['id', 'branch_id'])
    .where('token_hash', '=', hashSecret(deviceToken))
    .where('is_active', '=', true)
    .executeTakeFirst();
  if (!device) throw new AppError(401, 'DEVICE_INVALID', 'Unknown or revoked device');
  return device;
}

async function issueTokens(
  ctx: AppContext,
  userId: string,
  sessionId: string,
  refreshSecret: string,
  now: Date,
): Promise<TokenPair> {
  const access = await signAccessToken(
    ctx.auth.jwtSecret,
    { userId, sessionId },
    ctx.auth.accessTtlSeconds,
    now,
  );
  return {
    accessToken: access.token,
    accessExpiresAt: access.expiresAt,
    refreshToken: formatRefreshToken(sessionId, refreshSecret),
    refreshExpiresAt: new Date(now.getTime() + ctx.auth.refreshTtlSeconds * 1000),
  };
}

type TxOutcome = { ok: true; tokens: TokenPair } | { ok: false; error: AppError };

export async function login(ctx: AppContext, input: LoginInput): Promise<TokenPair> {
  const username = input.username.trim().toLowerCase();
  const device = await resolveDevice(ctx, input.deviceToken);
  const now = ctx.clock.now();

  const outcome = await withTx(ctx.db, async (trx): Promise<TxOutcome> => {
    // Row lock serialises concurrent guesses for the same account, so the counter cannot be raced.
    const user = await trx
      .selectFrom('users')
      .selectAll()
      .where('username', '=', username)
      .forUpdate()
      .executeTakeFirst();

    if (!user || !user.is_active) {
      await ctx.hasher.verify(await dummyHash(ctx.hasher), input.secret);
      await writeAudit(trx, {
        action: 'LOGIN_FAILED',
        entity: 'user',
        reason: 'unknown_or_inactive',
        ip: input.ip,
      });
      return { ok: false, error: invalid() };
    }

    const state: LockState = {
      failedAttempts: user.failed_attempts,
      lastFailedAt: user.last_failed_at,
      lockedUntil: user.locked_until,
    };
    if (isLocked(state, now)) {
      await writeAudit(trx, {
        branchId: user.branch_id,
        userId: user.id,
        action: 'LOGIN_BLOCKED_LOCKED',
        entity: 'user',
        entityId: user.id,
        ip: input.ip,
      });
      const retryAfterSeconds = Math.ceil((state.lockedUntil!.getTime() - now.getTime()) / 1000);
      return {
        ok: false,
        error: new AppError(423, 'ACCOUNT_LOCKED', 'Account temporarily locked', {
          retryAfterSeconds,
        }),
      };
    }

    const stored = input.kind === 'pin' ? user.pin_hash : user.password_hash;
    const good = stored
      ? await ctx.hasher.verify(stored, input.secret)
      : (await ctx.hasher.verify(await dummyHash(ctx.hasher), input.secret), false);

    if (!good || (device && user.branch_id && device.branch_id !== user.branch_id)) {
      const next = onFailure(state, now);
      await trx
        .updateTable('users')
        .set({
          failed_attempts: next.failedAttempts,
          last_failed_at: next.lastFailedAt,
          locked_until: next.lockedUntil,
        })
        .where('id', '=', user.id)
        .execute();
      await writeAudit(trx, {
        branchId: user.branch_id,
        userId: user.id,
        action: next.lockedUntil ? 'LOGIN_LOCKED' : 'LOGIN_FAILED',
        entity: 'user',
        entityId: user.id,
        after: { failedAttempts: next.failedAttempts },
        ip: input.ip,
      });
      return { ok: false, error: invalid() };
    }

    await trx
      .updateTable('users')
      .set({
        failed_attempts: CLEAN_STATE.failedAttempts,
        last_failed_at: null,
        locked_until: null,
      })
      .where('id', '=', user.id)
      .execute();

    const sessionId = randomUUID();
    const refreshSecret = randomSecret();
    const tokens = await issueTokens(ctx, user.id, sessionId, refreshSecret, now);
    await trx
      .insertInto('sessions')
      .values({
        id: sessionId,
        user_id: user.id,
        device_id: device?.id ?? null,
        refresh_hash: hashSecret(refreshSecret),
        expires_at: tokens.refreshExpiresAt,
      })
      .execute();
    await writeAudit(trx, {
      branchId: user.branch_id,
      userId: user.id,
      deviceId: device?.id ?? null,
      action: 'LOGIN',
      entity: 'session',
      entityId: sessionId,
      after: { method: input.kind },
      ip: input.ip,
    });
    return { ok: true, tokens };
  });

  if (!outcome.ok) throw outcome.error;
  return outcome.tokens;
}

/** Rotating refresh: each use replaces the secret. Presenting an old secret revokes the session. */
export async function refresh(
  ctx: AppContext,
  refreshToken: string,
  ip?: string,
): Promise<TokenPair> {
  const parsed = parseRefreshToken(refreshToken);
  if (!parsed) throw new AppError(401, 'UNAUTHENTICATED', 'Invalid refresh token');
  const now = ctx.clock.now();

  const outcome = await withTx(ctx.db, async (trx): Promise<TxOutcome> => {
    const session = await trx
      .selectFrom('sessions')
      .innerJoin('users', 'users.id', 'sessions.user_id')
      .select([
        'sessions.id as id',
        'sessions.user_id as user_id',
        'sessions.refresh_hash as refresh_hash',
        'sessions.expires_at as expires_at',
        'sessions.revoked_at as revoked_at',
        'sessions.device_id as device_id',
        'users.is_active as user_active',
        'users.branch_id as branch_id',
      ])
      .where('sessions.id', '=', parsed.sessionId)
      .forUpdate('sessions')
      .executeTakeFirst();

    const unauth = {
      ok: false,
      error: new AppError(401, 'UNAUTHENTICATED', 'Invalid refresh token'),
    } as const;
    if (!session || session.revoked_at || session.expires_at.getTime() <= now.getTime())
      return unauth;

    if (!secureEquals(hashSecret(parsed.secret), session.refresh_hash)) {
      // A superseded secret was replayed: assume theft and kill the session.
      await trx
        .updateTable('sessions')
        .set({ revoked_at: now })
        .where('id', '=', session.id)
        .execute();
      await writeAudit(trx, {
        branchId: session.branch_id,
        userId: session.user_id,
        action: 'REFRESH_REUSE_DETECTED',
        entity: 'session',
        entityId: session.id,
        ip,
      });
      return {
        ok: false,
        error: new AppError(401, 'REFRESH_REUSED', 'Refresh token reuse detected; session revoked'),
      };
    }
    if (!session.user_active) {
      await trx
        .updateTable('sessions')
        .set({ revoked_at: now })
        .where('id', '=', session.id)
        .execute();
      return unauth;
    }

    const refreshSecret = randomSecret();
    const tokens = await issueTokens(ctx, session.user_id, session.id, refreshSecret, now);
    await trx
      .updateTable('sessions')
      .set({ refresh_hash: hashSecret(refreshSecret), expires_at: tokens.refreshExpiresAt })
      .where('id', '=', session.id)
      .execute();
    return { ok: true, tokens };
  });

  if (!outcome.ok) throw outcome.error;
  return outcome.tokens;
}

export async function logout(ctx: AppContext, principal: Principal, ip?: string): Promise<void> {
  await withTx(ctx.db, async (trx) => {
    await trx
      .updateTable('sessions')
      .set({ revoked_at: ctx.clock.now() })
      .where('id', '=', principal.sessionId)
      .where('revoked_at', 'is', null)
      .execute();
    await writeAudit(trx, {
      branchId: principal.userBranchId,
      userId: principal.userId,
      deviceId: principal.deviceId,
      action: 'LOGOUT',
      entity: 'session',
      entityId: principal.sessionId,
      ip,
    });
  });
}

/** Revokes every session of a user (deactivation, credential reset). Call inside the caller's tx. */
export async function revokeAllSessions(
  trx: Parameters<Parameters<typeof withTx>[1]>[0],
  userId: string,
  now: Date,
): Promise<void> {
  await trx
    .updateTable('sessions')
    .set({ revoked_at: now })
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .execute();
}
