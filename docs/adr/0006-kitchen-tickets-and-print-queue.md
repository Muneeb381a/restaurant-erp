# ADR 0006 — Kitchen tickets and the print queue (M4a)

**Status:** accepted (M4a: KOT, queue, worker; the receipt bitmap renderer is M4b)

## Decisions

- **Send = one transaction.** `POST /orders/:id/send` locks the order, takes its NEW lines and creates **one KOT per station** (`next_doc_no`, gap-free per day), marks the lines SENT, and queues one print job per active KOT printer mapped to the station — all or nothing. Deal components go to the stations of their *own* items; the deal's parent line prints nothing. An item without a station aborts the whole send (`STATION_MISSING`, loud rather than guessed). A repeated send finds nothing new (`NOTHING_TO_SEND`); two simultaneous sends are serialised by the order row lock (tested). Optional: only one `course`, and `rush`.
- **Stations without a printer** still get a KOT (it exists for a future KDS) and are reported as `unprinted` so the counter can see it; `kot.print_on_send = false` skips printing entirely.
- **The ticket is rendered at creation and stored as bytes** (`print_jobs.payload`). A printer outage, restart or retry therefore reprints exactly the same ticket, and rendering never depends on later data changes. KOTs are text-mode ESC/POS in English (`packages/printing`): station, table/type, order no., waiter, time, big bold lines, modifiers, notes, deal name; 58 mm (32 col) and 80 mm (48 col) layouts; RUSH, REPRINT #n and CANCEL banners. Non-ASCII never reaches the printer (replaced by `?`) — Urdu text mode is unreliable, Urdu receipts will be bitmaps (M4b).
- **Outbox + worker.** `print_jobs` has an `idempotency_key` (unique, rule 4), a `seq` for strict per-printer order, status `PENDING/IN_FLIGHT/DONE/FAILED/DEAD`, attempts, `next_attempt_at`, a lease, and the last error. The worker (`apps/api/src/worker.ts`; in development embedded in the API process) runs every second:
  - **Strict order per printer**: a per-printer advisory lock serialises the claim, a job in flight blocks its successors, and a failing head job holds back later ones until its backoff expires — a ticket never overtakes an older one. Different printers drain in parallel, so one dead printer does not stop another.
  - **Backoff** 2 s, 4 s, 8 s, 16 s, then every 30 s; **no attempt cap** — a printer that is off for ten minutes catches up when it returns. A ticket older than 2 h is useless and is parked as `DEAD`; an admin can re-queue it (`POST /print-jobs/:id/retry`, audited). Unsupported connections (USB/serial, not implemented) and deactivated printers go `DEAD` immediately without blocking the queue.
  - **No duplicates**: the claim is transactional (two workers cannot take one job); success is recorded right after the bytes were flushed. Plain TCP printers send no acknowledgement, so a duplicate is only possible if the process dies in the instant between the write and that update — accepted and documented. A crashed worker's IN_FLIGHT job is recovered when its lease (30 s) expires.
- **Printer health** (`GET /printers/health`, visible to every user): `OK / OFFLINE / UNKNOWN / INACTIVE`, queue length and the last error, derived from the last attempt (a success clears the error). The web app shows a red banner when a kitchen printer is offline.
- **Cancel tickets.** Voiding a line after the kitchen saw it (needs `kot.void` + reason, audited) also queues a `CANCEL` ticket on the printer(s) of the original KOT's station, per component for a deal. Free voids (NEW) print nothing.
- **Reprint** (`POST /kots/:id/reprint`): needs `kot.reprint` and a reason, is audited, increments `print_count`, and prints "REPRINT #n".
- **History is kept**: print jobs cannot be deleted (trigger).

## Consequences / limits

- The receipt renderer (Urdu bitmap via node-canvas + Nastaliq font) and the cash-drawer kick are M4b/M5; USB/serial printers are not supported yet (LAN printers only, per ARCHITECTURE §3).
- Printer models/paper widths are still unconfirmed (OPEN-QUESTIONS #8); the encoder uses plain Epson-compatible commands.
- Kitchen progress (PREPARING/READY/SERVED) is the KDS (Phase 3); today lines stay SENT.
