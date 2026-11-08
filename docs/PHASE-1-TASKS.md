# Phase 1 (MVP) — Milestones with acceptance criteria

Rule: finish a milestone completely (code + tests + docs) before starting the next. Each milestone ends with a short demo script in `docs/demo/Mx.md`.

## M0 — Foundation (≈3–4 days)
- pnpm monorepo, TS strict, ESLint/Prettier, Vitest, Husky pre-commit (lint+typecheck), GitHub Actions CI.
- `ops/docker-compose.yml` (postgres, api, worker, caddy), `.env.example`, health endpoint.
- Migrations: port `db/001_core.sql` + `db/002_*` (002 may stay un-applied until Phase 2) as numbered migrations; add `print_jobs` table when needed (M4).
- `db:reset` loads `db/003_seed_dev.sql`.
- Kysely types generated from DB; shared error model (problem+json); pino logging; request id.
**Accept:** `pnpm dev` boots; `/health` OK; CI green; DB tests prove immutability triggers (copy cases from `db/` test ideas: payments update blocked, settled bill edit blocked, overpay blocked, 1 open order per table).

## M1 — Auth, RBAC, setup (≈1 week)
- PIN + password login, JWT + rotating refresh (`sessions`), device tokens, permission middleware, lockout.
- Admin CRUD: branch/settings, users/roles, areas+tables, stations, printers, payment methods, price lists.
- Audit log writer utility + admin audit viewer (read only).
**Accept:** permission matrix tests (each seeded role vs sensitive endpoints); PIN lockout works; audit rows for user/role changes.

## M2 — Menu (≈1–1.5 weeks)
- Categories, items (STANDARD / WEIGHT / DEAL), variants (Half/Full…), prices per price list with effective dates, modifier groups, deal slots/options, availability toggle (86).
- Bulk import (CSV) for menu; Urdu + English names.
- Menu read-model endpoint optimised for POS (single payload, ETag) + web admin screens.
**Accept:** create the real restaurant menu through UI/CSV; price lookup tests per list/date; deal validation (slot min/max).

## M3 — Floor & orders (≈1.5 weeks)
- Business day open; shift open (float); floor view with live table status.
- Create dine-in/takeaway/delivery orders; add/edit items with variants, modifiers, weight, notes, courses; hold/resume.
- Table transfer, merge; optimistic locking; WS table updates.
- `packages/domain`: line pricing (incl. weight + modifiers + deal allocation) with property tests.
**Accept:** two captains on different tablets see each other's changes live; concurrency test (same table) passes; pricing tests green.

## M4 — KOT & printing (≈1.5 weeks)
- "Send" creates one KOT per station inside one transaction; KOT numbering via `next_doc_no`.
- Print service: print_jobs outbox, ESC/POS over TCP, retries, printer health, reprint (audited), cancel-KOT for voids, RUSH flag.
- Void rules: before KOT free; after KOT needs permission+reason.
- Receipt/bill renderer prototype (Urdu bitmap) + KOT layout; snapshot tests.
**Accept:** physical (or simulated TCP) printers get correct tickets per station; unplug printer → jobs queue and print on reconnect; no duplicate tickets after retry.

## M5 — Billing & tax engine (≈2 weeks) ⚠ critical
- Pre-bill; discounts with limits/approval; service charge; packing/delivery charge lines.
- Split bill (by item, equal, shared item `portion_bps`) with invariants.
- Tax engine in `packages/domain` + settlement transaction as in ARCHITECTURE §6; both-class preview on pre-bill; mixed-tender policy setting.
- Credit notes (partial refunds) with original-rate tax reversal.
**Accept:** table-driven tests for cash/digital/mixed, discounts, round-off, split, refunds; missing/duplicate rule errors; DB constraints cannot be violated by API; 100% branch coverage on tax/split/money modules.

## M6 — Payments, shift & day close (≈1.5 weeks)
- Tender grid, multi-tender, change, tips, khata tender (basic), idempotent payments.
- Cash drawer: paid-outs, drops, no-sale audit; shift close (expected vs counted, variance), Z-report; business day close checks (open orders, pending fiscal, open shifts).
**Accept:** shift report reconciles to the paisa with seeded scenarios; day-close blocked with open orders; reopen shift audited.

## M7 — Fiscal integration (≈1.5–2 weeks, depends on onboarding)
- `FiscalProvider` interface, **mock provider**, outbox worker with backoff/SKIP LOCKED, fiscal status on bill, receipt shows fiscal no/QR, credit note reporting, reconciliation report.
- Real driver (PRA first or whichever authority applies) behind feature flag; sandbox testing; offline queue behaviour.
**Accept:** kill internet mid-service → bills still settle/print per approved wording → jobs drain after reconnect with no duplicates; reconciliation shows zero mismatches.

## M8 — Reports & owner view (≈1 week)
- Z-report, sales by item/category/hour/waiter, payment-method split (cash vs digital), tax summary, discounts/voids/refunds/reprints exceptions, fiscal reconciliation, delivery/COD basics.
- CSV/Excel + PDF export. Optional WhatsApp daily summary (outbox).
**Accept:** every report ties out to bills/payments totals in tests.

## M9 — Hardening & pilot (≈2 weeks)
- Backups (nightly dump + encrypted cloud), restore script + drill, UPS/power-cut test, load test (50 open tables, 6 printers), security review, Urdu/RTL polish, staff training material (Urdu), paper-fallback SOP.
- **Parallel-run pilot** (2 weeks): old method + new system, daily reconciliation.
**Accept:** restore drill succeeds on a clean machine; pilot discrepancies = 0 or explained; owner sign-off.

---
## Phase 2 backlog (do not start before M9)
Inventory/recipes/purchases/stocktake/food-cost (schema in `db/002`), delivery/riders/COD settlement, khata ledger UI + statements, dawat/advance orders, WhatsApp flows, expenses, A4 invoices, accounting export.
## Phase 3 backlog
KDS, aggregator integration (Foodpanda), online/QR-table ordering, multi-branch + cloud sync, loyalty, local-first clients.
