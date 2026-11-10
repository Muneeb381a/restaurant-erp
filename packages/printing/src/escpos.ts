/**
 * Minimal ESC/POS command builder (Epson-compatible thermal printers; also Xprinter, Rongta, …).
 * Text mode is single-byte: only printable ASCII is sent; anything else becomes "?"
 * (Urdu is rendered as a bitmap by the receipt renderer, never as text — ARCHITECTURE §8).
 */

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

export type Align = 'left' | 'center' | 'right';

/** Paper width in printable characters (Font A): 80 mm ≈ 48 columns, 58 mm ≈ 32. */
export const COLUMNS = { 58: 32, 80: 48 } as const;
export type PaperMm = keyof typeof COLUMNS;

/** Printable ASCII only; control characters and everything above 0x7E become "?". */
export function toAscii(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    out += code >= 0x20 && code <= 0x7e ? ch : ch === '\t' ? ' ' : '?';
  }
  return out;
}

export class EscPos {
  private readonly bytes: number[] = [];

  /** Reset printer to defaults (ESC @). Always the first command of a ticket. */
  init(): this {
    this.bytes.push(ESC, 0x40);
    return this;
  }

  align(a: Align): this {
    this.bytes.push(ESC, 0x61, a === 'left' ? 0 : a === 'center' ? 1 : 2);
    return this;
  }

  bold(on: boolean): this {
    this.bytes.push(ESC, 0x45, on ? 1 : 0);
    return this;
  }

  /** Character size multiplier (GS !): width and height 1–4. */
  size(width: 1 | 2 | 3 | 4 = 1, height: 1 | 2 | 3 | 4 = 1): this {
    this.bytes.push(GS, 0x21, ((width - 1) << 4) | (height - 1));
    return this;
  }

  /** White-on-black printing (GS B). */
  invert(on: boolean): this {
    this.bytes.push(GS, 0x42, on ? 1 : 0);
    return this;
  }

  text(s: string): this {
    for (const ch of toAscii(s)) this.bytes.push(ch.charCodeAt(0));
    return this;
  }

  line(s = ''): this {
    return this.text(s).feed(0);
  }

  /** Line feed, then `extra` more blank lines. */
  feed(extra = 0): this {
    this.bytes.push(LF);
    if (extra > 0) this.bytes.push(ESC, 0x64, extra);
    return this;
  }

  rule(columns: number, ch = '-'): this {
    return this.line(ch.repeat(columns));
  }

  /** Partial cut after feeding the paper past the cutter (GS V 66 n). */
  cut(): this {
    this.bytes.push(GS, 0x56, 0x42, 0x00);
    return this;
  }

  /** Open the cash drawer connected to the printer (ESC p 0 25 250). */
  drawerKick(): this {
    this.bytes.push(ESC, 0x70, 0x00, 0x19, 0xfa);
    return this;
  }

  build(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

/** Left text + right text on one line of `columns` characters (right text wins on overflow). */
export function twoColumns(left: string, right: string, columns: number): string {
  const l = toAscii(left);
  const r = toAscii(right);
  const room = columns - r.length - 1;
  const clipped = l.length > room ? l.slice(0, Math.max(0, room)) : l;
  return clipped + ' '.repeat(Math.max(1, columns - clipped.length - r.length)) + r;
}

/** Word-wraps `text` to `width`, indenting continuation lines by `indent` spaces. */
export function wrap(text: string, width: number, indent = 0): string[] {
  const words = toAscii(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const prefix = lines.length === 0 ? '' : ' '.repeat(indent);
    const room = width - prefix.length;
    if (current === '') {
      current = word;
    } else if ((current + ' ' + word).length <= room) {
      current += ' ' + word;
    } else {
      lines.push(prefix + current);
      current = word;
    }
    // hard-split a word that is longer than a whole line
    while (current.length > width - (lines.length === 0 ? 0 : indent)) {
      const cut = width - (lines.length === 0 ? 0 : indent);
      lines.push((lines.length === 0 ? '' : ' '.repeat(indent)) + current.slice(0, cut));
      current = current.slice(cut);
    }
  }
  if (current !== '' || lines.length === 0)
    lines.push((lines.length === 0 ? '' : ' '.repeat(indent)) + current);
  return lines;
}

/**
 * Human-readable rendering of an ESC/POS byte stream for tests and logs:
 * control sequences become tags (`<INIT>`, `<BOLD:1>`, `<SIZE:2x2>`, `<CUT>`), text stays text.
 */
export function describe(bytes: Uint8Array): string {
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    const cmd = bytes[i + 1];
    const arg = bytes[i + 2]!;
    // [tag, extra bytes consumed after the 2-byte command]
    let tag: string | null = null;
    let extra = 0;
    if (b === ESC && cmd === 0x40) {
      tag = '<INIT>';
    } else if (b === ESC && cmd === 0x61) {
      tag = `<ALIGN:${['left', 'center', 'right'][arg] ?? '?'}>`;
      extra = 1;
    } else if (b === ESC && cmd === 0x45) {
      tag = `<BOLD:${arg}>`;
      extra = 1;
    } else if (b === ESC && cmd === 0x64) {
      tag = `<FEED:${arg}>`;
      extra = 1;
    } else if (b === ESC && cmd === 0x70) {
      tag = '<DRAWER>';
      extra = 3;
    } else if (b === GS && cmd === 0x21) {
      tag = `<SIZE:${(arg >> 4) + 1}x${(arg & 0x0f) + 1}>`;
      extra = 1;
    } else if (b === GS && cmd === 0x42) {
      tag = `<INVERT:${arg}>`;
      extra = 1;
    } else if (b === GS && cmd === 0x56) {
      tag = '<CUT>';
      extra = 2;
    }

    if (tag !== null) {
      out.push(tag);
      i += 1 + extra;
    } else {
      out.push(b === LF ? '\n' : String.fromCharCode(b));
    }
  }
  return out.join('');
}
