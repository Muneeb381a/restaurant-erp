import { describe, expect, it } from 'vitest';
import { describe as describeBytes } from './escpos';
import { renderCombinedKot, renderKot, type CombinedKotDoc, type KotDoc } from './kot';

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
      "<INIT><ALIGN:center><BOLD:1><SIZE:3x3>TOKEN 7
      <SIZE:1x1><BOLD:0><ALIGN:left><ALIGN:left><BOLD:1><SIZE:2x2>KOT #12              BBQ
      <SIZE:1x1><BOLD:0><BOLD:1>Table T1                                   19:42
      <BOLD:0>Waiter: Dev CAPTAIN
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
      "<INIT><ALIGN:center><BOLD:1><SIZE:3x3>TOKEN 7
      <SIZE:1x1><BOLD:0><ALIGN:left><ALIGN:left><BOLD:1><SIZE:2x2>KOT #12              BBQ
      <SIZE:1x1><BOLD:0><BOLD:1>Table T1                                   19:42
      <BOLD:0>Waiter: Dev CAPTAIN
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
      <SIZE:1x1><INVERT:0><BOLD:0><ALIGN:center><BOLD:1><SIZE:3x3>TOKEN 7
      <SIZE:1x1><BOLD:0><ALIGN:left><ALIGN:left><BOLD:1><SIZE:2x2>KOT #12      BBQ
      <SIZE:1x1><BOLD:0><BOLD:1>Table T1                   19:42
      <BOLD:0>Waiter: Dev CAPTAIN
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

describe('the token', () => {
  it('is printed huge at the top of every kitchen ticket, even on 58 mm paper', () => {
    for (const mm of [58, 80] as const) {
      const t = text({ ...base, orderNo: 123 }, mm);
      expect(t).toContain('<SIZE:3x3>TOKEN 123');
      expect(t.indexOf('TOKEN 123')).toBeLessThan(t.indexOf('KOT #12')); // above everything else
    }
    // 4 digits still fit in one line at triple width (10 chars x 3 = 30 <= 32 columns)
    expect('TOKEN 1234'.length * 3).toBeLessThanOrEqual(32);
  });
});

describe('one combined ticket for a single printer', () => {
  const combined: CombinedKotDoc = {
    orderNo: 17,
    orderType: 'TAKEAWAY',
    waiter: 'Sara',
    time: '19:42',
    sections: [
      {
        station: 'BBQ',
        kotNo: 4,
        lines: [{ qty: 2, name: 'Chicken Tikka', modifiers: [], note: 'less spicy' }],
      },
      { station: 'TANDOOR', kotNo: 5, lines: [{ qty: 4, name: 'Naan', modifiers: [] }] },
      {
        station: 'DRINKS',
        kotNo: 6,
        lines: [
          { qty: 1, name: 'Cola', modifiers: [] },
          { qty: 1, name: 'Lassi', modifiers: ['Sweet'] },
        ],
      },
    ],
  };
  const t = describeBytes(renderCombinedKot(combined, 80));
  it('has the token on top, every station under its own heading, and the item count', () => {
    expect(t.indexOf('TOKEN 17')).toBeLessThan(t.indexOf('BBQ'));
    for (const s of ['BBQ  (KOT #4)', 'TANDOOR  (KOT #5)', 'DRINKS  (KOT #6)'])
      expect(t).toContain(s);
    expect(t.indexOf('BBQ')).toBeLessThan(t.indexOf('TANDOOR'));
    expect(t).toContain('2 x Chicken Tikka');
    expect(t).toContain('"less spicy"');
    expect(t).toContain('+ Sweet');
    expect(t).toMatch(/ITEMS\s+8\n/); // 2 + 4 + 1 + 1
    expect(t).toContain('TAKEAWAY');
  });
  it('marks a rush and a reprint, and cuts once', () => {
    const r = describeBytes(renderCombinedKot({ ...combined, rush: true, reprint: 2 }, 58));
    expect(r).toContain('*** RUSH ***');
    expect(r).toContain('** REPRINT #2 **');
    expect(r.match(/<CUT/g) ?? []).toHaveLength(1);
  });
  it('a weighed line counts as one item', () => {
    const w = describeBytes(
      renderCombinedKot(
        {
          ...combined,
          sections: [
            {
              station: 'BBQ',
              kotNo: 1,
              lines: [{ qty: 1, weightG: 750, name: 'Mutton Chops', modifiers: [] }],
            },
          ],
        },
        80,
      ),
    );
    expect(w).toContain('750 g Mutton Chops');
    expect(w).toMatch(/ITEMS\s+1\n/);
  });
});

describe('takeaway and delivery kitchen tickets', () => {
  const customer = { name: 'Ali Raza', phone: '0300-1234567', address: 'House 12, Gulberg' };
  it('say TAKEAWAY or DELIVERY in big type under the token, with the name and phone but not the address', () => {
    for (const orderType of ['TAKEAWAY', 'DELIVERY'] as const) {
      const t = text({ ...base, orderType, tableCode: null, customer });
      expect(t).toContain(` ${orderType} `);
      expect(t.indexOf('TOKEN')).toBeLessThan(t.indexOf(` ${orderType} `));
      expect(t).toContain('Name: Ali Raza');
      expect(t).toContain('Phone: 0300-1234567');
      expect(t).not.toContain('Address');
      expect(t).not.toContain('Table');
    }
  });
  it('the combined ticket does the same', () => {
    const t = describeBytes(
      renderCombinedKot(
        {
          orderNo: 5,
          orderType: 'DELIVERY',
          time: '19:42',
          customer,
          sections: [
            { station: 'BBQ', kotNo: 1, lines: [{ qty: 1, name: 'Tikka', modifiers: [] }] },
          ],
        },
        80,
      ),
    );
    expect(t).toContain(' DELIVERY ');
    expect(t).toContain('Name: Ali Raza');
  });
});
