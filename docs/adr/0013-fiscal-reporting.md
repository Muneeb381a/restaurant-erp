# ADR 0013 — Fiscal reporting outbox (M7)

**Status:** accepted for the pipeline; **real authority drivers (PRA / SRB / KPRA / BRA / FBR) are NOT built** — they need each authority's API specification, test credentials and certification (OPEN-QUESTIONS #20). Everything else is in place and runs against a `MockFiscalProvider`.

## Decisions

- **Outbox, never inline** (rules 4 and 9): a settled bill and every credit note is queued in `fiscal_jobs` **inside the transaction that creates it** (idempotency key `provider:docType:docId`, unique). The sale, the drawer and the printer never wait for or fail because of the internet. Reporting runs in the worker process (embedded in dev), every 5 s.
- **Off unless asked:** a job is only created when tax is ON **and** `fiscal.provider` is not `OFF` (setting needs `tax.manage`). Today the choices are `OFF` and `MOCK`.
- **Worker** (`processFiscalJobs`): claims one due job with `FOR UPDATE SKIP LOCKED` (a crashed worker's `IN_FLIGHT` job is recovered after a 2 min lease), calls the provider **outside any transaction**, then records the outcome in a second transaction. Success -> job `DONE`, the bill/credit note gets `fiscal_status=SUBMITTED`, the authority's invoice number, QR payload and time. A **retryable** error (network, 5xx) -> `FAILED` with exponential backoff 30 s, 1 m, 2 m, 5 m, 10 m, 30 m, then hourly, forever. A **permanent** refusal -> `FAILED` + `permanent`, the document shows `FAILED`, and nothing retries it until a person with `tax.manage` presses Retry (audited `FISCAL_RETRY`).
- **A credit note waits for its original invoice:** it is reported against the original's fiscal number; if the bill is not reported yet the job is deferred 15 s without counting an attempt.
- **Provider contract** (`packages/fiscal-adapters`): `FiscalProvider.submit(FiscalInvoice) -> {invoiceNo, qr}`, `FiscalError{retryable}`, `validateFiscalInvoice` (lines sum to the tax, seller NTN/STRN present, credit note references the original). A provider must be **idempotent by `idempotencyKey`**: a repeated request returns the same invoice. The invoice document is built from the stored line taxes (ADR 0012), so what is reported is exactly what was charged.
- **Receipts:** the first receipt prints "Fiscal invoice: pending" (LAN-first: it cannot wait); a reprint after reporting carries "Fiscal invoice: <no>" and a QR code (`GS ( k`). The payment screen polls until the number arrives.
- **Evidence:** `fiscal_jobs` are never deleted and a `DONE` job is immutable (trigger); the request and response are stored.
- **Admin -> Fiscal:** counts (reported / waiting / retrying / rejected), the not-yet-reported queue with Retry, and a **daily reconciliation** (`GET /fiscal/reconciliation`): sold tax vs reported tax, the list of unreported bills, `balanced` true/false. Needs `report.financial` (retry needs `tax.manage`).

## Limits

- No real authority adapter; the bitmap (Urdu) receipt prints the number but no QR; reporting is per document, not batched; a day cannot be "locked" until reconciled (a future option once the authority's rules are known).
