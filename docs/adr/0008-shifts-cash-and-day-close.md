# ADR 0008 — Shifts, the cash drawer and day close (M6b)

**Status:** accepted (tips and tax stay out of the drawer maths until OPEN-QUESTIONS #30 / M5)

## Decisions

- **Expected cash** = opening float + cash sales + cash in − paid out − drops (`expectedCash` in `packages/domain`, 100 % branch coverage). "Cash sales" are the amounts *applied to bills* by tenders whose method opens the drawer, so change handed back is already excluded. **Tips are not included** until the owner answers whether tips go through the drawer.
- **Money only moves through an OPEN shift** — enforced by triggers, not only by the API: payments and cash movements are refused into a closed shift. Settle takes the shift row `FOR SHARE`; a close takes it `FOR UPDATE`, so a close can never miss a payment that is committing at the same moment.
- **Blind count.** While a shift is open, the report API hides `expectedCashPaisa` and the variance from users who cannot close other people's shifts (`day.close`) or see finance reports. The cashier counts first; the close then shows expected, counted and the difference.
- **Variance.** `counted − expected` is stored by the database (generated column). Any non-zero variance needs a written note (`VARIANCE_NOTE_REQUIRED`); the note is the audit `reason`.
- **Closed shifts are history.** A trigger allows only one change: a clean *reopen* (status back to OPEN, close data cleared, float/owner untouched). Reopen needs `shift.reopen` + reason, is only possible in the still-open business day, is refused if the cashier or till already has another open shift, and the audit entry keeps the old counted/expected cash.
- **Cash movements** (paid-out, cash-in, drop to safe; `cash.paid_out`) are append-only, carry a mandatory reason and a mandatory `Idempotency-Key`, and a paid-out/drop larger than the cash in the drawer is refused (`DRAWER_INSUFFICIENT_CASH`) — it would hide a shortage. **No sale** (`drawer.open`) records a zero movement, audits it and queues a drawer pulse (print kind `DRAWER`).
- **Day close** (`day.close`) is refused while any shift is open (`SHIFTS_STILL_OPEN`) or any order is OPEN/BILLED (`ORDERS_STILL_OPEN`); both responses list what blocks. It locks the day row; order and shift inserts take the day row `FOR SHARE` in a trigger, so an order created at the same instant either finishes before the close counts, or fails afterwards (`DAY_NOT_OPEN`). A closed day is immutable and cannot be reopened.
- **Reports** live in the reports module, which may read other modules' tables (rule 8). Shift slip and the day's **Z-report** are rendered from the same data (`renderReport`) and queued on the receipt printers (kind `REPORT`); reprints say `REPRINT #n`, need a reason and are audited. Day reports need `report.financial`.

## Consequences / limits

- The Z-report has no tax lines yet (M5) and no refunds/credit notes (later). Variance across shifts is summed, not netted by till.
- Print jobs for reports are plain text in English; the Urdu bitmap layout comes with the receipt bitmap work.
