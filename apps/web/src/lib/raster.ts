/**
 * Turns a colour picture into what a thermal printer prints: black or white dots, packed 8 to a byte
 * (MSB = leftmost dot, 1 = black). Floyd–Steinberg dithering, so a logo with shading or a photo
 * still reads as a picture instead of a black blot. Transparent pixels count as white paper.
 */
export function toRaster(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  if (width % 8 !== 0) throw new Error('the width must be a multiple of 8 dots');
  const lum = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const a = (rgba[i * 4 + 3] as number) / 255;
    const y =
      0.299 * (rgba[i * 4] as number) +
      0.587 * (rgba[i * 4 + 1] as number) +
      0.114 * (rgba[i * 4 + 2] as number);
    lum[i] = y * a + 255 * (1 - a); // over white
  }
  const widthBytes = width / 8;
  const out = new Uint8Array(widthBytes * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const old = lum[i] as number;
      const black = old < 128;
      if (black) out[y * widthBytes + (x >> 3)]! |= 0x80 >> (x & 7);
      const err = old - (black ? 0 : 255);
      if (x + 1 < width) lum[i + 1] = (lum[i + 1] as number) + (err * 7) / 16;
      if (y + 1 < height) {
        if (x > 0) lum[i + width - 1] = (lum[i + width - 1] as number) + (err * 3) / 16;
        lum[i + width] = (lum[i + width] as number) + (err * 5) / 16;
        if (x + 1 < width) lum[i + width + 1] = (lum[i + width + 1] as number) + err / 16;
      }
    }
  }
  return out;
}

/** The inverse, for showing a raster on screen ("this is how it prints"): a w × h RGBA picture. */
export function rasterToRgba(data: Uint8Array, width: number, height: number): Uint8ClampedArray {
  const widthBytes = width / 8;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const black = ((data[y * widthBytes + (x >> 3)] as number) & (0x80 >> (x & 7))) !== 0;
      const i = (y * width + x) * 4;
      const v = black ? 0 : 255;
      out[i] = v;
      out[i + 1] = v;
      out[i + 2] = v;
      out[i + 3] = 255;
    }
  }
  return out;
}

export const bytesToBase64 = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
