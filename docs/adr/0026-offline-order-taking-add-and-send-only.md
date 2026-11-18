# 0026 — Offline order-taking: add dishes and send to kitchen, nothing else

Status: accepted (the owner chose option (b) of OPEN-QUESTIONS #45). Narrows ARCHITECTURE decision 13
("writes are not queued offline") for exactly two commands.

## Context
A till that loses its internet must not stop taking orders, but the server stays the single source of
truth: bill numbers, tax and fiscal numbers are assigned there at settlement, and what a fiscal
authority allows offline is unknown (#6, #34).

## Decision
Only two commands may be kept on the device and sent later:
1. **Add a dish** to an order that is already OPEN (`POST /orders/:id/items`).
2. **Send to kitchen** (`POST /orders/:id/send`).

Everything else needs the server and fails at once with `OFFLINE`: opening a new table or takeaway,
changing a quantity, voiding, billing, discounts, payments, refunds. A bill cannot be asked for while
anything of that order is still waiting.

Safety:
- **No double dishes.** Every kept command has a random id sent as `Idempotency-Key`. The server
  stores the first answer with the key *in the same transaction* as the change (`order_command_keys`,
  migration 0017, the order row lock serialises two tries), so a retry after a lost answer adds nothing.
  A key reused on another order is refused (`IDEMPOTENCY_KEY_REUSED`). `send` is naturally safe: a
  repeat finds nothing new (`NOTHING_TO_SEND`, treated as done).
- **Order is kept.** Commands go oldest first, one at a time. No connection, a server error or an
  expired session stops the run and keeps everything; the run repeats every 10 s while online.
- **Nothing is lost silently.** What the server refuses (order closed, dish sold out, no station) is
  marked FAILED with the server's reason, shown in a red bar for a person to open, retry or drop.
- **The kitchen is not told, and the cashier is told so.** While anything is kept the app says, in the
  banner, in the cart ("Waiting for internet / Not sent to the kitchen yet") and in the toast, that the
  kitchen has NOT received it and the cashier must tell them. Kitchen printing happens only when the
  server gets the command.
- No totals are computed on the device: kept dishes are listed without prices; the server prices them
  when they arrive (rule 5).

To show screens without internet the device keeps a small copy of `me`, `menu`, `order` (latest 30),
`floor`, `day` and `shift` in `localStorage` (7 days), wiped at sign-out. The kept commands themselves
are NOT wiped at sign-out (an unsent order must never be lost); they go out under whoever is signed in
when the connection returns, so the audit trail then names that person.

## Consequences
- An order can only be added to if this device has already opened it. Tables first opened while offline
  are not possible (a new table needs the server to give it an order and to refuse a second one).
- Two tills adding to one table offline both succeed when back (it is the same order); a closed or
  billed order refuses the late dish and the red bar shows it.
- Option (c) (the restaurant's own LAN server) remains the answer for a till that must never stop,
  including billing.
