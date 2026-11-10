# ADR 0003 — Menu model, prices and CSV import (M2a)

**Status:** accepted (M2a: API + domain + CSV; the admin screens come in M2b)

## Decisions

- **Three kinds of item.** `STANDARD` (variants such as Half/Full/Single), `WEIGHT` (one variant "Per kg"; the weight is entered at order time, priced in M3) and `DEAL` (one variant "Deal" carrying the deal's price). A karahi sold as "½ kg / 1 kg" at fixed prices is a normal STANDARD item with two variants — only items that are actually weighed are WEIGHT. The kind can never change once an item has orders or deal slots (DB trigger).
- **Prices.** One price per (variant, price list) per day, enforced by a Postgres EXCLUDE constraint (`btree_gist`): periods cannot overlap, so a price lookup is never ambiguous (same philosophy as tax rules — never guess). History is kept: "from date D this costs X" closes the running period on D-1 and opens a new one; a same-day correction edits today's row; the past and conflicting schedules are refused. `packages/domain` resolves prices by business date (`findPrice` / `resolvePrice`); no price on a date means "not sold there", never zero.
- **Channels.** An item is offered on a channel (price list) only if it has a price in that list (OPEN-QUESTIONS #25 default). `GET /menu/warnings` lists what is hidden.
- **Modifiers.** Groups have `min_select`/`max_select`, a stable `code`, and attach to items in an order. Selection rules (unknown, inactive, duplicate, min, max) live in the domain.
- **Deals.** A deal is a list of slots; each slot needs exactly `qty` picks from its options (the same option may be picked several times — "4 × naan"). A fixed component is a slot with one option; defaults pre-fill. Options are real item variants and can never be deals (trigger), so there are no nested deals. Editing a deal replaces its whole structure. Validation is pure (`validateDealSelection`, `defaultDealPicks`).
- **POS read model.** `GET /menu?priceList=&date=` returns one payload per (branch, price list, business date) with only priced, active items (items in inactive categories are hidden too). It carries a content-hash `ETag`; clients revalidate with `If-None-Match` (304). The API is a single process, so a per-branch revision counter, bumped by every menu command (and by import), invalidates an in-memory cache — no revision table. A date rollover naturally yields a new cache entry.
- **No deletes.** Menu rows are deactivated (`is_active`), never deleted; order lines snapshot names and prices anyway. Every menu change is audited with before/after in the same transaction (rule 7); the 86 toggle audits only real changes.
- **CSV import** (one row = one variant; `price_<pricelist>` columns in rupees; blank price = not sold on that channel; blank optional cell = leave unchanged). Validation and diffing are pure domain code (`parseMenuRecords`, `planMenuImport`); the API only parses CSV (`csv-parse`) and applies the plan. A call is a **dry run unless `dryRun=false`**; applying is one transaction (all or nothing); re-importing the same file changes nothing; export → import is a no-op. Imports never delete, never touch deals and never change an item's kind. Money is parsed with integer arithmetic (`parseRupees`), never floats.
- **Business dates are strings.** `date` columns are parsed as `YYYY-MM-DD` strings (not JS `Date`) and typed as `DateString`, so day boundaries cannot shift with the server timezone.
- **Tax.** Items get the default `RESTAURANT_SERVICE` tax category (reference data). No tax logic is part of M2; see M5.

## Consequences / limits

- The CSV supports flat categories only (top level); nested categories are managed in the API/app, and a nested category exported to CSV is matched by name at the top level on re-import.
- Prices scheduled in the future block CSV changes for that variant until resolved in the app.
- `exportMenuCsv` does not protect against spreadsheet formula injection; menu names are trusted staff input.
- The in-memory menu cache is per process; if the API is ever scaled to several processes, replace the revision counter with a DB-backed one.
