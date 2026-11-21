import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/async-handler';
import type { AppContext } from '../../http/context';
import { authenticate, requirePermission, resolveBranch } from '../auth/middleware';
import { dashboard } from './dashboard.service';
import { renderDailySalesPdf } from './daily-sales.pdf';
import { dailySalesReport } from './daily-sales.service';
import { daySummary } from './day-summary.service';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export function reportsRouter(ctx: AppContext): Router {
  const r = Router();
  const money = [authenticate(ctx), resolveBranch(ctx), requirePermission(ctx, 'report.financial')];

  /** Owner dashboard: sales, payments, costs, profit, trends and controls for a range of business dates. */
  r.get(
    '/reports/dashboard',
    ...money,
    asyncHandler(async (req, res) => {
      const q = z.object({ from: isoDate, to: isoDate }).parse(req.query);
      res.json(await dashboard(ctx, req.branchId!, q.from, q.to));
    }),
  );
  /** The same day as a short message to forward (WhatsApp, SMS): `lang` en or ur. */
  r.get(
    '/reports/day-summary',
    ...money,
    asyncHandler(async (req, res) => {
      const q = z
        .object({ date: isoDate, lang: z.enum(['en', 'ur']).default('en') })
        .parse(req.query);
      res.json(await daySummary(ctx, req.branchId!, q.date, q.lang));
    }),
  );

  /**
   * Every bill of one calendar day with the totals the owner needs (sales, payments by method, hours, items, refunds).
   * Sales only: costs and profit stay behind report.financial on the dashboard.
   */
  const sales = [authenticate(ctx), resolveBranch(ctx), requirePermission(ctx, 'report.view')];
  r.get(
    '/reports/daily-sales',
    ...sales,
    asyncHandler(async (req, res) => {
      const q = z.object({ date: isoDate }).parse(req.query);
      res.json(await dailySalesReport(ctx, req.branchId!, q.date));
    }),
  );
  r.get(
    '/reports/daily-sales.pdf',
    ...sales,
    asyncHandler(async (req, res) => {
      const q = z.object({ date: isoDate }).parse(req.query);
      const report = await dailySalesReport(ctx, req.branchId!, q.date);
      const pdf = await renderDailySalesPdf(report, req.principal?.fullName ?? 'the system');
      res
        .status(200)
        .type('application/pdf')
        .set('Content-Disposition', `attachment; filename="daily-sales-${q.date}.pdf"`)
        .set('Cache-Control', 'no-store')
        .send(Buffer.from(pdf));
    }),
  );
  return r;
}
