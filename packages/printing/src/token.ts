import { BitmapDoc, bitmapWidth } from './bitmap';
import { COLUMNS, EscPos, wrap, type PaperMm } from './escpos';
import { UR } from './receipt-ur';

export interface TokenDoc {
  restaurant: string;
  restaurantUr?: string | null;
  /** The token: the day's order number. */
  orderNo: number;
  orderType: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';
  tableCode?: string | null;
  /** Already formatted in the branch timezone, e.g. "01/08/2026 19:42". */
  dateTime: string;
}

const TYPE_LABEL = { DINE_IN: 'Dine-in', TAKEAWAY: 'Takeaway', DELIVERY: 'Delivery' } as const;

const whereOf = (doc: TokenDoc): string =>
  doc.orderType === 'DINE_IN' && doc.tableCode
    ? `Table ${doc.tableCode}`
    : TYPE_LABEL[doc.orderType];

/**
 * The token slip: a small separate ticket with just the number, huge. It is handed to the customer (or clipped to
 * the order) so the counter can find the order again when they come to pay. It is not a bill and carries no amounts.
 */
export function renderTokenSlip(doc: TokenDoc, paperMm: PaperMm = 80): Uint8Array {
  const cols = COLUMNS[paperMm];
  const p = new EscPos().init();
  p.align('center').bold(true).size(2, 2);
  for (const l of wrap(doc.restaurant, Math.floor(cols / 2))) p.line(l);
  p.size(1, 1).rule(cols);
  p.size(2, 2).line('TOKEN').size(4, 4).line(String(doc.orderNo)).size(1, 1);
  p.rule(cols).bold(true).line(whereOf(doc)).bold(false).line(doc.dateTime);
  p.rule(cols).line('Keep this slip.').line('Show it when you pay.');
  p.feed(3).cut();
  return p.build();
}

/** The same slip as a bitmap with Urdu wording (for restaurants whose receipts are Urdu). */
export function renderTokenSlipBitmap(doc: TokenDoc, paperMm: PaperMm = 80): Uint8Array {
  const b = new BitmapDoc(bitmapWidth(paperMm));
  const R = { rtl: true } as const;
  b.text(doc.restaurantUr || doc.restaurant, { size: 40, bold: true, rtl: true }, 'center');
  b.rule();
  b.text(UR.token, { size: 44, bold: true, rtl: true }, 'center');
  b.text(String(doc.orderNo), { size: 150, bold: true }, 'center');
  b.rule();
  b.text(
    doc.orderType === 'DINE_IN' && doc.tableCode
      ? `${UR.table} ${doc.tableCode}`
      : UR[doc.orderType],
    { size: 30, bold: true, ...R },
    'center',
  );
  b.text(doc.dateTime, { size: 24 }, 'center');
  b.rule();
  b.text('یہ پرچی سنبھال کر رکھیں', { size: 26, ...R }, 'center');
  b.text('ادائیگی کے وقت دکھائیں', { size: 26, ...R }, 'center');
  return b.toEscPos({ openDrawer: false });
}
