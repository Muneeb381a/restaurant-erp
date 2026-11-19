# ADR 0033 — Advances, loans and fines; HR overview (HR, milestone 4)

Status: accepted. Builds on ADR 0032 (payroll).

- **A due is a ledger.** `staff_dues` says what was agreed (kind ADVANCE / LOAN / FINE, amount, instalment per pay run, reason); `staff_due_entries` is append-only (DISBURSE, FINE, RECOVERY, WRITE_OFF). The balance is never stored: it is added up (`packages/domain/src/hr/dues.ts`, property-tested) and a trigger refuses any entry that would take it below zero.
- **Cash out goes through the expenses ledger.** An advance or loan creates a `STAFF_ADVANCE` expense (idempotent, same transaction) and needs `payroll.pay`; a fine pays nothing out and needs only `payroll.manage`. Every due is created with an `Idempotency-Key`.
- **Recovery is a payslip line.** While a pay run is a draft, each open due adds a `RECOVERY` deduction of `min(instalment, balance owed, pay left after the other lines)`: a person is never paid less than nothing to settle a debt. Recalculating re-derives these lines. **Only on approval** are the recoveries booked in the ledger (once per payslip, unique index), after locking the dues, so two approvals cannot recover the same money twice.
- **Pause and write-off.** A paused due recovers nothing. Writing off (owner, `payroll.approve`, reason required) books a `WRITE_OFF` for the whole balance and closes the due; the record keeps given, recovered and forgiven.
- **Not built yet:** a person repaying in cash (it needs an income-side entry in the ledger); automatic settlement when someone leaves (their open dues show on the Advances screen).
- **HR overview** (`GET /hr/overview`): headcount by department/status, today (present, absent, leave, not marked, late, who is clocked in), the month (absence rate, lates, overtime, most absent/late), pending leave, and — only for people with `payroll.view` — approved pay for the month, sales, pay as a share of sales, and what staff owe. It reads; it changes nothing.
