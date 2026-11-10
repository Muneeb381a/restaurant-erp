# ADR 0009 — Khata (customer credit) (M6c)

**Status:** accepted (advance deposits, due dates and statements wait for OPEN-QUESTIONS #31)

## Decisions

- **Append-only ledger with a signed amount.** `khata_entries` rows are never changed or deleted (trigger). Each row has a `kind` — `CHARGE` (+), `PAYMENT` (−), `REFUND` (−, credit notes), `ADJUST_UP` (+), `ADJUST_DOWN` (−) — and a database-generated `delta_paisa`. The balance is `SUM(delta_paisa)`; nothing stores a balance that could drift. The pure rules live in `packages/domain/src/khata/ledger.ts` (100 % branch coverage, property tests).
- **The database enforces the rules, under a per-account lock.** A BEFORE INSERT trigger locks the account row, then refuses: a charge above the credit limit or on an inactive account, and a payment larger than the balance. Two simultaneous credit sales therefore cannot both fit under the limit (tested with parallel inserts and parallel HTTP settles). The API checks first for friendly errors (`KHATA_LIMIT_EXCEEDED` with the available credit); the trigger is the backstop. A limit of 0 means no credit.
- **Every entry is traceable** (CHECK): a charge points at its bill and its payment row (and a payment can be charged to khata only once); a payment has a method and the shift that received it; an adjustment has a reason.
- **Credit sale = a normal tender.** The `KHATA` payment method is an ordinary tender in the settle transaction (still exact-amount, never over-tendered, no tip): payments row first, then `chargeKhata` writes the CHARGE, then the bill flips to SETTLED — all or nothing. Needs `khata.collect` and a `khataAccountId`; at most one khata tender per bill; it can be split with cash/card. The bill's tax payment class stays `CASH_OTHER` (khata is not a digital tender). The receipt names the customer.
- **Collecting payments** (`POST /khata/accounts/:id/payments`, `khata.collect`, mandatory `Idempotency-Key`): needs the cashier's own open shift (the DB refuses otherwise). **Cash received is part of the drawer**: expected cash = … + khata cash received; the shift slip and Z-report show it, and the day report shows khata charged and collected.
- **Adjustments** (opening balances from the paper register, write-offs) need `customer.manage`, a reason, and are audited. Accounts (customer + credit limit) are created and switched off by managers; every change is audited. Customers are unique by phone number (existing index).
- **Permissions:** `khata.collect` (OWNER, MANAGER, CASHIER) lists accounts, takes khata at settle and receives payments; `customer.manage` (OWNER, MANAGER) creates accounts, sets limits, adjusts.

## Consequences / limits

- No advance deposits, due dates, interest, statements or WhatsApp reminders (OPEN-QUESTIONS #31).
- A credit note on a khata-paid bill will post a `REFUND` entry (next step); the entry kind and column already exist.
- Customer data is minimal (name, phone, notes) per ARCHITECTURE §PII.
