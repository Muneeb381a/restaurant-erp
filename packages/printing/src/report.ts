import { COLUMNS, EscPos, twoColumns, wrap, type PaperMm } from './escpos';
import { money } from './receipt';

export interface ReportSection {
  heading?: string;
  /** [label, amount in paisa] rows, or [label, text] for counts and names. */
  rows: [string, number | string][];
  /** Emphasise the last row (e.g. expected cash). */
  boldLast?: boolean;
}

export interface ReportDoc {
  /** "SHIFT CLOSE" or "Z-REPORT" */
  title: string;
  restaurant: string;
  /** Lines under the title: business date, cashier, opened/closed times. */
  subtitle: string[];
  sections: ReportSection[];
  /** 0 = first print, n = reprint #n */
  copy?: number;
}

const cell = (v: number | string): string => (typeof v === 'number' ? money(v) : v);

/** Shift close slip and the day's Z-report: titled sections of label/value rows. */
export function renderReport(doc: ReportDoc, paperMm: PaperMm = 80): Uint8Array {
  const cols = COLUMNS[paperMm];
  const p = new EscPos().init().align('center').bold(true).size(2, 2);
  for (const l of wrap(doc.restaurant, Math.floor(cols / 2))) p.line(l);
  p.size(1, 2).line(doc.title).size(1, 1).bold(false);
  for (const s of doc.subtitle) p.line(s);
  if (doc.copy && doc.copy > 0) p.bold(true).line(`*** REPRINT #${doc.copy} ***`).bold(false);
  p.align('left').rule(cols);

  for (const sec of doc.sections) {
    if (sec.heading) p.bold(true).line(sec.heading.toUpperCase()).bold(false);
    sec.rows.forEach(([label, value], i) => {
      const last = sec.boldLast && i === sec.rows.length - 1;
      if (last) p.bold(true);
      p.line(twoColumns(label, cell(value), cols));
      if (last) p.bold(false);
    });
    p.rule(cols);
  }
  p.feed(3).cut();
  return p.build();
}

/** Opens the drawer without printing anything (a "no sale"). */
export function renderDrawerKick(): Uint8Array {
  return new EscPos().init().drawerKick().build();
}
