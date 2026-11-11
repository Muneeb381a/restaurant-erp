import qrcode from 'qrcode-generator';
import { useMemo } from 'react';

/**
 * A QR code drawn as one SVG path (no image, no network). Always dark on white with a 4-module
 * quiet zone, whatever the theme: a phone camera needs the contrast and the white border.
 * Error correction M survives a smudge or a fold on a printed table tent.
 */
export function qrModules(text: string): boolean[][] {
  const qr = qrcode(0, 'M'); // type 0 = smallest version that fits
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

const QUIET = 4;

export function QrCode({
  text,
  size = 240,
  className = '',
  label,
}: {
  text: string;
  size?: number;
  className?: string;
  label: string;
}) {
  const modules = useMemo(() => qrModules(text), [text]);
  const n = modules.length;
  const path = useMemo(() => {
    let d = '';
    modules.forEach((row, r) =>
      row.forEach((dark, c) => {
        if (dark) d += `M${c + QUIET} ${r + QUIET}h1v1h-1z`;
      }),
    );
    return d;
  }, [modules]);
  const full = n + QUIET * 2;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${full} ${full}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className={className}
      style={{ maxWidth: '100%', height: 'auto' }}
    >
      <rect width={full} height={full} fill="#fff" />
      <path d={path} fill="#1b1814" />
    </svg>
  );
}

/** PNG of the same code (for sending on WhatsApp or giving to a printer): drawn straight from the modules. */
export function qrPngBlob(text: string, px = 1024): Promise<Blob | null> {
  const modules = qrModules(text);
  const full = modules.length + QUIET * 2;
  const cell = Math.max(1, Math.floor(px / full));
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = cell * full;
  const g = canvas.getContext('2d');
  if (!g) return Promise.resolve(null);
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#1b1814';
  modules.forEach((row, r) =>
    row.forEach((dark, c) => {
      if (dark) g.fillRect((c + QUIET) * cell, (r + QUIET) * cell, cell, cell);
    }),
  );
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
}
