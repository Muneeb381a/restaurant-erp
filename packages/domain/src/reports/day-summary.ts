/**
 * The end-of-day message the owner reads on their phone (WhatsApp, SMS or a copy-paste). Pure text from
 * figures the server already computed: nothing is recalculated here except display (grouping, "Rs", %).
 */

export type SummaryLang = 'en' | 'ur';

export interface DaySummaryInput {
  restaurant: string;
  /** Local business date, YYYY-MM-DD. */
  date: string;
  bills: number;
  netSalesPaisa: number;
  avgBillPaisa: number;
  discountPaisa: number;
  refundsPaisa: number;
  costOfFoodPaisa: number;
  expensesPaisa: number;
  netProfitPaisa: number;
  /** Settled lines with no recipe cost: profit is overstated by their real cost. */
  uncostedLines: number;
  payments: { method: string; amountPaisa: number }[];
  topItems: { name: string; qty: number }[];
  /** Cash counted minus expected over the closed shifts (negative = short). */
  cashDifferencePaisa: number;
  voidedAfterKitchenLines: number;
  medianKitchenSec: number | null;
  lowStockCount: number;
  khataOwedPaisa: number;
}

const LABELS = {
  en: {
    sales: 'Sales',
    bills: (n: number) => `${n} ${n === 1 ? 'bill' : 'bills'}`,
    avg: 'average',
    paid: 'Paid by',
    food: 'Cost of food',
    expenses: 'Expenses',
    profit: 'Net profit',
    margin: 'of sales',
    discounts: 'Discounts',
    refunds: 'Refunds',
    cash: 'Cash difference',
    short: 'short',
    over: 'over',
    best: 'Best sellers',
    kitchen: 'Kitchen: typical',
    min: 'min',
    low: 'Low stock',
    items: 'items',
    khata: 'Khata owed to you',
    voids: 'Voided after the kitchen',
    caution: (n: number) => `Profit may be overstated: ${n} sold lines have no recipe cost.`,
    none: 'No sales today.',
  },
  ur: {
    sales: 'فروخت',
    bills: (n: number) => `${n} بل`,
    avg: 'اوسط',
    paid: 'ادائیگی',
    food: 'کھانے کی لاگت',
    expenses: 'اخراجات',
    profit: 'خالص منافع',
    margin: 'فروخت کا',
    discounts: 'رعایت',
    refunds: 'واپسی',
    cash: 'کیش کا فرق',
    short: 'کم',
    over: 'زیادہ',
    best: 'سب سے زیادہ بکنے والی',
    kitchen: 'باورچی خانہ: عام وقت',
    min: 'منٹ',
    low: 'کم اسٹاک',
    items: 'اشیا',
    khata: 'کھاتہ، آپ کو لینا ہے',
    voids: 'کچن کے بعد منسوخ',
    caution: (n: number) => `منافع زیادہ دکھ سکتا ہے: ${n} فروخت شدہ لائنوں کی ریسیپی لاگت نہیں۔`,
    none: 'آج کوئی فروخت نہیں۔',
  },
} as const;

/** "Rs 1,250" / "Rs 1,250.50" / "-Rs 300": whole rupees when there are no paisa. */
export function rs(paisa: number): string {
  const abs = Math.abs(Math.round(paisa));
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = abs % 100;
  return `${paisa < 0 ? '-' : ''}Rs ${whole}${frac ? `.${String(frac).padStart(2, '0')}` : ''}`;
}

function longDate(iso: string, lang: SummaryLang): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(lang === 'ur' ? 'ur-PK' : 'en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
}

/** Share of sales in whole percent, or null when there were no sales (never a divide by zero). */
export function percentOf(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part * 100) / whole) : null;
}

export function formatDaySummary(i: DaySummaryInput, lang: SummaryLang = 'en'): string {
  const L = LABELS[lang];
  const lines: string[] = [`*${i.restaurant}*`, longDate(i.date, lang), ''];
  if (i.bills === 0) {
    lines.push(L.none);
    return lines.join('\n');
  }
  lines.push(
    `*${L.sales}* ${rs(i.netSalesPaisa)} · ${L.bills(i.bills)} (${L.avg} ${rs(i.avgBillPaisa)})`,
  );
  const paid = i.payments
    .filter((p) => p.amountPaisa !== 0)
    .map((p) => `${p.method} ${rs(p.amountPaisa)}`);
  if (paid.length) lines.push(`${L.paid}: ${paid.join(' · ')}`);
  lines.push('');
  lines.push(`${L.food}: ${rs(i.costOfFoodPaisa)}`);
  lines.push(`${L.expenses}: ${rs(i.expensesPaisa)}`);
  const pct = percentOf(i.netProfitPaisa, i.netSalesPaisa);
  lines.push(
    `*${L.profit}: ${rs(i.netProfitPaisa)}*${pct === null ? '' : ` (${pct}% ${L.margin})`}`,
  );
  if (i.uncostedLines > 0) lines.push(`_${L.caution(i.uncostedLines)}_`);
  lines.push('');
  if (i.discountPaisa > 0) lines.push(`${L.discounts}: ${rs(i.discountPaisa)}`);
  if (i.refundsPaisa > 0) lines.push(`${L.refunds}: ${rs(i.refundsPaisa)}`);
  if (i.voidedAfterKitchenLines > 0) lines.push(`${L.voids}: ${i.voidedAfterKitchenLines}`);
  if (i.cashDifferencePaisa !== 0)
    lines.push(
      `${L.cash}: ${rs(Math.abs(i.cashDifferencePaisa))} ${i.cashDifferencePaisa < 0 ? L.short : L.over}`,
    );
  if (i.topItems.length)
    lines.push(
      `${L.best}: ${i.topItems
        .slice(0, 3)
        .map((t) => `${t.name} ×${t.qty}`)
        .join(', ')}`,
    );
  if (i.medianKitchenSec !== null)
    lines.push(`${L.kitchen} ${Math.max(1, Math.round(i.medianKitchenSec / 60))} ${L.min}`);
  if (i.lowStockCount > 0) lines.push(`${L.low}: ${i.lowStockCount} ${L.items}`);
  if (i.khataOwedPaisa > 0) lines.push(`${L.khata}: ${rs(i.khataOwedPaisa)}`);
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}
