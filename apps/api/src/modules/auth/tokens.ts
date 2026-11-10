import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { AppError } from '../../http/errors';

export interface AccessClaims {
  userId: string;
  sessionId: string;
}

const key = (secret: string): Uint8Array => new TextEncoder().encode(secret);

export async function signAccessToken(
  secret: string,
  claims: AccessClaims,
  ttlSeconds: number,
  now: Date,
): Promise<{ token: string; expiresAt: Date }> {
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + ttlSeconds;
  const token = await new SignJWT({ sid: claims.sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(key(secret));
  return { token, expiresAt: new Date(exp * 1000) };
}

/** Verifies signature + expiry. Any failure is a uniform 401 (no detail leaked). */
export async function verifyAccessToken(
  secret: string,
  token: string,
  now: Date,
): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(token, key(secret), {
      algorithms: ['HS256'],
      currentDate: now,
    });
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string')
      throw new Error('claims');
    return { userId: payload.sub, sessionId: payload.sid };
  } catch {
    throw new AppError(401, 'UNAUTHENTICATED', 'Invalid or expired access token');
  }
}

/** SHA-256 is appropriate for high-entropy random secrets (unlike human PINs, which use argon2id). */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function secureEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function randomSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** Refresh token wire format: `<sessionId>.<secret>`; only hash(secret) is stored. */
export function formatRefreshToken(sessionId: string, secret: string): string {
  return `${sessionId}.${secret}`;
}

export function parseRefreshToken(token: string): { sessionId: string; secret: string } | null {
  const m = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{20,100})$/.exec(token);
  return m ? { sessionId: m[1]!, secret: m[2]! } : null;
}
