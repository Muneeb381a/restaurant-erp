import { describe, expect, it } from 'vitest';
import { redactSecrets } from './audit.service';

describe('redactSecrets', () => {
  it('redacts credential-looking keys at any depth, including inside arrays', () => {
    const out = redactSecrets({
      id: 'u1',
      password_hash: '$argon2id$...',
      nested: { pin_hash: 'x', refreshToken: 'abc', list: [{ secret: 's', ok: 1 }] },
    });
    expect(out).toEqual({
      id: 'u1',
      password_hash: '[REDACTED]',
      nested: {
        pin_hash: '[REDACTED]',
        refreshToken: '[REDACTED]',
        list: [{ secret: '[REDACTED]', ok: 1 }],
      },
    });
  });

  it('keeps booleans and nulls under secret-ish keys (they cannot leak a secret)', () => {
    expect(
      redactSecrets({ has_pin: true, has_password: false, passwordChanged: true, pin_hash: null }),
    ).toEqual({
      has_pin: true,
      has_password: false,
      passwordChanged: true,
      pin_hash: null,
    });
  });

  it('leaves dates, primitives and unrelated keys alone', () => {
    const d = new Date('2026-01-01T00:00:00Z');
    expect(redactSecrets({ at: d, n: 5, s: 'hello' })).toEqual({ at: d, n: 5, s: 'hello' });
    expect(redactSecrets('plain')).toBe('plain');
    expect(redactSecrets(null)).toBeNull();
  });
});
