import { monthDays } from '@erp/domain';
import { sql } from 'kysely';
import type { AppContext } from '../../http/context';
import { listDues } from './dues.service';
import { attendanceMonth, attendanceSheet } from './hr.service';

/**
 * One read for the "who is here, who is not, what is it costing" page. Staff and attendance figures need
 * `employee.view`; the money figures (pay runs, what staff owe, labour cost against sales) are included
 * only when `canPayroll` says the caller may see pay.
 */
export async function hrOverview(
  ctx: AppContext,
  branchId: string,
  input: { date: string; month: string },
  canPayroll: boolean,
) {
  const [sheet, month, staff, pending] = await Promise.all([
    attendanceSheet(ctx, branchId, input.date),
    attendanceMonth(ctx, branchId, input.month),
    ctx.db
      .selectFrom('employees')
      .select(['status', 'department'])
      .where('branch_id', '=', branchId)
      .where('status', '!=', 'LEFT')
      .execute(),
    ctx.db
      .selectFrom('leave_requests')
      .select(({ fn }) => fn.countAll<string>().as('n'))
      .where('branch_id', '=', branchId)
      .where('status', '=', 'PENDING')
      .executeTakeFirst(),
  ]);

  const stateOf = (r: (typeof sheet)[number]): string =>
    r.record?.status ?? r.calendar ?? 'UNMARKED';
  const today: Record<string, number> = {
    PRESENT: 0,
    HALF_DAY: 0,
    ABSENT: 0,
    LEAVE: 0,
    WEEKLY_OFF: 0,
    HOLIDAY: 0,
    UNMARKED: 0,
  };
  for (const r of sheet) today[stateOf(r)] = (today[stateOf(r)] ?? 0) + 1;

  const byDepartment: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const s of staff) {
    byDepartment[s.department] = (byDepartment[s.department] ?? 0) + 1;
    byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
  }

  const people = month.employees.map((e) => ({
    id: e.id,
    code: e.code,
    fullName: e.fullName,
    absent: e.summary.absent,
    lateCount: e.summary.lateCount,
    lateMinutes: e.summary.lateMinutes,
    overtimeMinutes: e.summary.overtimeMinutes,
    present: e.summary.present + e.summary.halfDays / 2,
  }));
  const sum = (f: (p: (typeof people)[number]) => number): number =>
    people.reduce((n, p) => n + f(p), 0);
  const attendedDays = sum((p) => p.present);
  const absentDays = sum((p) => p.absent);

  const out = {
    date: input.date,
    forMonth: input.month,
    headcount: { total: staff.length, byStatus, byDepartment },
    today: {
      counts: today,
      notYetIn: sheet
        .filter((r) => !r.record && !r.calendar)
        .map((r) => ({ id: r.employee.id, code: r.employee.code, fullName: r.employee.fullName })),
      late: sheet
        .filter((r) => (r.record?.lateMinutes ?? 0) > 0)
        .map((r) => ({
          id: r.employee.id,
          fullName: r.employee.fullName,
          minutes: r.record!.lateMinutes,
        })),
      onLeave: sheet
        .filter((r) => r.record?.status === 'LEAVE')
        .map((r) => ({ id: r.employee.id, fullName: r.employee.fullName })),
      clockedIn: sheet.filter((r) => r.record?.clockIn && !r.record.clockOut).length,
    },
    month: {
      attendedDays,
      absentDays,
      absenceRateBps:
        attendedDays + absentDays > 0
          ? Math.round((absentDays * 10_000) / (attendedDays + absentDays))
          : 0,
      lateCount: sum((p) => p.lateCount),
      lateMinutes: sum((p) => p.lateMinutes),
      overtimeMinutes: sum((p) => p.overtimeMinutes),
      topAbsent: people
        .filter((p) => p.absent > 0)
        .sort((x, y) => y.absent - x.absent)
        .slice(0, 5)
        .map((p) => ({ id: p.id, fullName: p.fullName, days: p.absent })),
      topLate: people
        .filter((p) => p.lateCount > 0)
        .sort((x, y) => y.lateCount - x.lateCount)
        .slice(0, 5)
        .map((p) => ({
          id: p.id,
          fullName: p.fullName,
          count: p.lateCount,
          minutes: p.lateMinutes,
        })),
    },
    leave: { pendingRequests: Number(pending?.n ?? 0) },
    money: null as null | {
      payrollNetPaisa: number;
      approvedRuns: number;
      draftRuns: number;
      salesPaisa: number;
      /** payroll as a share of sales, in basis points (null when there were no sales) */
      labourCostBps: number | null;
      owedByStaffPaisa: number;
      peopleWhoOwe: number;
    },
  };

  if (canPayroll) {
    const days = monthDays(input.month);
    const from = days[0]!;
    const to = days[days.length - 1]!;
    const [runs, sales, dues] = await Promise.all([
      ctx.db
        .selectFrom('payroll_runs as r')
        .leftJoin('payslips as s', 's.run_id', 'r.id')
        .select(['r.status', 'r.id'])
        .select(sql<number>`coalesce(sum(s.net_paisa), 0)`.as('net'))
        .where('r.branch_id', '=', branchId)
        .where('r.status', 'in', ['DRAFT', 'APPROVED'])
        .where('r.period_to', '>=', from)
        .where('r.period_to', '<=', to)
        .groupBy(['r.status', 'r.id'])
        .execute(),
      ctx.db
        .selectFrom('bills as b')
        .innerJoin('business_days as d', 'd.id', 'b.business_day_id')
        .select(sql<number>`coalesce(sum(b.total_paisa), 0)`.as('total'))
        .where('b.branch_id', '=', branchId)
        .where('b.status', '=', 'SETTLED')
        .where('d.business_date', '>=', from)
        .where('d.business_date', '<=', to)
        .executeTakeFirst(),
      listDues(ctx, branchId, { open: true }),
    ]);
    const approved = runs.filter((r) => r.status === 'APPROVED');
    const net = approved.reduce((n, r) => n + Number(r.net), 0);
    const salesPaisa = Number(sales?.total ?? 0);
    out.money = {
      payrollNetPaisa: net,
      approvedRuns: approved.length,
      draftRuns: runs.length - approved.length,
      salesPaisa,
      labourCostBps: salesPaisa > 0 ? Math.round((net * 10_000) / salesPaisa) : null,
      owedByStaffPaisa: dues.reduce((n, d) => n + d.balancePaisa, 0),
      peopleWhoOwe: new Set(dues.map((d) => d.employeeId)).size,
    };
  }
  return out;
}
