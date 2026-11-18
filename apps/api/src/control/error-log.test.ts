import { describe, expect, it } from 'vitest';
import { routeShape, slugOf } from './error-log';

describe('routeShape', () => {
  it('replaces ids and numbers, keeps the restaurant code, drops the query string', () => {
    expect(
      routeShape('/api/v1/r/acme/orders/6f1c2a3e-1111-4222-8333-944455556666/items/42?x=1&token=s'),
    ).toBe('/r/acme/orders/:id/items/:id');
  });
  it('keeps plain words and the platform paths', () => {
    expect(routeShape('/api/v1/platform/tenants')).toBe('/platform/tenants');
    expect(routeShape('/health')).toBe('/health');
  });
  it('never lets a long token through and is bounded', () => {
    expect(routeShape(`/api/v1/r/acme/x/${'a'.repeat(60)}`)).toBe('/r/acme/x/:id');
    expect(routeShape('/' + 'y/'.repeat(300)).length).toBeLessThanOrEqual(200);
  });
});

describe('slugOf', () => {
  it('reads the restaurant code of a cloud address', () => {
    expect(slugOf('/api/v1/r/acme-grill/orders')).toBe('acme-grill');
    expect(slugOf('/api/v1/r/acme')).toBe('acme');
    expect(slugOf('/api/v1/platform/tenants')).toBeNull();
  });
});
