import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { Bucket } from '@erp/domain';
import type { DailyBillRow, DailySalesReport } from './daily-sales.service';

/**
 * The daily sales report as an A4 landscape PDF (English). Page one is the day at a glance and the bill-by-bill table
 * (token, what each order came to, what was paid, what is still owed); the totals follow in a box, then the breakdowns.
 * Built with pdf-lib, which needs no font files or native code, so it runs the same on the restaurant's own server and
 * in the cloud. The standard fonts cover Latin text only: anything else (an Urdu customer name) is printed as "?".
 */

const W = 841.89;
const H = 595.28;
const M = 30; // page margin
const CONTENT = W - 2 * M;
const INK = rgb(0.1, 0.12, 0.16);
const MUTED = rgb(0.4, 0.44, 0.5);
const LINE = rgb(0.82, 0.84, 0.88);
const BAND = rgb(0.94, 0.95, 0.97);
const BRAND = rgb(0.06, 0.45, 0.3);
const BRAND_SOFT = rgb(0.9, 0.96, 0.93);
const WARN = rgb(0.7, 0.35, 0.02);
const WARN_SOFT = rgb(1, 0.95, 0.86);
const BAD = rgb(0.72, 0.15, 0.15);
const WHITE = rgb(1, 1, 1);

/** Rupees with thousands separators; paisa shown only when there are some ("1,250.50"). */
export function rs(paisa: number): string {
  const neg = paisa < 0;
  const abs = Math.abs(paisa);
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = abs % 100;
  return `${neg ? '-' : ''}${whole}${frac ? `.${String(frac).padStart(2, '0')}` : ''}`;
}

/** Keep to what the standard (WinAnsi) fonts can draw. */
const safe = (s: string): string =>
  s
    .replace(/[\r\n\t]+/g, ' ')
    .split('')
    .map((c) => {
      const n = c.charCodeAt(0);
      return (n >= 32 && n <= 126) || (n >= 161 && n <= 255) ? c : '?';
    })
    .join('')
    .trim();

const TYPE_LABEL: Record<string, string> = {
  DINE_IN: 'Dine-in',
  TAKEAWAY: 'Takeaway',
  DELIVERY: 'Delivery',
  OTHER: 'Other',
};
const CHANNEL_LABEL: Record<string, string> = {
  POS: 'Counter',
  PHONE: 'Phone',
  WHATSAPP: 'WhatsApp',
  FOODPANDA: 'Foodpanda',
  WEB: 'Website',
  OTHER: 'Other online',
};

interface Col {
  title: string;
  width: number;
  align?: 'left' | 'right';
}

interface TableOpts {
  x?: number;
  zebra?: boolean;
  /** Bold rows drawn under a rule, after the data rows. */
  totals?: string[][];
  /** Colour for a cell: (row, column) -> colour. */
  tint?: (row: number, col: number) => ReturnType<typeof rgb> | undefined;
}

class Sheet {
  font!: PDFFont;
  bold!: PDFFont;
  page!: PDFPage;
  y = 0;
  private readonly pages: PDFPage[] = [];

  constructor(
    readonly pdf: PDFDocument,
    private readonly title: string,
  ) {}

  async init(): Promise<void> {
    this.font = await this.pdf.embedFont(StandardFonts.Helvetica);
    this.bold = await this.pdf.embedFont(StandardFonts.HelveticaBold);
    this.newPage();
  }

  newPage(): void {
    this.page = this.pdf.addPage([W, H]);
    this.pages.push(this.page);
    this.y = H - M;
    if (this.pages.length > 1) {
      this.text(this.title, M, this.y - 8, 8, this.font, MUTED);
      this.y -= 22;
    }
  }

  /** Makes room for `h` more points, starting a new page if the current one is full. Returns true on a new page. */
  ensure(h: number): boolean {
    if (this.y - h >= M + 16) return false;
    this.newPage();
    return true;
  }

  text(
    s: string,
    x: number,
    y: number,
    size = 9,
    font: PDFFont = this.font,
    color = INK,
    align: 'left' | 'right' | 'center' = 'left',
  ): void {
    const t = safe(s);
    const w = font.widthOfTextAtSize(t, size);
    const left = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    this.page.drawText(t, { x: left, y, size, font, color });
  }

