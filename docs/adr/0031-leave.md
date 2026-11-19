# ADR 0031 — Leave (HR, milestone 2)

Status: accepted. Builds on ADR 0030.

- **Half-day units.** All leave is whole half-days (a day = 2). No fractions or floats anywhere; `formatLeaveDays` only for display. Logic is pure in `packages/domain/src/hr/leave.ts` (property-tested).
- **Only working days are used.** The person's weekly day off and public holidays inside the range are skipped. A request that lies wholly on days off is refused. A leave cannot cross two calendar years (enter two requests), so a year's balance is simple and honest.
- **No legal number is built in.** Each leave type has an optional yearly allowance; `NULL` = no limit is tracked. The four starting types (annual, casual, sick, unpaid) have no allowance until the owner types one (OPEN-QUESTIONS #46). `paid` says whether payroll (M3) deducts for it.
- **Approval writes attendance.** Approving a request writes `LEAVE` rows (a half-day leave writes `HALF_DAY`) into `attendance`, each pointing back at the request (`leave_request_id`). Cancelling an approved leave removes exactly those rows. A day that belongs to an approved leave cannot be re-marked or clocked until the leave is cancelled (`LEAVE_ATTENDANCE_LOCKED`); approval is refused over a day already marked present (`LEAVE_OVERLAPS_ATTENDANCE`).
- **Balance** = allowance + adjustments − approved; pending is shown and counted against a new request. Going below zero is refused unless the type allows it.
- **Adjustments are append-only** (DB trigger) and need a reason: an opening balance or a correction is another row, never an edit.
- **Reasons are required** to refuse and to cancel; every step is in `audit_log` (`LEAVE_REQUEST/APPROVE/REJECT/CANCEL/ADJUST`).
- **Who enters leave:** staff do not sign in, so a manager (`leave.manage`) enters it, optionally approving in the same step. The accountant has `leave.view`.
