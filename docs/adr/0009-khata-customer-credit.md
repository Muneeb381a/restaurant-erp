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

## Addendum — seeing who owes, and since when

- **Age of a debt = first in, first out.** Payments settle the oldest credit first, so what is still owed is made of the newest increases. `owingSince` is the date of the oldest increase (`CHARGE` or `ADJUST_UP`) still inside that balance; `lastPaymentAt` is the newest `PAYMENT`. Computed in one SQL query (`agingOf`), read-only, nothing stored. If the restaurant settles bills differently (a customer says "this payment is for the March bill"), the age is an estimate; the balance itself is exact.
- **Each ledger row carries the balance after it** (window `SUM(delta_paisa) OVER (ORDER BY seq)`), so a customer disputing a figure can be walked down the page.
- **A write-off (`ADJUST_DOWN`) cannot exceed the balance**, like a payment: money paid ahead is not supported until OPEN-QUESTIONS #31(b) is answered. Before this it could push a balance below zero and silently raise the customer's available credit above their limit.
- **One customer per phone number, however it is typed** (last ten digits compared), with `KHATA_PHONE_EXISTS` naming the owner. The unique index alone missed `0300-1234567` vs `03001234567` vs `+92 300 1234567`.
- **The list shows up to 200 accounts (was 50, with no way to see the rest)**, sorted by biggest debt or by name, and `GET /khata/summary` totals every account (owed, customers owing, near limit) for the strip at the top.
- **Reminders are a WhatsApp link the person sends**, in Urdu or English, with the exact amount (same approach as the day summary: no server-side sending, no consent or opt-out to manage). Whether to send them automatically, and after how many days, is still OPEN-QUESTIONS #31(c).

## Consequences / limits

- No advance deposits, due dates, interest, statements or WhatsApp reminders (OPEN-QUESTIONS #31).
- A credit note on a khata-paid bill will post a `REFUND` entry (next step); the entry kind and column already exist.
- Customer data is minimal (name, phone, notes) per ARCHITECTURE §PII.
