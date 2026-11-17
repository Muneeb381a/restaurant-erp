import { describe, expect, it } from 'vitest';
import { bytesToBase64, rasterToRgba, toRaster } from './raster';

const solid = (w: number, h: number, rgba: [number, number, number, number]): Uint8ClampedArray => {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) a.set(rgba, i * 4);
  return a;
};
const ink = (bits: Uint8Array): number =>
  bits.reduce((n, b) => n + b.toString(2).replace(/0/g, '').length, 0);

describe('toRaster', () => {
  it('black is all ink, white and transparent are none', () => {
    expect(ink(toRaster(solid(16, 4, [0, 0, 0, 255]), 16, 4))).toBe(64);
    expect(ink(toRaster(solid(16, 4, [255, 255, 255, 255]), 16, 4))).toBe(0);
    expect(ink(toRaster(solid(16, 4, [0, 0, 0, 0]), 16, 4))).toBe(0); // transparent = paper
  });

  it('packs 8 dots to a byte, leftmost dot in the top bit', () => {
    // 8 wide, 1 row: only the first pixel black
    const px = solid(8, 1, [255, 255, 255, 255]);
    px.set([0, 0, 0, 255], 0);
    expect(Array.from(toRaster(px, 8, 1))).toEqual([0b1000_0000]);
  });

  it('mid grey becomes about half ink (dithered), not a solid block', () => {
    const bits = toRaster(solid(64, 32, [128, 128, 128, 255]), 64, 32);
    const dots = 64 * 32;
    expect(ink(bits)).toBeGreaterThan(dots * 0.4);
    expect(ink(bits)).toBeLessThan(dots * 0.6);
  });

  it('needs a width that fills whole bytes', () => {
    expect(() => toRaster(solid(10, 2, [0, 0, 0, 255]), 10, 2)).toThrow();
  });
});

describe('rasterToRgba and bytesToBase64', () => {
  it('round-trips the picture for the on-screen preview', () => {
    const bits = new Uint8Array([0b1010_0000]);
    const rgba = rasterToRgba(bits, 8, 1);
    expect(Array.from(rgba.slice(0, 4))).toEqual([0, 0, 0, 255]);
    expect(Array.from(rgba.slice(4, 8))).toEqual([255, 255, 255, 255]);
    expect(Array.from(toRaster(rgba, 8, 1))).toEqual([0b1010_0000]);
  });

  it('encodes big arrays without blowing the call stack', () => {
    const big = new Uint8Array(200_000).fill(65);
    expect(bytesToBase64(big).length).toBe(Math.ceil(200_000 / 3) * 4);
    expect(bytesToBase64(new Uint8Array([72, 105]))).toBe('SGk=');
  });
});
