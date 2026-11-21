import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { Bucket } from '@erp/domain';
import type { DailySalesReport } from './daily-sales.service';

/**
 * The daily sales report as an A4 PDF (English). Built with pdf-lib, which needs no font files or native code, so it
 * runs the same on the restaurant's own server and in the cloud. The standard fonts cover Latin text only: anything
 * else (an Urdu customer name) is printed as "?" rather than breaking the file.
 */

const W = 595.28;
const H = 841.89;
const M = 36; // page margin
const INK = rgb(0.1, 0.12, 0.16);
const MUTED = rgb(0.4, 0.44, 0.5);
const LINE = rgb(0.82, 0.84, 0.88);
const BAND = rgb(0.94, 0.95, 0.97);
const BRAND = rgb(0.06, 0.45, 0.3);
const WARN = rgb(0.7, 0.35, 0.02);

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

class Sheet {
  readonly pdf: PDFDocument;
  font!: PDFFont;
  bold!: PDFFont;
  page!: PDFPage;
  y = 0;
  private readonly pages: PDFPage[] = [];

  constructor(
    pdf: PDFDocument,
    private readonly title: string,
  ) {
    this.pdf = pdf;
  }

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
      this.text(this.title, M, this.y, 8, this.font, MUTED);
      this.y -= 18;
    }
  }

  /** Makes room for `h` more points, starting a new page if the current one is full. Returns true on a new page. */
  ensure(h: number): boolean {
    if (this.y - h >= M + 14) return false;
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
    align: 'left' | 'right' = 'left',
  ): void {
    const t = safe(s);
    const w = font.widthOfTextAtSize(t, size);
    this.page.drawText(t, { x: align === 'right' ? x - w : x, y, size, font, color });
  }

  /** Cuts text to fit a width (with an ellipsis) so a long name never runs into the next column. */
  fit(s: string, width: number, size = 9, font: PDFFont = this.font): string {
    let t = safe(s);
    if (font.widthOfTextAtSize(t, size) <= width) return t;
    while (t.length > 1 && font.widthOfTextAtSize(`${t}...`, size) > width) t = t.slice(0, -1);
    return `${t}...`;
  }

  rule(color = LINE): void {
    this.page.drawLine({
      start: { x: M, y: this.y },
      end: { x: W - M, y: this.y },
      thickness: 0.6,
      color,
    });
  }

  heading(s: string): void {
    this.ensure(46);
    this.y -= 14;
    this.text(s.toUpperCase(), M, this.y, 9, this.bold, BRAND);
    this.y -= 5;
    this.rule(BRAND);
    this.y -= 4;
  }

  /** A table with a header row (repeated on every page) and one line per record. */
  table(cols: Col[], rows: string[][], opts: { total?: string[]; zebra?: boolean } = {}): void {
    const drawHeader = (): void => {
      this.page.drawRectangle({ x: M, y: this.y - 14, width: W - 2 * M, height: 16, color: BAND });
      let x = M + 4;
      for (const c of cols) {
        if (c.align === 'right')
          this.text(c.title, x + c.width - 8, this.y - 10, 8, this.bold, MUTED, 'right');
        else this.text(c.title, x, this.y - 10, 8, this.bold, MUTED);
        x += c.width;
      }
      this.y -= 24;
    };
    const rowOut = (cells: string[], bold = false, shade = false): void => {
      if (shade)
        this.page.drawRectangle({ x: M, y: this.y - 3, width: W - 2 * M, height: 13, color: BAND });
      let x = M + 4;
      cols.forEach((c, i) => {
        const font = bold ? this.bold : this.font;
        const cell = this.fit(cells[i] ?? '', c.width - 10, 8.5, font);
        if (c.align === 'right') this.text(cell, x + c.width - 8, this.y, 8.5, font, INK, 'right');
        else this.text(cell, x, this.y, 8.5, font);
        x += c.width;
      });
      this.y -= 13;
    };
    this.ensure(40);
    drawHeader();
    rows.forEach((r, n) => {
      if (this.ensure(16)) drawHeader();
      rowOut(r, false, !!opts.zebra && n % 2 === 1);
    });
    if (opts.total) {
      this.ensure(18);
      this.y -= 2;
      this.rule();
      this.y -= 11;
      rowOut(opts.total, true);
    }
  }

  /** Page numbers go on last, when the number of pages is known. */
  footers(generated: string): void {
    this.pages.forEach((p, i) => {
      p.drawText(safe(generated), { x: M, y: 20, size: 7.5, font: this.font, color: MUTED });
      const label = `Page ${i + 1} of ${this.pages.length}`;
      p.drawText(label, {
        x: W - M - this.font.widthOfTextAtSize(label, 7.5),
        y: 20,
        size: 7.5,
        font: this.font,
        color: MUTED,
      });
    });
  }
}

