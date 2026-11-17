# ADR 0022 — Configuration can be deleted only while nothing uses it

Status: accepted. Refines CLAUDE.md rule 2 for configuration (not for money).

## Context
Tables, areas, stations, printers, categories, dishes and their variants were create-and-switch-off only
(`crudRouter` had no DELETE on purpose). In practice a restaurant needs to correct mistakes and remove
things it never used: a mistyped table, a test dish, a category made by accident. Categories and stations
could not even be created from the screens (only through a CSV import), so the first dish had nothing to
choose from.

## Decision
- A DELETE exists for tables, areas, stations, printers, categories, dishes and variants. It succeeds only
  for a row that **nothing refers to**. The database's foreign keys are the final judge (order lines, orders
  at a table, bills, deal options, recipes); a row that is referenced answers **409 `IN_USE`** with a plain
  sentence ("…is used by earlier records, so it cannot be deleted. Switch it off instead.").
- Dishes and variants also get a friendly pre-check ("it is on N order lines"). A category with dishes or
  sub-categories, and a dish's last variant, are refused with their own message.
- Every delete is audited (`<ENTITY>_DELETE`, with the row as it was).
- Money and its history are unchanged: payments, bills, stock movements, expenses, purchases and the audit
  log stay append-only. People (users) and ingredients are never deleted (their sales and stock movements
  are on record); they are switched off and can be edited (name, role, reorder level).
- Categories and stations can be created, renamed and deleted from the Menu screen, and a new dish can
  create one on the spot.

## Consequences
- Nothing that history points at can disappear, so reports and old receipts stay complete.
- "Switch it off" stays the way to retire something that was used.
- New stable error code `IN_USE` (docs/ERROR-CODES.md).
