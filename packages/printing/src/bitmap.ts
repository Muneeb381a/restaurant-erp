import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import { EscPos, type PaperMm } from './escpos';

/**
 * Receipts with Urdu are printed as a bitmap (ARCHITECTURE §8): thermal printers have no reliable
 * Urdu code page, and Urdu needs shaping and right-to-left layout. Text is drawn with Noto Naskh
 * Arabic (Urdu/Arabic script) and Noto Sans (Latin, digits), both SIL OFL fonts bundled in `fonts/`,
 * thresholded to 1 bit and sent as ESC/POS raster bands (GS v 0).
 */

/** Printable dots per line: 80 mm paper ≈ 576, 58 mm ≈ 384 (203 dpi). */
export const DOTS = { 58: 384, 80: 576 } as const;

const FONT_DIR = fileURLToPath(new URL('../fonts/', import.meta.url));
let fontsReady = false;
function ensureFonts(): void {
  if (fontsReady) return;
  GlobalFonts.registerFromPath(`${FONT_DIR}NotoNaskhArabic-Regular.ttf`, 'ErpNaskh');
  GlobalFonts.registerFromPath(`${FONT_DIR}NotoNaskhArabic-Bold.ttf`, 'ErpNaskhBold');
  GlobalFonts.registerFromPath(`${FONT_DIR}NotoSans-Regular.ttf`, 'ErpSans');
  GlobalFonts.registerFromPath(`${FONT_DIR}NotoSans-Bold.ttf`, 'ErpSansBold');
  fontsReady = true;
}

export interface TextStyle {
  /** Font size in dots (default 26 ≈ a normal receipt line). */
  size?: number;
  bold?: boolean;
  /** Right-to-left text (Urdu). */
  rtl?: boolean;
}
type Align = 'left' | 'center' | 'right';

interface Op {
  height: number;
  draw: (ctx: SKRSContext2D, y: number) => void;
}

const family = (bold: boolean): string =>
  bold ? '"ErpSansBold", "ErpNaskhBold"' : '"ErpSans", "ErpNaskh"';
const fontOf = (s: TextStyle): string => `${s.size ?? 26}px ${family(s.bold ?? false)}`;

/** Draws a receipt into a 1-bit raster. Lines are collected first so the height is known. */
export class BitmapDoc {
  private readonly ops: Op[] = [];
  private readonly measure: SKRSContext2D;

  constructor(readonly width: number) {
    ensureFonts();
    this.measure = createCanvas(width, 10).getContext('2d');
  }

  private widthOf(text: string, s: TextStyle): number {
    this.measure.font = fontOf(s);
    this.measure.direction = s.rtl ? 'rtl' : 'ltr';
    return this.measure.measureText(text).width;
  }

  /** Greedy word wrap to `max` dots (a single over-long word is left to overflow, never cut). */
  private wrap(text: string, max: number, s: TextStyle): string[] {
    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (cur && this.widthOf(next, s) > max) {
        lines.push(cur);
        cur = w;
      } else cur = next;
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  }

  private lineHeight(s: TextStyle): number {
    return Math.round((s.size ?? 26) * 1.45);
  }

  /** A block of (wrapped) text on its own lines. */
  text(text: string, style: TextStyle = {}, align: Align = 'left'): this {
    const lines = this.wrap(text, this.width, style);
    const lh = this.lineHeight(style);
    for (const line of lines)
      this.ops.push({
        height: lh,
        draw: (ctx, y) => {
          ctx.font = fontOf(style);
          ctx.direction = style.rtl ? 'rtl' : 'ltr';
          ctx.textBaseline = 'middle';
          const x = align === 'left' ? 0 : align === 'center' ? this.width / 2 : this.width;
          ctx.textAlign = align;
          ctx.fillText(line, x, y + lh / 2);
        },
      });
    return this;
  }

