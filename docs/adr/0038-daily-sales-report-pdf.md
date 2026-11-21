# ADR 0038 - Daily sales report (PDF)

Status: accepted

## Context
The owner wants, for any day, every bill with its amount and the day's sales in a file that can be kept or sent.
The Bills list also showed nothing for "today"/"yesterday" because it filtered by business-day date, and a business
day can stay open for days.

## Decision
- A "day" is the calendar day the bill was settled (or made, if unpaid) in the branch time zone, on the Bills screen
  and in the report alike. Business-day labels are not used for filtering.
- `GET /reports/daily-sales?date=YYYY-MM-DD` returns the figures and every bill; `GET /reports/daily-sales.pdf?date=`
  returns the same as an A4 PDF attachment. Permission `report.view` (cashiers have it). Sales only: costs and profit stay
  behind `report.financial` on the dashboard.
- Arithmetic is pure in `packages/domain/src/reports/daily-sales.ts` (integer paisa; property test: the total by method,
  type, hour and cashier all equal the day's total). The API gathers rows, the domain adds them up, `daily-sales.pdf.ts`
  draws them.
- Contents: headline figures, how the total is made (sales, discounts, service charge, tax if any, round-off, refunds),
  money by payment method, sales by order type, source (online/phone), hour, cashier, category and best-selling items,
  discounts with reasons, refunds (credit notes), dishes voided after the kitchen ticket, and the full bill table.
  Unpaid (printed) bills are listed and flagged but not counted as sales.
- PDF library: `pdf-lib` (new dependency, MIT, pure JavaScript). It needs no font files or native code, so it runs the
  same on the restaurant server and in a serverless cloud, unlike libraries that read font files at run time.
- English only. The standard PDF fonts cover Latin text; other characters (an Urdu customer name) print as "?".
  An Urdu report would need an embedded font and text shaping and is not part of this change.
