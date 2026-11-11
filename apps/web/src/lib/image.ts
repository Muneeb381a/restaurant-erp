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
