import { describe, expect, it } from 'vitest';
import {
  apiBase,
  appOrigin,
  detectMode,
  healthPath,
  routerBasename,
  storageKey,
  withApiBase,
} from './tenant';

describe('detectMode', () => {
  it('is always single-restaurant unless cloud is switched on', () => {
    expect(detectMode('/r/lahore-karahi/kitchen', false)).toEqual({ kind: 'single' });
    expect(detectMode('/platform', false)).toEqual({ kind: 'single' });
  });
  it('reads the restaurant code from the address', () => {
    expect(detectMode('/r/lahore-karahi', true)).toEqual({ kind: 'tenant', slug: 'lahore-karahi' });
    expect(detectMode('/r/lahore-karahi/', true)).toEqual({
      kind: 'tenant',
      slug: 'lahore-karahi',
    });
    expect(detectMode('/r/abc/order/1/pay', true)).toEqual({ kind: 'tenant', slug: 'abc' });
  });
  it('knows the platform admin pages and everything else is the landing page', () => {
    expect(detectMode('/platform', true)).toEqual({ kind: 'platform' });
    expect(detectMode('/platform/restaurants/1', true)).toEqual({ kind: 'platform' });
    for (const p of ['/', '/login', '/r', '/r/', '/r/ab', '/r/Bad_Code/x', '/platformer'])
      expect(detectMode(p, true), p).toEqual({ kind: 'landing' });
  });
});

describe('addresses for one restaurant', () => {
  const t = { kind: 'tenant', slug: 'lahore-karahi' } as const;
  it('prefixes the router and the API with the code', () => {
    expect(routerBasename(t)).toBe('/r/lahore-karahi');
    expect(apiBase(t)).toBe('/api/v1/r/lahore-karahi');
    expect(healthPath(t)).toBe('/api/v1/r/lahore-karahi/health');
  });
  it('leaves a single-restaurant install exactly as it was', () => {
    const s = { kind: 'single' } as const;
    expect(routerBasename(s)).toBe('');
    expect(apiBase(s)).toBe('/api/v1');
    expect(healthPath(s)).toBe('/health');
    expect(withApiBase('/api/v1/public/items/1/image?v=3', s)).toBe(
      '/api/v1/public/items/1/image?v=3',
    );
    expect(storageKey('erp-auth', s)).toBe('erp-auth');
  });
  it('rewrites server-built API paths (dish photos) and leaves other links alone', () => {
    expect(withApiBase('/api/v1/public/items/9/image?v=2', t)).toBe(
      '/api/v1/r/lahore-karahi/public/items/9/image?v=2',
    );
    expect(withApiBase('https://example.com/a.png', t)).toBe('https://example.com/a.png');
  });
  it('keeps two restaurants sessions apart in one browser', () => {
    expect(storageKey('erp-auth', t)).toBe('erp-auth:lahore-karahi');
    expect(storageKey('erp-auth', { kind: 'tenant', slug: 'other-place' })).not.toBe(
      storageKey('erp-auth', t),
    );
  });
  it('builds the restaurant link the QR code points at', () => {
    expect(appOrigin(t)).toMatch(/\/r\/lahore-karahi$/);
  });
});
