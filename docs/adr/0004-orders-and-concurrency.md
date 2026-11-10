# ADR 0004 — Orders, line pricing and concurrency (M3a)

**Status:** accepted (M3a: domain + API; live updates and screens are M3b)

## Decisions

- **The server prices every line.** The client sends item, variant, quantity, weight, modifier ids and deal picks — never prices. The server looks the price up in the order's price list for the order's *business date* (`findPrice`), validates modifiers/deal picks with the pure domain functions, and prices the line with `priceLine` (integer arithmetic only). The unit price is **snapshotted** on the line: later menu price changes never touch lines already on an order.
- **Weight pricing** is `round_half_up(price_per_kg × grams / 1000)` in BigInt (`mulDivHalfUp`); a weighed line has qty 1, the weight is the quantity. Modifier deltas are added once per unit (once for a weighed line).
- **Deals.** The parent line carries the price (`deal price + option upcharges`); component lines are children with `unit_price 0` whose `line_total_paisa` holds their **allocated share** of the parent total (`allocateDealLine`: pro-rata to list prices, leftover paisa to the last component, Σ parts = whole). Components keep their own station (KOT routing) and tax category (tax-by-category later). Order subtotals count top-level lines only, so nothing is counted twice. Changing a deal's quantity scales the components and re-allocates.
- **Names.** Printed line names are `Item` for single-variant kinds (WEIGHT, DEAL, "Regular") and `Item (Variant)` otherwise, in English and Urdu.
- **Optimistic locking.** `orders.version` increments on every change. Structural commands (header edit, transfer, merge, cancel) **require** `If-Match: <version>` (428 without it, 409 `VERSION_CONFLICT` with `currentVersion` if stale). Item commands are commutative — two captains adding to one table is normal — so `If-Match` is optional there but must match when sent. Every command starts with `SELECT … FOR UPDATE` on the order row, so concurrent commands serialise and nothing is lost (tested with 10 parallel adds).
- **One open order per table** is enforced by the partial unique index; a losing race surfaces as `TABLE_OCCUPIED` with the winner's order id. Merge locks both orders in id order (no deadlocks) and moves lines **and KOTs**; the source becomes CANCELLED and frees its table. Transfer/merge/cancel and voids after the kitchen saw an item are audited with before/after.
- **Void rules** come from the domain (`voidRule`): free while NEW; after sending it needs `kot.void` + a reason (checked in the service because it depends on the line's state) and is flagged as wastage once prepared/served. Cancelling an order requires every line to be NEW or VOID. Lines can be edited only while NEW.
- **Business day and shifts.** `day.open` opens the trading day (dates only move forward; one open day per branch); a cashier opens a shift with a counted float; one open shift per cashier and per till (partial unique indexes). Closing is M6.
- **Order lines are frozen** by a DB trigger once the order is SETTLED/CANCELLED (insert/delete/any change to what was sold is refused; the kitchen may still progress `status`/`kot_id`, e.g. a takeaway paid before it is ready, but a line cannot be voided). This closes the gap noted in M0 where only `bill_lines` were immutable.
- **Hold/resume** parks an order (`held_at`); edits are refused while held.

## Consequences / limits

- No idempotency key on `POST /orders` yet; a double tap on a takeaway creates two orders (dine-in is protected by the table index). Planned with the print/KOT outbox work.
- Edits to a deal's *choices* require void + re-add (only quantity changes are supported in place).
- Floor/order lists are polled until M3b adds WebSocket events (`table.status`, `order.updated`).
