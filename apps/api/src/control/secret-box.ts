import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

/**
 * Encrypts small secrets (a restaurant's database connection string) before they are stored in the
 * control database. AES-256-GCM: the tag makes any change to the stored text detectable, and every
 * value gets its own random IV. Format: `v1.<iv>.<tag>.<ciphertext>` (base64url).
 */
export interface SecretBox {
  encrypt(plain: string): string;
  decrypt(stored: string): string;
}

export function parseKey(base64: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32)
    throw new Error('TENANT_SECRET_KEY must be 32 bytes in base64 (openssl rand -base64 32)');
  return key;
}

export function createSecretBox(keyBase64: string): SecretBox {
  const key = parseKey(keyBase64);
  return {
    encrypt(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return ['v1', iv, cipher.getAuthTag(), ct]
        .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
        .join('.');
    },
    decrypt(stored) {
      const [version, iv, tag, ct] = stored.split('.');
      if (version !== 'v1' || !iv || !tag || !ct) throw new Error('Unrecognised secret format');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(ct, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}

/**
 * One signing secret per restaurant, derived from the platform secret and the restaurant's id. A
 * login token from restaurant A therefore fails the signature check at restaurant B even though
 * both are served by the same API.
 */
export function tenantJwtSecret(masterSecret: string, tenantId: string): string {
  return createHmac('sha256', masterSecret).update(`tenant-jwt:${tenantId}`).digest('hex');
}
