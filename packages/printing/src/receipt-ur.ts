import { BitmapDoc, bitmapWidth } from './bitmap';
import type { PaperMm } from './escpos';
import { sourceLine } from './kot';
import { money, type ReceiptDoc } from './receipt';

/** Receipt wording in Urdu (kept here so a translator can review it in one place). */
export const UR = {
  bill: 'بل',
  order: 'آرڈر',
  token: 'ٹوکن',
  name: 'نام',
  address: 'پتہ',
  notPaid: 'بل — ادائیگی باقی',
  payAtCounter: 'براہ کرم کاؤنٹر پر ادائیگی کریں',
  table: 'ٹیبل',
  DINE_IN: 'ڈائن اِن',
  TAKEAWAY: 'ٹیک اوے',
  DELIVERY: 'ڈیلیوری',
  waiter: 'ویٹر',
  cashier: 'کیشیئر',
  subtotal: 'ذیلی کل',
  discount: 'رعایت',
  service: 'سروس چارج',
  tax: 'ٹیکس',
  roundOff: 'راؤنڈ آف',
  total: 'کل رقم',
  change: 'بقایا رقم',
  tip: 'ٹپ',
  khata: 'کھاتہ',
  duplicate: 'نقل',
  thanks: 'شکریہ! دوبارہ تشریف لائیں',
  tel: 'فون',
} as const;

/** Keeps a number/Latin run in left-to-right order inside right-to-left Urdu text. */
const lri = (s: string | number): string => `⁦${s}⁩`;

/**
 * Customer bill as a bitmap with Urdu labels and item names, right-to-left. Amounts keep Western
 * digits and always read left to right. Item names fall back to English when no Urdu name exists.
 */
export function renderReceiptBitmap(doc: ReceiptDoc, paperMm: PaperMm = 80): Uint8Array {
  const b = new BitmapDoc(bitmapWidth(paperMm));
  const R = { rtl: true } as const;
  const big = { size: 44, bold: true, rtl: true } as const;

  const logo = doc.logo?.[paperMm];
  if (logo) b.raster(logo.widthBytes, logo.height, logo.data).space(6);
  b.text(doc.restaurantUr || doc.restaurant, big, 'center');
  if (doc.address) b.text(doc.address, { size: 22, rtl: true }, 'center');
  if (doc.phone) b.text(`${UR.tel}: ${lri(doc.phone)}`, { size: 22, rtl: true }, 'center');
  if (doc.taxPaisa > 0 && (doc.ntn || doc.strn))
    b.text(
      [doc.ntn ? `NTN: ${doc.ntn}` : '', doc.strn ? `STRN: ${doc.strn}` : '']
        .filter(Boolean)
        .join('  '),
      { size: 22 },
      'center',
    );
  if (doc.duplicate && doc.duplicate > 0)
    b.text(
      `*** ${UR.duplicate} ${lri(doc.duplicate)} ***`,
      { size: 28, bold: true, rtl: true },
      'center',
    );
  if (doc.provisional)
    b.text(`*** ${UR.notPaid} ***`, { size: 28, bold: true, rtl: true }, 'center');
  b.rule();
  b.text(`${UR.token} ${lri(doc.orderNo)}`, { size: 72, bold: true, rtl: true }, 'center');

  b.row(`${UR.bill} ${lri(doc.billNo)}`, doc.dateTime, R);
  const where =
    doc.orderType === 'DINE_IN' && doc.tableCode
      ? `${UR.table} ${lri(doc.tableCode)}`
      : UR[doc.orderType];
  if (doc.orderType === 'DINE_IN') b.row(where, '', R);
  else b.text(`*** ${UR[doc.orderType]} ***`, { size: 36, bold: true, rtl: true }, 'center');
  const src = sourceLine(doc.customer);
  if (src) b.text(src, { size: 26, bold: true }, 'center');
  if (doc.customer?.name)
    b.text(`${UR.name}: ${doc.customer.name}`, { ...R, size: 26, bold: true }, 'right');
  if (doc.customer?.phone)
    b.text(`${UR.tel}: ${lri(doc.customer.phone)}`, { ...R, size: 24 }, 'right');
  if (doc.orderType === 'DELIVERY' && doc.customer?.address)
    b.text(`${UR.address}: ${doc.customer.address}`, { ...R, size: 24 }, 'right');
  if (doc.waiter) b.row(`${UR.waiter}: ${doc.waiter}`, '', { ...R, size: 22 });
  if (doc.cashier) b.row(`${UR.cashier}: ${doc.cashier}`, '', { ...R, size: 22 });
  b.rule();

  for (const line of doc.lines) {
    const name = line.nameUr || line.name;
    const head = line.weightG ? `${lri(`${line.weightG} g`)} ${name}` : `${name} x${line.qty}`;
    b.row(head, money(line.amountPaisa), R);
    for (const m of line.modifiers ?? []) b.text(`+ ${m}`, { size: 22, rtl: true }, 'right');
  }
  b.rule();

  b.row(UR.subtotal, money(doc.subtotalPaisa), R);
  if (doc.discountPaisa > 0) b.row(UR.discount, money(-doc.discountPaisa), R);
  if (doc.serviceChargePaisa > 0) b.row(UR.service, money(doc.serviceChargePaisa), R);
  if (doc.taxPaisa > 0)
    b.row(
      doc.taxLabel ? `${UR.tax} ${lri(doc.taxLabel.replace(/^Sales tax\s*/, ''))}`.trim() : UR.tax,
      money(doc.taxPaisa),
      R,
    );
  if (doc.roundOffPaisa !== 0) b.row(UR.roundOff, money(doc.roundOffPaisa), R);
  b.row(UR.total, `Rs ${money(doc.totalPaisa)}`, { size: 34, bold: true, rtl: true });
  b.rule();

  for (const p of doc.payments) {
    b.row(p.method, money(p.tenderedPaisa ?? p.amountPaisa), R);
    if (p.changePaisa > 0) b.row(UR.change, money(p.changePaisa), R);
  }
  if (doc.tipPaisa && doc.tipPaisa > 0) b.row(UR.tip, money(doc.tipPaisa), R);
  if (doc.khataCustomer) b.text(`${UR.khata}: ${doc.khataCustomer}`, R, 'right');

  if (doc.fiscalNo) b.rule().text(`Fiscal invoice: ${doc.fiscalNo}`, { size: 22 }, 'center');
  else if (doc.fiscalPending) b.rule().text('Fiscal invoice: pending', { size: 22 }, 'center');
  b.rule().text(
    doc.provisional ? UR.payAtCounter : UR.thanks,
    { size: 28, bold: true, rtl: true },
    'center',
  );
  return b.toEscPos({ openDrawer: !!doc.openDrawer && !(doc.duplicate && doc.duplicate > 0) });
}
