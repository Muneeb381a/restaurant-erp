import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSecretBox, parseKey, tenantJwtSecret } from './secret-box';

const key = randomBytes(32).toString('base64');

describe('secret box', () => {
  const url =
    'postgresql://neondb_owner:p%40ss@ep-x-pooler.eu.aws.neon.tech/neondb?sslmode=require';

  it('round-trips and never stores the text in clear', () => {
    const box = createSecretBox(key);
    const stored = box.encrypt(url);
    expect(stored.startsWith('v1.')).toBe(true);
    expect(stored).not.toContain('neondb_owner');
    expect(stored).not.toContain('ep-x-pooler');
    expect(box.decrypt(stored)).toBe(url);
  });

  it('uses a fresh IV every time', () => {
    const box = createSecretBox(key);
    expect(box.encrypt(url)).not.toBe(box.encrypt(url));
  });

  it('detects any change to the stored text and a wrong key', () => {
    const box = createSecretBox(key);
    const parts = box.encrypt(url).split('.');
    const ct = Buffer.from(parts[3]!, 'base64url');
    ct[0] = ct[0]! ^ 1;
    parts[3] = ct.toString('base64url');
    expect(() => box.decrypt(parts.join('.'))).toThrow();
    const other = createSecretBox(randomBytes(32).toString('base64'));
    expect(() => other.decrypt(box.encrypt(url))).toThrow();
    expect(() => box.decrypt('not-a-secret')).toThrow();
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(() => parseKey(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
  });
});

describe('tenantJwtSecret', () => {
  it('is stable per restaurant and different between restaurants', () => {
    const master = 'm'.repeat(40);
    expect(tenantJwtSecret(master, 'a')).toBe(tenantJwtSecret(master, 'a'));
    expect(tenantJwtSecret(master, 'a')).not.toBe(tenantJwtSecret(master, 'b'));
    expect(tenantJwtSecret(master, 'a')).not.toBe(tenantJwtSecret('n'.repeat(40), 'a'));
    expect(tenantJwtSecret(master, 'a').length).toBeGreaterThanOrEqual(32);
  });
});