  /**
   * `label` at the reading start (left for LTR, right for RTL) and `value` at the opposite edge on the
   * last line — "Subtotal ........ 7,080". The label wraps if it does not fit next to the value.
   */
  row(label: string, value: string, style: TextStyle = {}, valueStyle: TextStyle = {}): this {
    // plain numbers read left to right; a value containing Urdu text keeps the row's direction
    const vs: TextStyle = {
      ...style,
      ...valueStyle,
      rtl: /[؀-ۿ]/.test(value) ? !!style.rtl : false,
    };
    const gap = 12;
    const valueWidth = value ? this.widthOf(value, vs) : 0;
    const lines = this.wrap(label, this.width - valueWidth - gap, style);
    const lh = this.lineHeight(style);
    lines.forEach((line, i) => {
      const last = i === lines.length - 1;
      this.ops.push({
        height: lh,
        draw: (ctx, y) => {
          ctx.textBaseline = 'middle';
          ctx.font = fontOf(style);
          ctx.direction = style.rtl ? 'rtl' : 'ltr';
          ctx.textAlign = style.rtl ? 'right' : 'left';
          ctx.fillText(line, style.rtl ? this.width : 0, y + lh / 2);
          if (last && value) {
            ctx.font = fontOf(vs);
            ctx.direction = vs.rtl ? 'rtl' : 'ltr';
            ctx.textAlign = style.rtl ? 'left' : 'right';
            ctx.fillText(value, style.rtl ? 0 : this.width, y + lh / 2);
          }
        },
      });
    });
    return this;
  }

  rule(): this {
    this.ops.push({
      height: 14,
      draw: (ctx, y) => {
        ctx.fillRect(0, y + 6, this.width, 2);
      },
    });
    return this;
  }

  space(dots: number): this {
    this.ops.push({ height: dots, draw: () => undefined });
    return this;
  }

  /**
   * A 1-bit picture (the logo), centred. `data` is `widthBytes * height` packed bytes, MSB = leftmost
   * dot, 1 = black; a picture narrower than the paper is centred, a wider one is cut at the edges.
   */
  raster(widthBytes: number, height: number, data: Uint8Array): this {
    const w = widthBytes * 8;
    this.ops.push({
      height,
      draw: (ctx, y) => {
        const img = ctx.createImageData(w, height);
        for (let row = 0; row < height; row++) {
          for (let x = 0; x < w; x++) {
            const black = ((data[row * widthBytes + (x >> 3)] as number) & (0x80 >> (x & 7))) !== 0;
            const i = (row * w + x) * 4;
            const v = black ? 0 : 255;
            img.data[i] = v;
            img.data[i + 1] = v;
            img.data[i + 2] = v;
            img.data[i + 3] = 255;
          }
        }
        ctx.putImageData(img, Math.round((this.width - w) / 2), y);
      },
    });
    return this;
  }

  /** Renders to a canvas (white background, black ink). */
  toCanvas(): Canvas {
    const height = Math.max(
      1,
      this.ops.reduce((n, o) => n + o.height, 0),
    );
    const canvas = createCanvas(this.width, height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, this.width, height);
    ctx.fillStyle = '#000';
    let y = 0;
    for (const op of this.ops) {
      op.draw(ctx, y);
      y += op.height;
    }
    return canvas;
  }

  /** Packed 1-bit rows (MSB = leftmost dot, 1 = black), `width / 8` bytes per row. */
  toBits(): { widthBytes: number; height: number; data: Uint8Array } {
    const canvas = this.toCanvas();
    const { width, height } = canvas;
    const px = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    const widthBytes = Math.ceil(width / 8);
    const data = new Uint8Array(widthBytes * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const lum =
          0.299 * (px[i] as number) + 0.587 * (px[i + 1] as number) + 0.114 * (px[i + 2] as number);
        if (lum < 150) data[y * widthBytes + (x >> 3)]! |= 0x80 >> (x & 7);
      }
    }
    return { widthBytes, height, data };
  }

  /** A complete ticket: optional drawer pulse, the bitmap, feed and cut. */
  toEscPos(opts: { openDrawer?: boolean } = {}): Uint8Array {
    const { widthBytes, height, data } = this.toBits();
    const p = new EscPos().init();
    if (opts.openDrawer) p.drawerKick();
    p.raster(widthBytes, height, data).feed(3).cut();
    return p.build();
  }
}

export const bitmapWidth = (paperMm: PaperMm): number => DOTS[paperMm];
