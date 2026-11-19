# ADR 0030 — Staff and attendance (HR, milestone 1)

Status: accepted. Builds toward leave (M2), payroll (M3), advances/loans (M4) and extras (M5).

## Decisions

- **An employee is not a user.** A cook or rider may never sign in. `employees.user_id` is an optional, unique link for a cashier who is also on the payroll. Nothing depends on the link.
- **Nobody is deleted.** A person who leaves gets `status = LEFT` and a `left_date` (a CHECK requires the date). History, attendance and later payroll stay.
- **One attendance row per person per day** (`UNIQUE(employee_id, work_date)`). A night shift belongs to the day it started. A correction replaces the row and writes `ATTENDANCE_CHANGE` with the old values to `audit_log`.
- **Late and overtime are whole minutes, decided in `packages/domain/src/hr/attendance.ts`** (pure, property-tested). Late: nothing inside the grace period, the *whole* delay once past it. Overtime: only once past a threshold, and then all of it. Both thresholds are branch settings (`hr.late_grace_minutes` default 10, `hr.overtime_after_minutes` default 30). Half days are counted in half-day units (integers, no floats).
- **Calendar**: a holiday beats the weekly day off; a mark on the day beats the calendar. Days before joining and after leaving are not counted.
- **Clock-in screen**: staff tap their name and type their own PIN (argon2id; 4–8 digits). The time is the server's clock. Five wrong PINs lock that person for 5 minutes. A wrong PIN is HTTP 400 `PIN_WRONG` — never 401, because the web app treats 401 as an expired session. The failed-try counter is committed before the error is thrown. The PIN never reaches `audit_log` (redaction plus never passing it).
- **Permissions**: `employee.view/manage`, `attendance.view/mark/clock`. The manager has all; the accountant can look; the cashier can run the clock screen.

## Not decided here (left configurable, see OPEN-QUESTIONS #46)

Minimum wage, overtime multiplier, leave entitlements, EOBI/social security, withholding tax on salary and gratuity are legal matters. None is hard-coded; payroll (M3) will read them from effective-dated, unverified-by-default settings, like tax rules.