  /** Cuts text to fit a width (with an ellipsis) so a long name never runs into the next column. */
  fit(s: string, width: number, size = 9, font: PDFFont = this.font): string {
    let t = safe(s);
    if (font.widthOfTextAtSize(t, size) <= width) return t;
    while (t.length > 1 && font.widthOfTextAtSize(`${t}...`, size) > width) t = t.slice(0, -1);
    return `${t}...`;
  }

  rect(x: number, y: number, w: number, h: number, color: ReturnType<typeof rgb>): void {
    this.page.drawRectangle({ x, y, width: w, height: h, color });
  }

  hline(x1: number, x2: number, y: number, color = LINE, thickness = 0.6): void {
    this.page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });
  }

  heading(s: string, x = M, width = CONTENT): void {
    this.y -= 12;
    this.text(s.toUpperCase(), x, this.y, 8.5, this.bold, BRAND);
    this.y -= 4;
    this.hline(x, x + width, this.y, BRAND, 0.8);
    this.y -= 3;
  }

  /** A table with a header row (repeated on every new page) and one line per record. */
  table(cols: Col[], rows: string[][], opts: TableOpts = {}): void {
    const x0 = opts.x ?? M;
    const width = cols.reduce((n, c) => n + c.width, 0);
    const header = (): void => {
      this.rect(x0, this.y - 15, width, 17, BRAND);
      let x = x0 + 5;
      for (const c of cols) {
        if (c.align === 'right')
          this.text(c.title, x + c.width - 10, this.y - 10, 7.5, this.bold, WHITE, 'right');
        else this.text(c.title, x, this.y - 10, 7.5, this.bold, WHITE);
        x += c.width;
      }
      this.y -= 22;
    };
    const line = (cells: string[], bold: boolean, row: number | null): void => {
      let x = x0 + 5;
      cols.forEach((c, i) => {
        const font = bold ? this.bold : this.font;
        const cell = this.fit(cells[i] ?? '', c.width - 10, 8, font);
        const color = (row !== null ? opts.tint?.(row, i) : undefined) ?? INK;
        if (c.align === 'right') this.text(cell, x + c.width - 10, this.y, 8, font, color, 'right');
        else this.text(cell, x, this.y, 8, font, color);
        x += c.width;
      });
      this.y -= 14;
    };
    this.ensure(44);
    header();
    rows.forEach((r, n) => {
      if (this.ensure(18)) header();
      if (opts.zebra && n % 2 === 1) this.rect(x0, this.y - 4, width, 14, BAND);
      line(r, false, n);
      if (!opts.zebra) this.hline(x0, x0 + width, this.y + 10, LINE, 0.3);
    });
    if (opts.totals?.length) {
      this.ensure(14 * opts.totals.length + 8);
      this.hline(x0, x0 + width, this.y + 10, INK, 0.9);
      this.y -= 2;
      for (const t of opts.totals) line(t, true, null);
    }
  }

  /** Page numbers go on last, when the number of pages is known. */
  footers(generated: string): void {
    this.pages.forEach((p, i) => {
      p.drawLine({
        start: { x: M, y: 30 },
        end: { x: W - M, y: 30 },
        thickness: 0.4,
        color: LINE,
      });
      p.drawText(safe(generated), { x: M, y: 18, size: 7.5, font: this.font, color: MUTED });
      const label = `Page ${i + 1} of ${this.pages.length}`;
      p.drawText(label, {
        x: W - M - this.font.widthOfTextAtSize(label, 7.5),
        y: 18,
        size: 7.5,
        font: this.font,
        color: MUTED,
      });
    });
  }
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const pct = (part: number, whole: number): string =>
  whole > 0 ? `${((part * 100) / whole).toFixed(1)}%` : '-';

const bucketRows = (
  b: Bucket[],
  total: number,
  label: (k: string) => string = (k) => k,
): string[][] =>
  b.map((x) => [label(x.key), String(x.bills), rs(x.amountPaisa), pct(x.amountPaisa, total)]);

