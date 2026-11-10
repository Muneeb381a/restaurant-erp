import { hash, verify } from '@node-rs/argon2';
import { z } from 'zod';

/** Argon2id parameters. Defaults follow OWASP (19 MiB, t=2, p=1); tests pass cheaper ones. */
export interface HasherOptions {
  memoryCost: number; // KiB
  timeCost: number;
}

export const DEFAULT_HASHER_OPTIONS: HasherOptions = { memoryCost: 19456, timeCost: 2 };

// @node-rs/argon2 defaults to Argon2id (algorithm enum value 2); the const enum is not
// usable under isolatedModules so the numeric value is used.
const ARGON2ID = 2;

export interface PasswordHasher {
  hash(secret: string): Promise<string>;
  verify(storedHash: string, secret: string): Promise<boolean>;
}

export function createHasher(opts: HasherOptions = DEFAULT_HASHER_OPTIONS): PasswordHasher {
  return {
    hash: (secret) => hash(secret, { ...opts, algorithm: ARGON2ID, parallelism: 1 }),
    verify: async (storedHash, secret) => {
      try {
        return await verify(storedHash, secret);
      } catch {
        return false; // malformed hash must never throw into the login path
      }
    },
  };
}

/** PINs: 4–8 digits (quick login for waiters / cashiers). */
export const pinSchema = z.string().regex(/^\d{4,8}$/, 'PIN must be 4 to 8 digits');
/** Passwords: at least 8 characters (managers / owner). */
export const passwordSchema = z.string().min(8).max(200);
