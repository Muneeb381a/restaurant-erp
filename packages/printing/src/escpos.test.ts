import { describe, expect, it } from 'vitest';
import { COLUMNS, EscPos, describe as describeBytes, toAscii, twoColumns, wrap } from './escpos';

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');

describe('EscPos builder emits the exact ESC/POS command bytes', () => {
  it('init, align, bold, size, invert', () => {
    expect(hex(new EscPos().init().build())).toBe('1b 40');
    expect(hex(new EscPos().align('left').align('center').align('right').build())).toBe(
      '1b 61 00 1b 61 01 1b 61 02',
    );
    expect(hex(new EscPos().bold(true).bold(false).build())).toBe('1b 45 01 1b 45 00');
    expect(hex(new EscPos().size().size(2, 2).size(4, 3).build())).toBe(
      '1d 21 00 1d 21 11 1d 21 32',
    );
    expect(hex(new EscPos().invert(true).invert(false).build())).toBe('1d 42 01 1d 42 00');
  });

  it('text, lines, feed, rule, cut and drawer kick', () => {
    expect(hex(new EscPos().text('Hi').build())).toBe('48 69');
    expect(hex(new EscPos().line('A').build())).toBe('41 0a');
    expect(hex(new EscPos().feed().build())).toBe('0a');
    expect(hex(new EscPos().feed(3).build())).toBe('0a 1b 64 03');
    expect(new EscPos().rule(4).build()).toEqual(new EscPos().line('----').build());
    expect(new EscPos().rule(3, '=').build()).toEqual(new EscPos().line('===').build());
    expect(hex(new EscPos().cut().build())).toBe('1d 56 42 00');
    expect(hex(new EscPos().drawerKick().build())).toBe('1b 70 00 19 fa');
  });
});

describe('toAscii', () => {
  it('keeps printable ASCII, turns tabs into spaces, everything else into "?"', () => {
    expect(toAscii('Chicken Karahi (Half)')).toBe('Chicken Karahi (Half)');
    expect(toAscii('a\tb')).toBe('a b');
    expect(toAscii('چکن')).toBe('???');
    expect(toAscii('x\ny\u0007')).toBe('x?y?');
    expect(toAscii('café')).toBe('caf?');
    expect(toAscii('😀')).toBe('?'); // one placeholder per character, not per UTF-16 unit
  });

  it('never lets a non-ASCII byte reach the printer', () => {
    const bytes = new EscPos().text('Urdu: اردو é 😀').build();
    expect([...bytes].every((b) => b >= 0x20 && b <= 0x7e)).toBe(true);
  });
});

describe('twoColumns', () => {
  it('pads between left and right text to the full width', () => {
    expect(twoColumns('Table T1', 'Order #7', 20)).toBe('Table T1    Order #7');
    expect(twoColumns('A', 'B', 5)).toBe('A   B');
  });

  it('clips the left text so the right text always fits, keeping at least one space', () => {
    expect(twoColumns('A very long left side', '19:42', 16)).toBe('A very lon 19:42');
    expect(twoColumns('abc', '12345', 8)).toBe('ab 12345');
    expect(twoColumns('abc', '123456789', 8)).toBe(' 123456789'); // right text wins, never truncated
  });
});

describe('wrap', () => {
  it('wraps on word boundaries and indents continuation lines', () => {
    expect(wrap('Chicken Tikka Leg Piece Special', 14, 4)).toEqual([
      'Chicken Tikka',
      '    Leg Piece',
      '    Special',
    ]);
    expect(wrap('short', 10)).toEqual(['short']);
  });

  it('splits words longer than a line, and handles empty text', () => {
    expect(wrap('Supercalifragilistic', 8)).toEqual(['Supercal', 'ifragili', 'stic']);
    expect(wrap('ab Supercalifragilistic', 8, 2)).toEqual([
      'ab',
      '  Superc',
      '  alifra',
      '  gilist',
      '  ic',
    ]);
    expect(wrap('', 10)).toEqual(['']);
    expect(wrap('   ', 10)).toEqual(['']);
  });

  it('replaces non-ASCII text before measuring', () => {
    expect(wrap('اردو', 10)).toEqual(['????']);
  });
});

describe('describe(): readable view of a byte stream', () => {
  it('shows every supported command as a tag and text verbatim', () => {
    const bytes = new EscPos()
      .init()
      .align('center')
      .bold(true)
      .size(2, 3)
      .invert(true)
      .line('HI')
      .feed(2)
      .drawerKick()
      .cut()
      .build();
    expect(describeBytes(bytes)).toBe(
      '<INIT><ALIGN:center><BOLD:1><SIZE:2x3><INVERT:1>HI\n\n<FEED:2><DRAWER><CUT>',
    );
  });

  it('marks unknown alignment values', () => {
    expect(describeBytes(Uint8Array.from([0x1b, 0x61, 9]))).toBe('<ALIGN:?>');
  });

  it('exposes the column counts for 58 and 80 mm paper', () => {
    expect(COLUMNS).toEqual({ 58: 32, 80: 48 });
  });
});
