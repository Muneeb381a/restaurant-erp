import { describe, expect, it } from 'vitest';
import { describe as describeBytes } from './escpos';
import { renderTestPage } from './test-page';

describe('renderTestPage', () => {
  it('prints the printer name, paper width, time and a ruler on 80 mm paper', () => {
    expect(describeBytes(renderTestPage('Kitchen printer', '19:42', 80))).toMatchInlineSnapshot(`
      "<INIT><ALIGN:center><BOLD:1><SIZE:2x2>TEST PAGE
      <SIZE:1x1><BOLD:0><ALIGN:left>------------------------------------------------
      Printer                          Kitchen printer
      Paper                         80 mm (48 columns)
      Time                                       19:42
      ------------------------------------------------
      012345678901234567890123456789012345678901234567
      If readable: printer OK

      <FEED:3><CUT>"
    `);
  });

  it('fits 58 mm paper (32 columns)', () => {
    const lines = describeBytes(renderTestPage('Bar', '07:05', 58)).split('\n');
    expect(Math.max(...lines.map((l) => l.replace(/<[^>]+>/g, '').length))).toBeLessThanOrEqual(32);
    expect(lines.join('\n')).toContain('58 mm (32 columns)');
  });

  it('defaults to 80 mm', () => {
    expect(describeBytes(renderTestPage('P', '00:00'))).toContain('80 mm (48 columns)');
  });
});
