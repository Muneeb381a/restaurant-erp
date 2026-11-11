# ADR 0015 — Owner dashboard (read-only reporting)

**Status:** accepted

## Context
The owner needs one place to see sales, payments, costs and profit, and to spot leaks. Research into
restaurant KPI guides and POS reporting (Toast sales summary, product mix, voids/discounts/exceptions
reports; Petpooja owner dashboard and P&L; common prime-cost, food-cost and average-check formulas)
gave the shape: headline numbers with period comparison, a P&L, payments, hourly sales, item mix,
and loss-control counters.

## Decision
- `GET /reports/dashboard?from&to` (permission `report.financial`) returns one snapshot for a range of
  business dates, plus the previous period of equal length. Implemented in `modules/reports`
  (reports may read other modules' tables, rule 8). All SQL is read-only and amounts are integer paisa.
- **Net sales** = Σ(subtotal − discount + service charge) − refunds (net of tax). Tax is excluded.
- **Cost of food** = Σ `order_items.cost_paisa_snapshot` of settled orders (recipe cost frozen at sale).
- **Net profit** = net sales − cost of food − expenses. Stock purchases are information only, not an
  expense (the food is costed when sold), so nothing is counted twice.
- The response states `uncostedLines`; the UI warns that profit is overstated when dishes have no recipe.
- Expenses count on the day entered (cash basis). The UI says so; "This month" gives the true view.
  Accrual-style spreading of rent/salaries is deferred (OPEN-QUESTIONS).
- Hours use `Asia/Karachi` (no DST). Hard-coded for now; becomes a branch setting if a second timezone appears.
- UI: no chart library; two small SVG charts drawn to one scale, themed with the app palette.

## Consequences
- No new tables or migrations; the dashboard is a pure read of existing ledgers.
- Labour cost is only visible if the owner enters salaries as an expense category; prime cost is not
  computed separately yet.
- `pnpm demo:history` replays 21 days through the real API for demos (dev only).

## Addendum: kitchen speed
`dashboard.kitchen` times tickets from the kitchen-screen timestamps: wait = sent -> started, cook = started
-> ready, total = sent -> ready. Only tickets that reached READY are timed; durations over 3 hours are
treated as forgotten taps and excluded (counted separately, along with tickets never marked ready). It reports
the median (robust to outliers), the average, the slowest-10% (p90), the share ready within 15 minutes and over
25 minutes, per station, per local hour sent, and the median of the previous period for comparison.