const dateLabel = (iso: string): string =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

export async function renderDailySalesPdf(
  r: DailySalesReport,
  generatedBy: string,
  timezone = r.branch.timezone,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Daily sales ${r.date}`);
  pdf.setAuthor(safe(r.branch.name));
  pdf.setCreator('Restaurant ERP');
  const s = new Sheet(pdf, `${r.branch.name}  |  Daily sales report  |  ${r.date}`);
  await s.init();
  const sales = r.sales;

  const paidRows = r.bills.filter((b) => b.status === 'SETTLED');
  const unpaidRows = r.bills.filter((b) => b.status === 'PRE_BILLED');
  const sum = (rows: DailyBillRow[], k: 'totalPaisa' | 'discountPaisa' | 'paidPaisa'): number =>
    rows.reduce((n, b) => n + b[k], 0);
  const billedAll = sum(r.bills, 'totalPaisa');
  const receivedAll = sum(r.bills, 'paidPaisa');

  // ───── title band
  s.rect(0, H - 62, W, 62, BRAND);
  s.text(r.branch.name, M, H - 30, 19, s.bold, WHITE);
  const sub = [r.branch.address, r.branch.phone ? `Tel ${r.branch.phone}` : null]
    .filter(Boolean)
    .join('   |   ');
  if (sub) s.text(sub, M, H - 47, 8.5, s.font, BRAND_SOFT);
  s.text('DAILY SALES REPORT', W - M, H - 28, 11, s.bold, BRAND_SOFT, 'right');
  s.text(dateLabel(r.date), W - M, H - 46, 12.5, s.bold, WHITE, 'right');
  s.y = H - 62 - 10;
  const when = new Date(r.generatedAt).toLocaleString('en-GB', {
    timeZone: timezone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  s.text(`Prepared ${when} by ${generatedBy}`, W - M, s.y - 6, 7.5, s.font, MUTED, 'right');
  s.y -= 12;

  // ───── the day at a glance
  const tiles: { label: string; value: string; note: string; warn?: boolean; strong?: boolean }[] =
    [
      {
        label: 'Bills made',
        value: String(r.bills.length),
        note: `${sales.paidBills} paid, ${unpaidRows.length} not paid`,
      },
      { label: 'Total billed', value: `Rs ${rs(billedAll)}`, note: 'paid and not paid' },
      {
        label: 'Received (paid bills)',
        value: `Rs ${rs(sales.collectedPaisa)}`,
        note: `average Rs ${rs(sales.avgBillPaisa)} a bill`,
        strong: true,
      },
      {
        label: 'Not paid yet',
        value: `Rs ${rs(sales.unpaidPaisa)}`,
        note: plural(sales.unpaidBills, 'bill'),
        warn: sales.unpaidBills > 0,
      },
      {
        label: 'Net after refunds',
        value: `Rs ${rs(sales.netAfterRefundsPaisa)}`,
        note: `refunds Rs ${rs(sales.refundsPaisa)}`,
      },
    ];
  const gap = 8;
  const tw = (CONTENT - gap * (tiles.length - 1)) / tiles.length;
  tiles.forEach((t, i) => {
    const x = M + i * (tw + gap);
    s.rect(x, s.y - 52, tw, 52, t.warn ? WARN_SOFT : t.strong ? BRAND_SOFT : BAND);
    s.rect(x, s.y - 52, 3, 52, t.warn ? WARN : BRAND);
    s.text(t.label.toUpperCase(), x + 11, s.y - 13, 7, s.bold, MUTED);
    s.text(t.value, x + 11, s.y - 31, 14.5, s.bold, t.warn ? WARN : INK);
    s.text(t.note, x + 11, s.y - 44, 7.5, s.font, MUTED);
  });
  s.y -= 58;

  // ───── every bill: token, amount, paid, still to pay
  s.heading(`Bill by bill  (${plural(r.bills.length, 'bill')})`);
  if (r.bills.length === 0) {
    s.text('No bills were made on this day.', M + 4, s.y - 10, 9, s.font, MUTED);
    s.y -= 18;
  } else {
    const cols: Col[] = [
      { title: '#', width: 26 },
      { title: 'BILL NO', width: 46 },
      { title: 'TOKEN', width: 44 },
      { title: 'TIME', width: 42 },
      { title: 'TABLE / TYPE', width: 100 },
      { title: 'CUSTOMER', width: 104 },
      { title: 'PAID BY', width: 92 },
      { title: 'AMOUNT (RS)', width: 76, align: 'right' },
      { title: 'DISCOUNT', width: 60, align: 'right' },
      { title: 'PAID (RS)', width: 72, align: 'right' },
      { title: 'DUE (RS)', width: 64, align: 'right' },
      { title: 'STATUS', width: 0 },
    ];
    cols[cols.length - 1]!.width = CONTENT - cols.slice(0, -1).reduce((n, c) => n + c.width, 0);
    const where = (b: DailyBillRow): string =>
      b.channel !== 'POS' ? `${b.where} (${CHANNEL_LABEL[b.channel] ?? b.channel})` : b.where;
    const due = (b: DailyBillRow): number =>
      b.status === 'SETTLED' ? 0 : Math.max(0, b.totalPaisa - b.paidPaisa);
    const status = (b: DailyBillRow): string =>
      b.status === 'PRE_BILLED' ? 'NOT PAID' : b.refundedPaisa ? 'Paid *' : 'Paid';
    s.table(
      cols,
      r.bills.map((b, i) => [
        String(i + 1),
        `#${b.billNo}`,
        b.orderNo ? String(b.orderNo) : '-',
        b.time,
        where(b),
        b.customer ?? '-',
        b.methods || '-',
        rs(b.totalPaisa),
        b.discountPaisa ? `-${rs(b.discountPaisa)}` : '-',
        rs(b.paidPaisa),
        due(b) ? rs(due(b)) : '-',
        status(b),
      ]),
      {
        zebra: true,
        tint: (row, col) => {
          const b = r.bills[row]!;
          if (col === 11) return b.status === 'PRE_BILLED' ? WARN : BRAND;
          if (col === 10 && due(b) > 0) return WARN;
          return undefined;
        },
        totals: [
          [
            '',
            '',
            '',
            '',
            `Paid bills: ${paidRows.length}`,
            '',
            '',
            rs(sum(paidRows, 'totalPaisa')),
            sum(paidRows, 'discountPaisa') ? `-${rs(sum(paidRows, 'discountPaisa'))}` : '-',
            rs(sum(paidRows, 'paidPaisa')),
            '-',
            '',
          ],
          ...(unpaidRows.length
            ? [
                [
                  '',
                  '',
                  '',
                  '',
                  `Not paid: ${unpaidRows.length}`,
                  '',
                  '',
                  rs(sum(unpaidRows, 'totalPaisa')),
                  '-',
                  rs(sum(unpaidRows, 'paidPaisa')),
                  rs(sales.unpaidPaisa),
                  '',
                ],
              ]
            : []),
          [
            '',
            '',
            '',
            '',
            `ALL BILLS: ${r.bills.length}`,
            '',
            '',
            rs(billedAll),
            sum(r.bills, 'discountPaisa') ? `-${rs(sum(r.bills, 'discountPaisa'))}` : '-',
            rs(receivedAll),
            sales.unpaidPaisa ? rs(sales.unpaidPaisa) : '-',
            '',
          ],
        ],
      },
    );
    s.y -= 2;
    const notes = [
      sales.refundsPaisa > 0 ? '* part or all of this bill was refunded (see Refunds below).' : '',
      'Amount is the bill total after discount, with service charge and tax if any. Due is what is still to be received.',
    ].filter(Boolean);
    for (const n of notes) {
      s.ensure(12);
      s.text(n, M + 4, s.y - 6, 7.5, s.font, MUTED);
      s.y -= 11;
    }
  }

  // ───── the day's totals, in a box
  const boxH = 14 + Math.max(5, sales.tipsPaisa > 0 ? 5 : 4) * 13 + 8;
  s.ensure(boxH + 24);
  s.heading('Day total');
  const boxTop = s.y;
  const half = (CONTENT - 16) / 2;
  s.rect(M, boxTop - boxH, CONTENT, boxH, BAND);
  s.rect(M, boxTop - boxH, 3, boxH, BRAND);
  // left: how the total is made
  const make: [string, number, boolean?][] = [
    ['Sales (items, before discount)', sales.grossSalesPaisa],
    ['Discounts', -sales.discountPaisa],
    ['Service charge', sales.serviceChargePaisa],
  ];
  if (sales.taxPaisa !== 0) make.push(['Sales tax', sales.taxPaisa]);
  if (sales.roundOffPaisa !== 0) make.push(['Round off', sales.roundOffPaisa]);
  make.push(['Received on paid bills', sales.collectedPaisa, true]);
  let ly = boxTop - 14;
  for (const [label, v, strong] of make) {
    if (strong) s.hline(M + 12, M + half - 6, ly + 9, INK, 0.7);
    s.text(label, M + 12, ly, 9, strong ? s.bold : s.font);
    s.text(
      v < 0 ? `-Rs ${rs(-v)}` : `Rs ${rs(v)}`,
      M + half - 8,
      ly,
      9,
      strong ? s.bold : s.font,
      INK,
      'right',
    );
    ly -= 13;
  }
  // right: what happens to it
  const rx = M + half + 16;
  const rightRows: [string, string, boolean?, boolean?][] = [
    ['Received on paid bills', `Rs ${rs(sales.collectedPaisa)}`],
    ['Refunds (credit notes)', `-Rs ${rs(sales.refundsPaisa)}`],
    ['NET SALES AFTER REFUNDS', `Rs ${rs(sales.netAfterRefundsPaisa)}`, true],
    ['Not paid yet (not counted)', `Rs ${rs(sales.unpaidPaisa)}`, false, sales.unpaidBills > 0],
  ];
  if (sales.tipsPaisa > 0)
    rightRows.push(['Tips (not part of sales)', `Rs ${rs(sales.tipsPaisa)}`]);
  let ry = boxTop - 14;
  for (const [label, v, strong, warn] of rightRows) {
    if (strong) s.hline(rx, W - M - 12, ry + 9, INK, 0.7);
    s.text(label, rx, ry, strong ? 10 : 9, strong ? s.bold : s.font, warn ? WARN : INK);
    s.text(
      v,
      W - M - 12,
      ry,
      strong ? 10 : 9,
      strong ? s.bold : s.font,
      warn ? WARN : INK,
      'right',
    );
    ry -= strong ? 15 : 13;
  }
  s.y = boxTop - boxH - 4;

  // ───── breakdowns, two to a row
  const colW = (CONTENT - 20) / 2;
  const bucketCols = (title: string, count: string, w: number): Col[] => [
    { title, width: w - 3 * 58 },
    { title: count, width: 58, align: 'right' },
    { title: 'AMOUNT (RS)', width: 58, align: 'right' },
    { title: 'SHARE', width: 58, align: 'right' },
  ];
  const rankCols = (title: string, w: number): Col[] => [
    { title, width: w - 3 * 58 },
    { title: 'QTY', width: 58, align: 'right' },
    { title: 'AMOUNT (RS)', width: 58, align: 'right' },
    { title: 'SHARE', width: 58, align: 'right' },
  ];
  const qty = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  const rankRows = (list: { name: string; qty: number; amountPaisa: number }[]): string[][] =>
    list.map((c) => [
      c.name,
      qty(c.qty),
      rs(c.amountPaisa),
      pct(c.amountPaisa, sales.grossSalesPaisa),
    ]);

  interface Block {
    title: string;
    cols: Col[];
    rows: string[][];
    totals?: string[][];
  }
  const blocks: Block[] = [];
  if (sales.byMethod.length)
    blocks.push({
      title: 'Money received, by payment method',
      cols: bucketCols('METHOD', 'PAYMENTS', colW),
      rows: bucketRows(sales.byMethod, sales.collectedPaisa),
      totals: [
        [
          'Total',
          String(sales.byMethod.reduce((n, b) => n + b.bills, 0)),
          rs(sales.byMethod.reduce((n, b) => n + b.amountPaisa, 0)),
          '',
        ],
      ],
    });
  if (sales.byType.length)
    blocks.push({
      title: 'Sales by order type',
      cols: bucketCols('ORDER TYPE', 'BILLS', colW),
      rows: bucketRows(sales.byType, sales.collectedPaisa, (k) => TYPE_LABEL[k] ?? k),
    });
  if (sales.byChannel.some((c) => c.key !== 'POS'))
    blocks.push({
      title: 'Sales by source',
      cols: bucketCols('SOURCE', 'BILLS', colW),
      rows: bucketRows(sales.byChannel, sales.collectedPaisa, (k) => CHANNEL_LABEL[k] ?? k),
    });
  if (sales.byHour.length)
    blocks.push({
      title: 'Sales by hour',
      cols: bucketCols('HOUR', 'BILLS', colW),
      rows: bucketRows(sales.byHour, sales.collectedPaisa, (k) => `${k}:00 - ${k}:59`),
    });
  if (sales.byCashier.length)
    blocks.push({
      title: 'Sales by cashier',
      cols: bucketCols('CASHIER', 'BILLS', colW),
      rows: bucketRows(sales.byCashier, sales.collectedPaisa),
    });
  if (sales.categories.length)
    blocks.push({
      title: 'Sales by category',
      cols: rankCols('CATEGORY', colW),
      rows: rankRows(sales.categories),
    });
  if (sales.topItems.length)
    blocks.push({
      title: 'Best-selling items',
      cols: rankCols('ITEM', colW),
      rows: rankRows(sales.topItems),
    });

  for (let i = 0; i < blocks.length; i += 2) {
    const pair = blocks.slice(i, i + 2);
    const tall = Math.max(...pair.map((b) => b.rows.length + (b.totals?.length ?? 0)));
    s.ensure(56 + 14 * tall);
    const top = s.y;
    let lowest = top;
    pair.forEach((b, k) => {
      const x = M + k * (colW + 20);
      s.y = top;
      s.heading(b.title, x, colW);
      s.table(b.cols, b.rows, { x, ...(b.totals ? { totals: b.totals } : {}) });
      lowest = Math.min(lowest, s.y);
    });
    s.y = lowest - 2;
  }

  // ───── controls: what the owner checks for leaks
  s.ensure(60);
  s.heading('Discounts, refunds and voids');
  s.text(
    `Discounts given: ${plural(r.discounts.length, 'bill')}, Rs ${rs(sales.discountPaisa)}`,
    M + 4,
    s.y - 8,
    9,
  );
  s.y -= 13;
  s.text(
    `Dishes voided after the kitchen ticket: ${r.voids.lines}${r.voids.lines ? `, Rs ${rs(r.voids.paisa)}` : ''}`,
    M + 4,
    s.y - 8,
    9,
    s.font,
    r.voids.lines ? BAD : INK,
  );
  s.y -= 16;
  if (r.discounts.length) {
    s.table(
      [
        { title: 'BILL', width: 70 },
        { title: 'REASON', width: CONTENT - 70 - 120 },
        { title: 'DISCOUNT (RS)', width: 120, align: 'right' },
      ],
      r.discounts.map((d) => [`#${d.billNo}`, d.reason ?? '-', rs(d.discountPaisa)]),
    );
    s.y -= 4;
  }
  if (r.refunds.length) {
    s.table(
      [
        { title: 'CREDIT NOTE', width: 90 },
        { title: 'BILL', width: 60 },
        { title: 'TIME', width: 56 },
        { title: 'REASON', width: CONTENT - 90 - 60 - 56 - 100 - 100 },
        { title: 'PAID BACK BY', width: 100 },
        { title: 'AMOUNT (RS)', width: 100, align: 'right' },
      ],
      r.refunds.map((x) => [
        `CN-${x.cnNo}`,
        `#${x.billNo}`,
        x.time,
        x.reason,
        x.method,
        rs(x.totalPaisa),
      ]),
      { totals: [['Total refunds', '', '', '', '', rs(sales.refundsPaisa)]] },
    );
  }

  s.footers(`${r.branch.name}  |  Daily sales ${r.date}  |  amounts in Pakistani rupees (Rs)`);
  return pdf.save();
}
