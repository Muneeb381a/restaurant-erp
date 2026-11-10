import { COLUMNS, EscPos, twoColumns, wrap, type PaperMm } from './escpos';

export interface ReceiptLine {
  qty: number;
  name: string;
  weightG?: number | null;
  modifiers?: string[];
  amountPaisa: number;
}

export interface ReceiptPayment {
  method: string;
  amountPaisa: number;
  /** Cash handed over (cash only). */
  tenderedPaisa?: number | null;
  changePaisa: number;
}

export interface ReceiptDoc {
  restaurant: string;
  address?: string | null;
  phone?: string | null;
  billNo: number;
  orderNo: number;
  orderType: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';
  tableCode?: string | null;
  waiter?: string | null;
  cashier?: string | null;
  /** Already formatted in the branch timezone, e.g. "01/08/2026 19:42". */
  dateTime: string;
  lines: ReceiptLine[];
  subtotalPaisa: number;
  discountPaisa: number;
  serviceChargePaisa: number;
  taxPaisa: number;
  roundOffPaisa: number;
  totalPaisa: number;
  payments: ReceiptPayment[];
  tipPaisa?: number;
  /** Credit sale: whose khata account carries (part of) the bill. */
  khataCustomer?: string | null;
  /** 0 = original, n = duplicate copy #n. */
  duplicate?: number;
  /** Open the cash drawer (cash tender). */
  openDrawer?: boolean;
}

/** "Rs 1,250.50"-style amount without the currency, for the right-hand column. */
export function money(paisa: number): string {
  const sign = paisa < 0 ? '-' : '';
  const abs = Math.abs(paisa);
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = abs % 100;
  return `${sign}${whole}${frac === 0 ? '' : `.${String(frac).padStart(2, '0')}`}`;
}

const TYPE_LABEL = { DINE_IN: 'Dine-in', TAKEAWAY: 'Takeaway', DELIVERY: 'Delivery' } as const;

/**
 * Customer bill in text mode (English item names). The Urdu bitmap receipt (ARCHITECTURE §8)
 * replaces this layout later; the data it needs is the same.
 */
export function renderReceipt(doc: ReceiptDoc, paperMm: PaperMm = 80): Uint8Array {
  const cols = COLUMNS[paperMm];
  const p = new EscPos().init();
  if (doc.openDrawer) p.drawerKick();

  p.align('center').bold(true).size(2, 2);
  for (const l of wrap(doc.restaurant, Math.floor(cols / 2))) p.line(l);
  p.size(1, 1).bold(false);
  if (doc.address) for (const l of wrap(doc.address, cols)) p.line(l);
  if (doc.phone) p.line(`Tel: ${doc.phone}`);
  if (doc.duplicate && doc.duplicate > 0)
    p.bold(true).line(`*** DUPLICATE #${doc.duplicate} ***`).bold(false);
  p.align('left').rule(cols);

  p.line(twoColumns(`Bill #${doc.billNo}`, doc.dateTime, cols));
  const where =
    doc.orderType === 'DINE_IN' && doc.tableCode
      ? `Table ${doc.tableCode}`
      : TYPE_LABEL[doc.orderType];
  p.line(twoColumns(where, `Order #${doc.orderNo}`, cols));
  if (doc.waiter || doc.cashier) {
    p.line(
      twoColumns(
        doc.waiter ? `Waiter: ${doc.waiter}` : '',
        doc.cashier ? `Cashier: ${doc.cashier}` : '',
        cols,
      ),
    );
  }
  p.rule(cols);

  for (const line of doc.lines) {
    const amount = money(line.amountPaisa);
    const head = line.weightG ? `${line.weightG} g ${line.name}` : `${line.qty} x ${line.name}`;
    const parts = wrap(head, cols - amount.length - 1, 4);
    parts.forEach((part, i) =>
      p.line(i === parts.length - 1 ? twoColumns(part, amount, cols) : part),
    );
    for (const m of line.modifiers ?? []) p.line(`    + ${m}`);
  }
  p.rule(cols);

  const row = (label: string, paisa: number): EscPos =>
    p.line(twoColumns(label, money(paisa), cols));
  row('Subtotal', doc.subtotalPaisa);
  if (doc.discountPaisa > 0) row('Discount', -doc.discountPaisa);
  if (doc.serviceChargePaisa > 0) row('Service charge', doc.serviceChargePaisa);
  if (doc.taxPaisa > 0) row('Tax', doc.taxPaisa);
  if (doc.roundOffPaisa !== 0) row('Round off', doc.roundOffPaisa);
  p.bold(true)
    .size(1, 2)
    .line(twoColumns('TOTAL', `Rs ${money(doc.totalPaisa)}`, cols))
    .size(1, 1)
    .bold(false);
  p.rule(cols);

  for (const pay of doc.payments) {
    row(pay.method, pay.tenderedPaisa ?? pay.amountPaisa);
    if (pay.changePaisa > 0) row('  Change', pay.changePaisa);
  }
  if (doc.tipPaisa && doc.tipPaisa > 0) row('Tip', doc.tipPaisa);
  if (doc.khataCustomer) for (const l of wrap(`Khata a/c: ${doc.khataCustomer}`, cols)) p.line(l);

  p.rule(cols).align('center').line('Thank you! Visit again').feed(3).cut();
  return p.build();
}
