# ADR 0010 — Credit notes / refunds (M6d)

**Status:** accepted (tax reversal and fiscal reporting wait for M5/M7; OPEN-QUESTIONS #32)

## Decisions

- **A settled bill is never edited.** Returns are credit notes (`credit_notes` + `credit_note_lines`), append-only (trigger; only the fiscal fields may change later). A credit note needs `bill.refund` (owner, manager), a reason, the refunding user's own open shift and an open business day (DB triggers), and is audited (`CREDIT_NOTE`).
- **The maths is pure** (`packages/domain/src/billing/refund.ts`, 100 % coverage + property tests). What the customer paid for a line is its net, less its share of the bill discount, plus its share of the service charge (`allocateProRata`); returning `q` of a line is `V(refunded+q) − V(refunded)` (half-up), a telescoping sum, so returning in steps equals returning at once. The bill's **round-off comes back with the last line**, so a full return equals the bill total exactly. Quantities are integers in thousandths (weights).
- **The database backs it up under locks:** the bill row is locked per credit note; the total of all credit notes of a bill can never exceed the bill total; a line can never be returned more than it sold (line row locked); the line must belong to the credited bill. Two simultaneous returns of the same item: exactly one wins (tested at both levels).
- **How the money goes back.** Any active payment method. **Cash** comes out of the refunding cashier's drawer: expected cash falls (`refundsCashPaisa`), the slip kicks the drawer, and a cash refund larger than the drawer holds is refused. **Card/wallet** refunds need a reference and do not touch the drawer. **Khata** lowers the customer's balance (`REFUND` ledger entry), up to what the bill charged to khata less earlier khata refunds.
- **Preview = server dry run.** `POST /bills/:id/credit-notes?dryRun=true` returns the exact amounts and writes nothing; the UI never computes a refund. The real call needs an `Idempotency-Key` (replay returns the same note; a key cannot be reused for another bill).
- **Reports.** Shift slip: refunds section and cash refunds in the drawer maths; Z-report: credit notes count, refunded total and **net after refunds**.
- **Look-up.** `GET /bills` (by business day / bill number, `report.view`) and a Bills page lead to the bill screen, where managers see the credit-note history and the Refund button.

## Consequences / limits

- Tax is 0 on credit notes until M5; then each line must reverse tax at the original rate (needs per-line tax, OPEN-QUESTIONS #18) and credit notes must be reported to the authority (M7).
- No stock restock (inventory is Phase 2); refunds to any method are allowed until the owner answers #32.