const bucketRows = (
  b: Bucket[],
  total: number,
  label: (k: string) => string = (k) => k,
): string[][] =>
  b.map((x) => [
    label(x.key),
    String(x.bills),
    rs(x.amountPaisa),
    total > 0 ? `${((x.amountPaisa * 100) / total).toFixed(1)}%` : '-',
  ]);

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
  const s = new Sheet(pdf, `${r.branch.name}  |  Daily sales  |  ${r.date}`);
  await s.init();
  const sales = r.sales;

  // ───── title block
  s.text(r.branch.name, M, s.y - 12, 18, s.bold);
  s.y -= 30;
  s.text('DAILY SALES REPORT', M, s.y, 11, s.bold, BRAND);
  s.text(dateLabel(r.date), W - M, s.y, 11, s.bold, INK, 'right');
  s.y -= 14;
  const sub = [r.branch.address, r.branch.phone ? `Tel ${r.branch.phone}` : null]
    .filter(Boolean)
    .join('  |  ');
  if (sub) s.text(sub, M, s.y, 8.5, s.font, MUTED);
  const when = new Date(r.generatedAt).toLocaleString('en-GB', {
    timeZone: timezone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  s.text(`Prepared ${when} by ${generatedBy}`, W - M, s.y, 8.5, s.font, MUTED, 'right');
  s.y -= 10;
  s.rule();

  // ───── headline figures
  s.y -= 8;
  const tiles: [string, string, string?][] = [
    [
      'Total collected',
      `Rs ${rs(sales.collectedPaisa)}`,
      `${sales.paidBills} paid bill${sales.paidBills === 1 ? '' : 's'}`,
    ],
    [
      'Net after refunds',
      `Rs ${rs(sales.netAfterRefundsPaisa)}`,
      `refunds Rs ${rs(sales.refundsPaisa)}`,
    ],
    ['Average bill', `Rs ${rs(sales.avgBillPaisa)}`],
    [
      'Not paid yet',
      `Rs ${rs(sales.unpaidPaisa)}`,
      `${sales.unpaidBills} bill${sales.unpaidBills === 1 ? '' : 's'}`,
    ],
  ];
  const tw = (W - 2 * M - 3 * 8) / 4;
  tiles.forEach(([label, value, note], i) => {
    const x = M + i * (tw + 8);
    s.page.drawRectangle({ x, y: s.y - 50, width: tw, height: 50, color: BAND });
    s.text(label.toUpperCase(), x + 8, s.y - 13, 7, s.bold, MUTED);
    s.text(value, x + 8, s.y - 31, 13, s.bold, i === 3 && sales.unpaidBills > 0 ? WARN : INK);
    if (note) s.text(note, x + 8, s.y - 44, 7.5, s.font, MUTED);
  });
  s.y -= 56;

  // ───── how the total is made up
  s.heading('How the total is made');
  const make: [string, number, boolean?][] = [
    ['Sales (items, before discount)', sales.grossSalesPaisa],
    ['Discounts', -sales.discountPaisa],
    ['Service charge', sales.serviceChargePaisa],
  ];
  if (sales.taxPaisa !== 0) make.push(['Sales tax', sales.taxPaisa]);
  if (sales.roundOffPaisa !== 0) make.push(['Round off', sales.roundOffPaisa]);
  make.push(['Total collected', sales.collectedPaisa, true]);
  make.push(['Refunds (credit notes)', -sales.refundsPaisa]);
  make.push(['Net after refunds', sales.netAfterRefundsPaisa, true]);
  for (const [label, v, strong] of make) {
    s.ensure(16);
    if (strong) s.rule();
    s.text(label, M + 4, s.y - 10, 9, strong ? s.bold : s.font);
    s.text(
      v < 0 ? `-Rs ${rs(-v)}` : `Rs ${rs(v)}`,
      W - M - 4,
      s.y - 10,
      9,
      strong ? s.bold : s.font,
      INK,
      'right',
    );
    s.y -= 14;
  }
  if (sales.tipsPaisa > 0) {
    s.text(
      `Tips received (not part of sales): Rs ${rs(sales.tipsPaisa)}`,
      M + 4,
      s.y - 10,
      8.5,
      s.font,
      MUTED,
    );
    s.y -= 14;
  }

  const wide = W - 2 * M;
  const bucketCols: Col[] = [
    { title: '', width: wide - 3 * 80 },
    { title: 'BILLS', width: 80, align: 'right' },
    { title: 'AMOUNT (RS)', width: 80, align: 'right' },
    { title: 'SHARE', width: 80, align: 'right' },
  ];
  const named = (title: string, count = 'BILLS'): Col[] => [
    { ...bucketCols[0]!, title },
    { ...bucketCols[1]!, title: count },
    ...bucketCols.slice(2),
  ];

  if (sales.byMethod.length) {
    s.heading('Money received, by payment method');
    s.table(named('METHOD', 'PAYMENTS'), bucketRows(sales.byMethod, sales.collectedPaisa), {
      total: [
        'Total',
        String(sales.byMethod.reduce((n, b) => n + b.bills, 0)),
        rs(sales.byMethod.reduce((n, b) => n + b.amountPaisa, 0)),
        '',
      ],
    });
  }
  if (sales.byType.length) {
    s.heading('Sales by order type');
    s.table(
      named('ORDER TYPE'),
      bucketRows(sales.byType, sales.collectedPaisa, (k) => TYPE_LABEL[k] ?? k),
    );
  }
  if (sales.byChannel.some((c) => c.key !== 'POS')) {
    s.heading('Sales by source');
    s.table(
      named('SOURCE'),
      bucketRows(sales.byChannel, sales.collectedPaisa, (k) => CHANNEL_LABEL[k] ?? k),
    );
  }
  if (sales.byHour.length) {
    s.heading('Sales by hour');
    s.table(
      named('HOUR'),
      bucketRows(sales.byHour, sales.collectedPaisa, (k) => `${k}:00 - ${k}:59`),
    );
  }
  if (sales.byCashier.length) {
    s.heading('Sales by cashier');
    s.table(named('CASHIER'), bucketRows(sales.byCashier, sales.collectedPaisa));
  }

  const rankCols = (title: string): Col[] => [
    { title, width: wide - 3 * 80 },
    { title: 'QTY', width: 80, align: 'right' },
    { title: 'AMOUNT (RS)', width: 80, align: 'right' },
    { title: 'SHARE', width: 80, align: 'right' },
  ];
  const share = (v: number): string =>
    sales.grossSalesPaisa > 0 ? `${((v * 100) / sales.grossSalesPaisa).toFixed(1)}%` : '-';
  const qty = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  if (sales.categories.length) {
    s.heading('Sales by category');
    s.table(
      rankCols('CATEGORY'),
      sales.categories.map((c) => [c.name, qty(c.qty), rs(c.amountPaisa), share(c.amountPaisa)]),
    );
  }
  if (sales.topItems.length) {
    s.heading('Best-selling items');
    s.table(
      rankCols('ITEM'),
      sales.topItems.map((c) => [c.name, qty(c.qty), rs(c.amountPaisa), share(c.amountPaisa)]),
    );
  }

  // ───── controls: what the owner checks for leaks
  s.heading('Discounts, refunds and voids');
  s.ensure(30);
  s.text(
    `Discounts given: ${r.discounts.length} bill${r.discounts.length === 1 ? '' : 's'}, Rs ${rs(sales.discountPaisa)}`,
    M + 4,
    s.y - 10,
    9,
  );
  s.y -= 14;
  s.text(
    `Dishes voided after the kitchen ticket: ${r.voids.lines}${r.voids.lines ? `, Rs ${rs(r.voids.paisa)}` : ''}`,
    M + 4,
    s.y - 10,
    9,
  );
  s.y -= 14;
  if (r.discounts.length) {
    s.y -= 4;
    s.table(
      [
        { title: 'BILL', width: 60 },
        { title: 'REASON', width: wide - 60 - 100 },
        { title: 'DISCOUNT (RS)', width: 100, align: 'right' },
      ],
      r.discounts.map((d) => [`#${d.billNo}`, d.reason ?? '-', rs(d.discountPaisa)]),
    );
  }
  if (r.refunds.length) {
    s.y -= 4;
    s.table(
      [
        { title: 'CREDIT NOTE', width: 80 },
        { title: 'BILL', width: 50 },
        { title: 'TIME', width: 46 },
        { title: 'REASON', width: wide - 80 - 50 - 46 - 70 - 90 },
        { title: 'PAID BACK BY', width: 70 },
        { title: 'AMOUNT (RS)', width: 90, align: 'right' },
      ],
      r.refunds.map((x) => [
        `CN-${x.cnNo}`,
        `#${x.billNo}`,
        x.time,
        x.reason,
        x.method,
        rs(x.totalPaisa),
      ]),
      { total: ['Total refunds', '', '', '', '', rs(sales.refundsPaisa)] },
    );
  }

  // ───── every bill of the day
  s.y -= 6;
  s.heading(`All bills of the day (${r.bills.length})`);
  if (r.bills.length === 0) {
    s.text('No bills were made on this day.', M + 4, s.y - 10, 9, s.font, MUTED);
    s.y -= 16;
  } else {
    const showTax = sales.taxPaisa !== 0;
    const cols: Col[] = [
      { title: 'BILL', width: 40 },
      { title: 'TOKEN', width: 36 },
      { title: 'TIME', width: 38 },
      { title: 'TABLE / TYPE', width: 62 },
      { title: 'PAID BY', width: 74 },
      { title: 'SUBTOTAL', width: 56, align: 'right' },
      ...(showTax ? [{ title: 'TAX', width: 46, align: 'right' as const }] : []),
      { title: 'DISCOUNT', width: 54, align: 'right' },
      { title: 'TOTAL (RS)', width: 64, align: 'right' },
      { title: 'STATUS', width: 0 },
    ];
    // the status column takes whatever width is left
    const used = cols.slice(0, -1).reduce((n, c) => n + c.width, 0);
    cols[cols.length - 1] = { title: 'STATUS', width: wide - used };
    const who = (b: DailySalesReport['bills'][number]): string => {
      const parts = [b.where];
      if (b.channel !== 'POS') parts.push(CHANNEL_LABEL[b.channel] ?? b.channel);
      return parts.join(' ');
    };
    s.table(
      cols,
      r.bills.map((b) => [
        `#${b.billNo}`,
        b.orderNo ? String(b.orderNo) : '-',
        b.time,
        who(b),
        b.methods || '-',
        rs(b.subtotalPaisa),
        ...(showTax ? [rs(b.taxPaisa)] : []),
        b.discountPaisa ? `-${rs(b.discountPaisa)}` : '-',
        rs(b.totalPaisa),
        b.status === 'SETTLED' ? (b.refundedPaisa ? 'Paid, refunded' : 'Paid') : 'NOT PAID',
      ]),
      {
        zebra: true,
        total: [
          'Paid',
          '',
          '',
          '',
          '',
          rs(sales.grossSalesPaisa),
          ...(showTax ? [rs(sales.taxPaisa)] : []),
          sales.discountPaisa ? `-${rs(sales.discountPaisa)}` : '-',
          rs(sales.collectedPaisa),
          `${sales.paidBills} bill${sales.paidBills === 1 ? '' : 's'}`,
        ],
      },
    );
    if (sales.unpaidBills > 0) {
      s.ensure(20);
      s.y -= 4;
      s.text(
        `${sales.unpaidBills} bill${sales.unpaidBills === 1 ? ' is' : 's are'} printed but not paid yet (Rs ${rs(sales.unpaidPaisa)}); they are not counted in the totals above.`,
        M + 4,
        s.y - 8,
        8.5,
        s.font,
        WARN,
      );
      s.y -= 14;
    }
  }

  s.footers(`${r.branch.name}  |  Daily sales ${r.date}  |  amounts in Pakistani rupees`);
  return pdf.save();
}
