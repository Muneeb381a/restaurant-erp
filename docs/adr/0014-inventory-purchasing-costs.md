# ADR 0014 — Inventory, recipes, purchasing, stocktake, expenses (Phase 2 core)

**Status:** accepted. Delivery/riders, WhatsApp, advance (dawat) orders, A4 invoices and accounting export are NOT built.

## Decisions

- **One ledger, append-only.** `stock_movements` (kinds OPENING, PURCHASE, SALE, WASTAGE, STAFF_MEAL, ADJUSTMENT, PREP_IN/OUT, ...) is never updated or deleted (trigger); stock on hand = SUM. A trigger checks the **sign by kind** (a sale cannot add stock, a purchase cannot remove it) and that the ingredient belongs to the movement's branch. Every command that writes movements is idempotent (`Idempotency-Key` or a deterministic key such as `sale:<order_item>:<ingredient>`).
- **Integer maths** (`packages/domain/src/inventory/stock.ts`, 100 % coverage, property tests): quantities in thousandths of the base unit (g / ml / pcs), costs in micro-paisa per *usable* base unit, half-up everywhere. The usable cost divides the purchase price by the unit factor **and by the yield** (bones and fat are paid for but not served). Average cost is the **weighted average** at every receipt; with nothing (or negative) on hand the new cost applies.
- **Units:** the base unit is the smallest stored unit; purchase units (kg, litre, dozen...) convert with `purchase_to_base`. A recipe quantity is per ONE sold unit, or per 1000 g for weight items (scaled by the sold grams).
- **Consumption at settlement, in the settle transaction, before the order is frozen.** Every non-void order line whose variant has a recipe (deal components included; the deal line itself has none) writes one SALE movement per ingredient and stores the line's food cost (`order_items.cost_paisa_snapshot`), so later price/recipe changes never rewrite history. **Selling below zero stock is allowed** (shown red, reported) - the till must never refuse a sale because a purchase was not typed in yet. Credit notes do **not** restock (returned food is waste; use wastage if desired).
- **Prep items** (gravy base, boiled mutton): a prep recipe with an output quantity; a batch consumes the components (PREP_OUT) and adds the prepared item (PREP_IN) at the carried-over cost.
- **Purchases are posted documents** (immutable): lines, PURCHASE movements, new average costs and - if paid now - a supplier payment, in one transaction; the same supplier invoice number cannot be entered twice. What is unpaid stays **owed to the supplier** (`purchases - supplier_payments`); later payments cannot exceed it. Paying needs `expense.manage` in addition to `stock.manage`.
- **Cash from the drawer** (purchase, supplier payment, expense) goes through the shift's drawer logic (`drawerPayout`): own open shift, cannot exceed the cash in the drawer, recorded as a PAID_OUT cash movement, so the shift's expected cash and Z-report stay right; owner cash and bank do not touch the drawer.
- **Stocktake:** one open count at a time; lines snapshot the system quantity; counted differences post as ADJUSTMENT movements (uncounted lines untouched); a posted count is immutable (trigger).
- **Reports:** stock with value and reorder alerts; recipe cost vs dine-in price (food cost %); food cost by item and totals for a date range (lines without a recipe are flagged), wastage and staff-meal value; expenses by category.
- **Migrations:** the inventory/finance schema is the `phase2` migration set (`migrations-phase2`); `pnpm db:migrate`, `db:reset`, the Docker command and the test harness now apply **core then phase2**.

## Limits

- Theoretical (recipe) consumption only; the stocktake is the correction. No multi-branch transfers UI, no purchase orders/returns to supplier UI, no batch/expiry tracking, no barcode scanning.
- Cost of modifiers (extra raita...) and of deal components with their own recipes depends on each having a recipe.
