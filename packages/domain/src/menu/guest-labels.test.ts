import { describe, expect, it } from 'vitest';
import { ALLERGENS, GUEST_TAGS, sniffImage } from './guest-labels';

const pad = (head: number[]): Uint8Array => Uint8Array.from([...head, ...new Array(16).fill(0)]);

describe('guest labels', () => {
  it('lists the codes the database accepts, without duplicates', () => {
    expect(new Set(GUEST_TAGS).size).toBe(GUEST_TAGS.length);
    expect(new Set(ALLERGENS).size).toBe(ALLERGENS.length);
    expect(GUEST_TAGS).toContain('HALAL');
    expect(ALLERGENS).toContain('NUTS');
  });

  it('recognises images by content, not by what the upload claims', () => {
    expect(sniffImage(pad([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(pad([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png');
    expect(
      sniffImage(
        Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0]),
      ),
    ).toBe('image/webp');
    expect(sniffImage(new TextEncoder().encode('<svg onload=alert(1)></svg>'))).toBeNull();
    expect(sniffImage(new TextEncoder().encode('GIF89a......'))).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
  });
});
