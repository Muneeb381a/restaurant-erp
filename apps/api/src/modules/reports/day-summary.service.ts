import { formatDaySummary, type SummaryLang } from '@erp/domain';
import type { AppContext } from '../../http/context';
import { dashboard } from './dashboard.service';

/** The owner's end-of-day message for one business date, built from the dashboard figures. */
export async function daySummary(
  ctx: AppContext,
  branchId: string,
  date: string,
  lang: SummaryLang,
): Promise<{ date: string; text: string }> {
  const [d, branch] = await Promise.all([
    dashboard(ctx, branchId, date, date),
    ctx.db
      .selectFrom('branches')
      .select(['name', 'name_ur'])
      .where('id', '=', branchId)
      .executeTakeFirstOrThrow(),
  ]);
  const c = d.current;
  const text = formatDaySummary(
    {
      restaurant: lang === 'ur' && branch.name_ur ? branch.name_ur : branch.name,
      date,
      bills: c.bills,
      netSalesPaisa: c.netSalesPaisa,
      avgBillPaisa: c.avgBillPaisa,
      discountPaisa: c.discountPaisa,
      refundsPaisa: c.refundsPaisa,
      costOfFoodPaisa: c.costOfFoodPaisa,
      expensesPaisa: c.expensesPaisa,
      netProfitPaisa: c.netProfitPaisa,
      uncostedLines: c.uncostedLines,
      payments: d.payments.map((p) => ({ method: p.method, amountPaisa: p.amountPaisa })),
      topItems: d.topItems.map((i) => ({ name: i.name, qty: Math.round(i.qty * 10) / 10 })),
      cashDifferencePaisa: d.controls.cashDifferencePaisa,
      voidedAfterKitchenLines: d.controls.voidedAfterKitchenLines,
      medianKitchenSec: d.kitchen.timedTickets > 0 ? d.kitchen.medianTotalSec : null,
      lowStockCount: d.position.lowStockCount,
      khataOwedPaisa: d.position.khataOwedToUsPaisa,
    },
    lang,
  );
  return { date, text };
}
