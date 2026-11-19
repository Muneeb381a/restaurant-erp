import { AppError } from '../../http/errors';
import type { Queryable } from '../../shared/tx';

/**
 * Once a pay run is approved the attendance, leave and holidays of its period must not move: the pay was
 * worked out from them. Anything that would change such a day is refused; the correction goes into the next
 * pay run as a manual line (ADR 0032).
 *
 * `employeeId` = null means "everybody" (a holiday changes every person's day).
 */
export async function assertPeriodOpen(
  q: Queryable,
  branchId: string,
  employeeId: string | null,
  dates: readonly string[],
): Promise<void> {
  if (dates.length === 0) return;
  const from = dates.reduce((a, b) => (a < b ? a : b));
  const to = dates.reduce((a, b) => (a > b ? a : b));
  let query = q
    .selectFrom('payroll_runs as r')
    .innerJoin('payslips as s', 's.run_id', 'r.id')
    .select(['r.run_no', 'r.period_from', 'r.period_to'])
    .where('r.branch_id', '=', branchId)
    .where('r.status', '=', 'APPROVED')
    .where('r.period_from', '<=', to)
    .where('r.period_to', '>=', from);
  if (employeeId) query = query.where('s.employee_id', '=', employeeId);
  const hit = await query.limit(1).executeTakeFirst();
  if (hit)
    throw new AppError(
      409,
      'PAYROLL_PERIOD_LOCKED',
      `That day is inside the approved pay run ${hit.period_from} to ${hit.period_to} and can no longer change. Put the correction in the next pay run.`,
      { from: hit.period_from, to: hit.period_to },
    );
}
