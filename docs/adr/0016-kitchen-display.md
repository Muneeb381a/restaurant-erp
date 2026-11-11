# ADR 0016 — Kitchen display and "food ready" signal

**Status:** accepted

## Context
Kitchen tickets were printed per station, but nobody could see their progress. Waiters had no signal
that food was ready, and the owner had no preparation times.

## Decision
- A ticket (`kots`) moves NEW → PREPARING → READY → DONE, one step back allowed (a mis-tap can be undone).
  Timestamps `started_at`, `ready_at`, `done_at` are stored (migration 0013). Ticket lines follow:
  SENT / PREPARING / READY / SERVED. Cancelled tickets cannot move.
- `GET /kitchen/board` (`kitchen.view`) lists the open business day's tickets that are not finished, plus
  tickets served in the last 30 minutes, with lines, table, captain and rush flag. Tickets of closed days
  and cancelled orders never show.
- `POST /kots/:id/status` — `kitchen.update` for cooking and ready, `kitchen.serve` (or update) for served.
- `/floor` adds `ticketsReady` per open order; tables with ready food show "Food ready" and pulse.
- Live: the existing change stream refreshes the board; ages use the server clock, so a wrong tablet clock
  cannot show wrong times.
- Roles: OWNER and MANAGER all three; KITCHEN view and update; CAPTAIN and CASHIER view and serve. A user with
  only kitchen rights lands on the Kitchen screen after sign-in.

## Consequences
- Printing is unchanged: the printed ticket remains the primary hand-off; the screen is additive.
- Average preparation time per station can be added to the dashboard later from `started_at`/`ready_at`.
