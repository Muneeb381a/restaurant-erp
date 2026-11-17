import { bytesToBase64, rasterToRgba, toRaster } from './raster';

/**
 * Shrinks a photo picked on a phone or camera (often 4000 px and several MB) to a JPEG that is
 * quick on restaurant Wi-Fi and fits the server's limit. Longest side `max` px; never enlarges.
 */
export async function shrinkImage(file: Blob, max = 800, quality = 0.82): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const g = canvas.getContext('2d');
  if (!g) throw new Error('canvas unavailable');
  g.fillStyle = '#fff'; // a transparent PNG becomes white instead of black in a JPEG
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  let q = quality;
  for (;;) {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', q),
    );
    if (!blob) throw new Error('could not encode the photo');
    if (blob.size <= 450_000 || q <= 0.4) return blob;
    q -= 0.12; // still too big: try a little smaller
  }
}

const blobOf = (canvas: HTMLCanvasElement, type: string, q?: number): Promise<Blob> =>
  new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('could not encode the picture'))),
      type,
      q,
    ),
  );

/** A profile photo: the middle square of the picture, `size` px, as a small JPEG. */
export async function avatarImage(file: Blob, size = 192): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('canvas unavailable');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, size, size);
  g.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    size,
    size,
  );
  bitmap.close();
  return blobOf(canvas, 'image/jpeg', 0.85);
}

export interface PreparedLogo {
  /** The picture for the screen, base64 PNG. */
  image: string;
  raster58: { height: number; data: string };
  raster80: { height: number; data: string };
  /** Data URLs of the black-and-white versions, to show how it prints. */
  preview58: string;
  preview80: string;
}

/** Paper widths in dots; the logo is fitted to at most this share of the width in height. */
const PAPER = { 58: 384, 80: 576 } as const;
const MAX_HEIGHT_SHARE = 0.45;

/**
 * Gets a logo ready: a PNG to show on screen, and a dithered black-and-white version for each thermal
 * paper width (the printer needs exactly 384 or 576 dots across). The picture keeps its shape and is
 * centred on white paper; a transparent background prints as paper.
 */
export async function prepareLogo(file: Blob): Promise<PreparedLogo> {
  const bitmap = await createImageBitmap(file);

  // on screen: at most 480 px wide, kept as PNG (a logo has flat colour) and small enough for the server
  const shown = async (): Promise<Blob> => {
    let width = Math.min(480, bitmap.width);
    for (;;) {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(width));
      c.height = Math.max(1, Math.round((bitmap.height * c.width) / bitmap.width));
      const g = c.getContext('2d');
      if (!g) throw new Error('canvas unavailable');
      g.drawImage(bitmap, 0, 0, c.width, c.height);
      const blob = await blobOf(c, 'image/png');
      if (blob.size <= 280_000 || width <= 120) return blob;
      width *= 0.75;
    }
  };

  const forPaper = (dots: number): { height: number; bits: Uint8Array } => {
    const maxH = Math.round(dots * MAX_HEIGHT_SHARE);
    const scale = Math.min(dots / bitmap.width, maxH / bitmap.height, 1.5);
    const w = Math.max(8, Math.round(bitmap.width * scale));
    const h = Math.max(8, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = dots;
    canvas.height = h + 8; // a little white below, so it does not touch the name
    const g = canvas.getContext('2d', { willReadFrequently: true });
    if (!g) throw new Error('canvas unavailable');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(bitmap, Math.round((dots - w) / 2), 0, w, h);
    const px = g.getImageData(0, 0, canvas.width, canvas.height);
    return { height: canvas.height, bits: toRaster(px.data, canvas.width, canvas.height) };
  };

  const png = await shown();
  const r58 = forPaper(PAPER[58]);
  const r80 = forPaper(PAPER[80]);
  bitmap.close();

  const preview = (r: { height: number; bits: Uint8Array }, dots: number): string => {
    const c = document.createElement('canvas');
    c.width = dots;
    c.height = r.height;
    const g = c.getContext('2d');
    if (!g) return '';
    const img = g.createImageData(dots, r.height);
    img.data.set(rasterToRgba(r.bits, dots, r.height));
    g.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  };

  return {
    image: bytesToBase64(new Uint8Array(await png.arrayBuffer())),
    raster58: { height: r58.height, data: bytesToBase64(r58.bits) },
    raster80: { height: r80.height, data: bytesToBase64(r80.bits) },
    preview58: preview(r58, PAPER[58]),
    preview80: preview(r80, PAPER[80]),
  };
}
