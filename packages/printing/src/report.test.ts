import { describe, expect, it } from 'vitest';
import { describe as readable } from './escpos';
import { renderDrawerKick, renderReport, type ReportDoc } from './report';

const doc: ReportDoc = {
  title: 'SHIFT CLOSE',
  restaurant: 'Lahore Karahi House',
  subtitle: ['Business day 2026-08-01', 'Cashier: Ali'],
  sections: [
    {
      heading: 'Sales',
      rows: [
        ['Bills', '12'],
        ['Total', 1250050],
      ],
    },
    {
      heading: 'Cash drawer',
      rows: [
        ['Opening float', 500000],
        ['Expected cash', 735000],
      ],
      boldLast: true,
    },
    { rows: [['Variance', -1000]] },
  ],
};

describe('renderReport', () => {
  it('renders titled sections with right-aligned amounts', () => {
    const text = readable(renderReport(doc, 80));
    expect(text).toContain('SHIFT CLOSE');
    expect(text).toContain('SALES');
    expect(text).toMatch(/Bills\s+12/);
    expect(text).toMatch(/Total\s+12,500\.50/);
    expect(text).toMatch(/Expected cash\s+7,350/);
    expect(text).toMatch(/Variance\s+-10/);
    expect(text).not.toContain('REPRINT');
  });

  it('marks reprints and fits 58 mm paper', () => {
    const text = readable(renderReport({ ...doc, copy: 2 }, 58));
    expect(text).toContain('REPRINT #2');
    for (const line of text.split('\n').filter((l) => /Expected cash/.test(l)))
      expect(line.replace(/<[^>]*>/g, '').length).toBeLessThanOrEqual(32);
  });
});

describe('cash refund slips', () => {
  it('kicks the drawer first when asked', () => {
    const bytes = renderReport({ ...doc, openDrawer: true }, 80);
    expect([...bytes].slice(0, 2)).toEqual([0x1b, 0x40]);
    expect(Buffer.from(bytes.slice(0, 12)).includes(Buffer.from([0x1b, 0x70]))).toBe(true);
    expect(Buffer.from(renderReport(doc, 80)).includes(Buffer.from([0x1b, 0x70]))).toBe(false);
  });
});

describe('renderDrawerKick', () => {
  it('is init + drawer pulse and nothing printable', () => {
    const bytes = renderDrawerKick();
    expect([...bytes].slice(0, 2)).toEqual([0x1b, 0x40]);
    expect(Buffer.from(bytes).includes(Buffer.from([0x1b, 0x70]))).toBe(true);
    expect(bytes.length).toBeLessThan(12);
  });
});
