import { COLUMNS, EscPos, twoColumns, wrap, type PaperMm } from './escpos';

export interface KotLine {
  qty: number;
  name: string;
  /** Grams, for weighed lines ("750 g Mutton Chops"). */
  weightG?: number | null;
  modifiers: string[];
  note?: string | null;
  course?: number;
  /** Name of the deal this component belongs to (shown under the line). */
  fromDeal?: string | null;
}

export interface KotDoc {
  /** KOT = new ticket; CANCEL = stop this item (void after it was sent). */
  kind: 'KOT' | 'CANCEL';
  kotNo: number;
  station: string;
  orderNo: number;
  orderType: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';
  tableCode?: string | null;
  waiter?: string | null;
  /** Wall-clock time shown on the ticket, already formatted in the branch timezone. */
  time: string;
  rush?: boolean;
  /** 0 = original print; n = "REPRINT #n". */
  reprint?: number;
  /** Why the item was cancelled (CANCEL tickets). */
  reason?: string | null;
  lines: KotLine[];
}

const TYPE_LABEL = { DINE_IN: 'DINE-IN', TAKEAWAY: 'TAKEAWAY', DELIVERY: 'DELIVERY' } as const;

/**
 * Kitchen ticket, text mode, big and bold (readable at arm's length over a hot pass).
 * One ticket per station per "Send"; reprints and cancels are clearly marked.
 */
export function renderKot(doc: KotDoc, paperMm: PaperMm = 80): Uint8Array {
  const cols = COLUMNS[paperMm];
  const p = new EscPos().init();

  if (doc.kind === 'CANCEL') {
    p.align('center')
      .invert(true)
      .bold(true)
      .size(2, 2)
      .line(' *** CANCEL *** ')
      .size(1, 1)
      .invert(false)
      .bold(false);
  } else if (doc.rush) {
    p.align('center')
      .invert(true)
      .bold(true)
      .size(2, 2)
      .line(' *** RUSH *** ')
      .size(1, 1)
      .invert(false)
      .bold(false);
  }
  if (doc.reprint && doc.reprint > 0) {
    p.align('center').bold(true).line(`** REPRINT #${doc.reprint} **`).bold(false);
  }

  p.align('left')
    .bold(true)
    .size(2, 2)
    .line(twoColumns(`KOT #${doc.kotNo}`, doc.station, Math.floor(cols / 2)))
    .size(1, 1)
    .bold(false);
  const where =
    doc.orderType === 'DINE_IN' && doc.tableCode
      ? `Table ${doc.tableCode}`
      : TYPE_LABEL[doc.orderType];
  p.bold(true)
    .line(twoColumns(where, `Order #${doc.orderNo}`, cols))
    .bold(false);
  p.line(twoColumns(doc.waiter ? `Waiter: ${doc.waiter}` : '', doc.time, cols));
  p.rule(cols);

  for (const line of doc.lines) {
    const head = line.weightG ? `${line.weightG} g ${line.name}` : `${line.qty} x ${line.name}`;
    p.bold(true).size(1, 2);
    for (const l of wrap(head, cols, 4)) p.line(l);
    p.size(1, 1).bold(false);
    if (line.fromDeal) for (const l of wrap(`(${line.fromDeal})`, cols - 4, 0)) p.line(`    ${l}`);
    for (const m of line.modifiers) for (const l of wrap(`+ ${m}`, cols - 4, 2)) p.line(`    ${l}`);
    if (line.note) for (const l of wrap(`"${line.note}"`, cols - 4, 1)) p.line(`    ${l}`);
    if (doc.kind === 'CANCEL') p.bold(true).line('    >> VOID <<').bold(false);
  }

  p.rule(cols);
  if (doc.kind === 'CANCEL' && doc.reason)
    for (const l of wrap(`Reason: ${doc.reason}`, cols, 8)) p.line(l);
  p.feed(3).cut();
  return p.build();
}
