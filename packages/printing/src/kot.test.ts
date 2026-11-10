import { describe, expect, it } from 'vitest';
import { describe as describeBytes } from './escpos';
import { renderKot, type KotDoc } from './kot';

const base: KotDoc = {
  kind: 'KOT',
  kotNo: 12,
  station: 'BBQ',
  orderNo: 7,
  orderType: 'DINE_IN',
  tableCode: 'T1',
  waiter: 'Dev CAPTAIN',
  time: '19:42',
  lines: [
    { qty: 3, name: 'Chicken Tikka (Leg)', modifiers: [], note: 'less spicy' },
    { qty: 1, name: 'Chicken Karahi (Full)', modifiers: ['Extra hot', 'No onion'] },
  ],
};

const text = (doc: KotDoc, mm: 58 | 80 = 80): string => describeBytes(renderKot(doc, mm));

describe('KOT ticket (80 mm)', () => {
  it('prints station, table, order, waiter, time, lines, modifiers and notes', () => {
    expect(text(base)).toMatchInlineSnapshot(`
      "<INIT><ALIGN:left><BOLD:1><SIZE:2x2>KOT #12              BBQ
      <SIZE:1x1><BOLD:0><BOLD:1>Table T1                                Order #7
      <BOLD:0>Waiter: Dev CAPTAIN                        19:42
      ------------------------------------------------
      <BOLD:1><SIZE:1x2>3 x Chicken Tikka (Leg)
      <SIZE:1x1><BOLD:0>    "less spicy"
      <BOLD:1><SIZE:1x2>1 x Chicken Karahi (Full)
      <SIZE:1x1><BOLD:0>    + Extra hot
          + No onion
      ------------------------------------------------

      <FEED:3><CUT>"
    `);
  });

  it('weighed lines print grams, deal components print their deal, long names wrap', () => {
    const out = text({
      ...base,
      lines: [
        { qty: 1, name: 'Mutton Chops', weightG: 750, modifiers: [] },
        { qty: 4, name: 'Naan', modifiers: [], fromDeal: 'Family Deal' },
        {
          qty: 2,
          name: 'Chicken Malai Boti Special Platter With Extra Chutney And Salad',
          modifiers: [],
        },
      ],
    });
    expect(out).toMatchInlineSnapshot(`
      "<INIT><ALIGN:left><BOLD:1><SIZE:2x2>KOT #12              BBQ
      <SIZE:1x1><BOLD:0><BOLD:1>Table T1                                Order #7
      <BOLD:0>Waiter: Dev CAPTAIN                        19:42
      ------------------------------------------------
      <BOLD:1><SIZE:1x2>750 g Mutton Chops
      <SIZE:1x1><BOLD:0><BOLD:1><SIZE:1x2>4 x Naan
      <SIZE:1x1><BOLD:0>    (Family Deal)
      <BOLD:1><SIZE:1x2>2 x Chicken Malai Boti Special Platter With
          Extra Chutney And Salad
      <SIZE:1x1><BOLD:0>------------------------------------------------

      <FEED:3><CUT>"
    `);
  });

  it('RUSH tickets carry a banner', () => {
    expect(text({ ...base, rush: true })).toContain('*** RUSH ***');
    expect(text(base)).not.toContain('RUSH');
  });

  it('reprints are marked with their number, the original is not', () => {
    expect(text({ ...base, reprint: 2 })).toContain('** REPRINT #2 **');
    expect(text({ ...base, reprint: 0 })).not.toContain('REPRINT');
    expect(text(base)).not.toContain('REPRINT');
  });

  it('takeaway and delivery tickets say so instead of a table', () => {
    expect(text({ ...base, orderType: 'TAKEAWAY', tableCode: null })).toContain('TAKEAWAY');
    expect(text({ ...base, orderType: 'DELIVERY', tableCode: null })).toContain('DELIVERY');
    expect(text({ ...base, orderType: 'DINE_IN', tableCode: 'T9' })).toContain('Table T9');
    expect(text({ ...base, orderType: 'DINE_IN', tableCode: null })).toContain('DINE-IN');
  });

  it('works without a waiter', () => {
    expect(text({ ...base, waiter: null })).not.toContain('Waiter');
  });

  it('Urdu in notes or names never reaches the printer as raw bytes', () => {
    const bytes = renderKot({
      ...base,
      lines: [{ qty: 1, name: 'چکن تکہ', modifiers: [], note: 'کم مرچ' }],
    });
    expect(bytes.some((b) => b > 0x7f)).toBe(false);
  });

  it('always starts with init and ends with feed + cut', () => {
    const out = text(base);
    expect(out.startsWith('<INIT>')).toBe(true);
    expect(out.endsWith('<FEED:3><CUT>')).toBe(true);
  });
});

describe('cancel ticket', () => {
  it('tells the kitchen to stop, with the reason, on 58 mm paper', () => {
    expect(
      text(
        { ...base, kind: 'CANCEL', reason: 'customer changed mind', lines: [base.lines[0]!] },
        58,
      ),
    ).toMatchInlineSnapshot(`
      "<INIT><ALIGN:center><INVERT:1><BOLD:1><SIZE:2x2> *** CANCEL *** 
      <SIZE:1x1><INVERT:0><BOLD:0><ALIGN:left><BOLD:1><SIZE:2x2>KOT #12      BBQ
      <SIZE:1x1><BOLD:0><BOLD:1>Table T1                Order #7
      <BOLD:0>Waiter: Dev CAPTAIN        19:42
      --------------------------------
      <BOLD:1><SIZE:1x2>3 x Chicken Tikka (Leg)
      <SIZE:1x1><BOLD:0>    "less spicy"
      <BOLD:1>    >> VOID <<
      <BOLD:0>--------------------------------
      Reason: customer changed mind

      <FEED:3><CUT>"
    `);
  });

  it('CANCEL wins over RUSH and prints no reason line when none is given', () => {
    const out = text({ ...base, kind: 'CANCEL', rush: true });
    expect(out).toContain('*** CANCEL ***');
    expect(out).not.toContain('RUSH');
    expect(out).not.toContain('Reason:');
  });
});

describe('58 mm paper', () => {
  it('uses the narrower 32-column layout', () => {
    const lines = text(base, 58).split('\n');
    expect(Math.max(...lines.map((l) => l.replace(/<[^>]+>/g, '').length))).toBeLessThanOrEqual(32);
  });
});
