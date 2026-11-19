# 0028 — "Delete" archives what history points at

Status: accepted. Replaces the refusal half of ADR 0022 for dishes, sizes and tables.

## Context
ADR 0022 refused to delete anything past orders or bills point at, and told the owner to "switch it off".
Shop owners rightly found that useless: a dish nobody sells any more still sat in the lists, dimmed, for ever.
History must stay complete (rule 2), but the owner must be able to get rid of a thing.

## Decision
- Deleting a **dish, a size (variant) or a table** does the real delete when nothing refers to it, and
  otherwise **archives** it (migration 0018: `archived_at`). An archived row is switched off, hidden from every
  list (menu admin, tables, import, recipes, till, QR menu) and its code is free again (the unique index on
  `code` now covers live rows only). Old orders and bills keep working: they store the name they were sold under.
- It is refused only while it is in use **right now**: a dish or size on an OPEN or BILLED order, a dish
  inside a live deal, a table with an open order. The message names the order.
- The API answers 204 either way; `X-Archived: true` says it was archived. The audit log records
  `ITEM_ARCHIVE`, `VARIANT_ARCHIVE` or `DINING_TABLE_ARCHIVE` (what was archived and how many order lines used it).
- Categories keep the move-the-dishes flow (they are not on orders). Stations, areas and printers still
  answer `IN_USE` when history points at them; they have no hidden state yet.

## Consequences
- Nothing financial is deleted or edited; reports and old receipts are unchanged.
- Restoring an archived row is not offered in the app (it can be done in the database).
