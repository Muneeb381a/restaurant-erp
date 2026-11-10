import { describe, expect, it } from 'vitest';
import { asPaisa } from '../money';
import { PriceError, dayBefore, findPrice, resolvePrice, type PriceRow } from './price';

const row = (over: Partial<PriceRow> = {}): PriceRow => ({
  variantId: 'v1',
  priceListId: 'dine',
  pricePaisa: asPaisa(100000),
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  ...over,
});

describe('findPrice', () => {
  it('returns the price for the matching variant and price list', () => {
    const rows = [row(), row({ priceListId: 'delivery', pricePaisa: asPaisa(120000) })];
    expect(findPrice(rows, 'v1', 'dine', '2026-06-01')).toBe(100000);
    expect(findPrice(rows, 'v1', 'delivery', '2026-06-01')).toBe(120000);
  });

  it('returns null when the item has no price on that channel (not sold there)', () => {
    expect(findPrice([row()], 'v1', 'takeaway', '2026-06-01')).toBeNull();
    expect(findPrice([row()], 'other', 'dine', '2026-06-01')).toBeNull();
    expect(findPrice([], 'v1', 'dine', '2026-06-01')).toBeNull();
  });

  it('has inclusive boundaries on both ends', () => {
    const rows = [row({ effectiveFrom: '2026-03-01', effectiveTo: '2026-03-31' })];
    expect(findPrice(rows, 'v1', 'dine', '2026-02-28')).toBeNull();
    expect(findPrice(rows, 'v1', 'dine', '2026-03-01')).toBe(100000);
    expect(findPrice(rows, 'v1', 'dine', '2026-03-31')).toBe(100000);
    expect(findPrice(rows, 'v1', 'dine', '2026-04-01')).toBeNull();
  });

  it('treats a future-dated price as not yet active and switches exactly on the effective date', () => {
    const rows = [
      row({ effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30' }),
      row({ pricePaisa: asPaisa(110000), effectiveFrom: '2026-07-01' }),
    ];
    expect(findPrice(rows, 'v1', 'dine', '2026-06-30')).toBe(100000);
    expect(findPrice(rows, 'v1', 'dine', '2026-07-01')).toBe(110000);
    expect(findPrice(rows, 'v1', 'dine', '2030-01-01')).toBe(110000);
  });

  it('refuses to guess when two prices overlap', () => {
    const rows = [row(), row({ pricePaisa: asPaisa(1), effectiveFrom: '2026-02-01' })];
    expect(() => findPrice(rows, 'v1', 'dine', '2026-03-01')).toThrow(PriceError);
    try {
      findPrice(rows, 'v1', 'dine', '2026-03-01');
    } catch (e) {
      expect((e as PriceError).code).toBe('PRICE_AMBIGUOUS');
    }
  });

  it('rejects malformed dates', () => {
    for (const bad of ['2026-1-1', '01/02/2026', '2026-01-01T00:00:00Z', '']) {
      expect(() => findPrice([row()], 'v1', 'dine', bad)).toThrow(PriceError);
    }
  });

  it('zero is a valid price (free item), distinct from "no price"', () => {
    expect(findPrice([row({ pricePaisa: asPaisa(0) })], 'v1', 'dine', '2026-06-01')).toBe(0);
  });
});

describe('resolvePrice', () => {
  it('returns the price when present', () => {
    expect(resolvePrice([row()], 'v1', 'dine', '2026-06-01')).toBe(100000);
  });

  it('throws PRICE_MISSING when there is none', () => {
    try {
      resolvePrice([row()], 'v1', 'takeaway', '2026-06-01');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(PriceError);
      expect((e as PriceError).code).toBe('PRICE_MISSING');
    }
  });
});

describe('dayBefore', () => {
  it('handles month, year and leap-day boundaries', () => {
    expect(dayBefore('2026-03-15')).toBe('2026-03-14');
    expect(dayBefore('2026-03-01')).toBe('2026-02-28');
    expect(dayBefore('2024-03-01')).toBe('2024-02-29');
    expect(dayBefore('2026-01-01')).toBe('2025-12-31');
  });

  it('rejects malformed dates', () => {
    expect(() => dayBefore('nope')).toThrow(PriceError);
  });
});
