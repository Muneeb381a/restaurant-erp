# ADR 0018 — Day summary, setup checklist, popular dishes

**Status:** accepted

## Context
Three small tools that make the system easier to run: the owner wants the day's result on their phone without opening
the dashboard; a new restaurant needs to see what is still missing before the first sale; waiters order the same
dishes again and again.

## Decisions
- **Day summary.** `GET /reports/day-summary?date=&lang=en|ur` (`report.financial`) returns the dashboard's figures for
  one business date as a short message. The wording is a pure function in `@erp/domain` (`formatDaySummary`,
  property-tested; "Rs" grouping, no floats, nothing computed except display percentages) so the text and the
  dashboard can never disagree. It says "No sales today." on an empty day and warns when profit ignores dishes
  without a recipe cost.
- **Sending is the person's tap, not the server's.** The web app builds a `https://wa.me/<number>?text=…` link
  (Pakistani `03xx` numbers are normalised to `923xx`). Nothing is sent from the till, so it needs no WhatsApp
  account, API key or outbox job, and nothing in the order -> bill -> print path touches the internet. The owner's
  number is the setting `report.owner_phone` (digits, optional `+`; empty = WhatsApp asks who). The summary is offered
  when the day is closed and from the dashboard for any single day. An automatic nightly send needs a messaging
  provider; it would go through the outbox and is not built (OPEN-QUESTIONS #38).
- **Setup checklist.** `GET /setup/status` (`settings.manage`) only counts rows (restaurant details, tables,
  priced menu, printers, staff, payment methods, open day; optional: QR menu, verified tax rules) and returns which
  steps are done. Admin -> Business -> Setup shows it; the Tables page shows a banner to owners until it is ready.
  It never blocks selling.
- **Popular dishes.** `GET /menu/popular?days=14&limit=10` returns item ids and units sold (not voided, orders not
  cancelled, last N business days). The order screen shows a "Popular" tab when at least three of them are on today's
  menu. The default view is still "All".

## Consequences
- The summary reuses `dashboard()`, so it costs one dashboard query per request.
- Message text is English or Urdu; amounts keep Latin digits.
