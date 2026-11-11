# Open questions (answer before the milestone shown)

| # | Question | Needed by | Answer |
|---|---|---|---|
| 1 | Province / tax authority (PRA, SRB, KPRA, BRA, FBR-ICT) and registration numbers (NTN, STRN/PNTN)? | M5 | |
| 2 | CA-confirmed: tax rate for cash vs card/wallet/QR; mixed-tender treatment | M5 | |
| 3 | Is service charge taxable? Packing/delivery charge taxable? Tips treatment? | M5 | |
| 4 | Aggregator (Foodpanda etc.) orders: who collects tax, how to record? | M5/Phase 3 | |
| 5 | Fiscal mode: cloud API or local Software Fiscal Device? Sandbox credentials? | M7 | |
| 6 | Legally allowed receipt wording when fiscal number is not yet available (offline)? | M7 | |
| 7 | Credit-note / refund reporting requirements to authority | M7 | |
| 8 | Printer models, connection (LAN/USB), count per station, paper width | M4 | |
| 9 | Menu: number of items, per-kg items, deals complexity, different prices per channel | M2 | |
| 10 | Rounding: round bill to nearest rupee? Round-off account/reporting? | M5 | |
| 11 | Stock control at launch or later? | Phase 2 planning | |
| 12 | WhatsApp daily summary to owner at launch? | M8 | |
| 13 | Legal retention period for bills/fiscal logs | M9 | |
| 14 | Branch with `tax_authority = NONE` (the dev seed branch): should settlement apply 0% tax (needs explicit `NONE` rules at 0 bps) or skip tax resolution? Rule "missing rule = hard error" currently makes the seed branch unsettleable. | M0/M5 | |
| 15 | Does a KHATA (credit) tender count as `CASH_OTHER` for tax class (seed says yes)? Which rate applies when the khata is paid later by card? | M5 | |
| 16 | Tips: are they outside the taxable base and outside `bills.total_paisa` (current schema: `payments.tip_paisa`)? Does a card tip go through the fiscal invoice? | M5/M6 | |
| 17 | Service charge: if `tax.service_charge_taxable = false`, `bills.taxable_paisa` (= subtotal - discount + service) is no longer the tax base. Add a separate `tax_base_paisa` column? | M5 | |
| 18 | Multiple tax categories on one bill: schema stores one `tax_rate_bps`/`tax_rule_id` per bill and no per-line tax. Add `bill_lines.tax_paisa` + per-category rows? Needed for credit notes at the original rate. | M5 | |
| 19 | Split bills: round-to-rupee per bill or once per order? (Σ rounded bills may differ from the order total by up to Rs 1 per bill.) | M5 | |
| 20 | Fiscal invoice numbering: does the authority require its own gap-free sequence separate from `bill_no`? Can a bill be reprinted without the fiscal number once submitted? | M7 | |
| 21 | Permissions to add to the seed: `price.override`, `drawer.open` (no-sale), `bill.void`, `order.cancel`, `audit.view`, `device.manage`, `menu.availability` (86). KITCHEN role currently has none. Confirm role mapping with the owner. **M1 implemented my proposed mapping** (migration 0002; see docs/demo/M1.md) - adjust via PUT /roles/:id/permissions once confirmed. | M1 | |
| 22 | Dev tooling: Node 24 is installed locally but the stack says Node 22. Pin 22 via `.nvmrc`/`engines`, or allow 24? Is Docker Desktop running for Testcontainers? | M0 | |
| 23 | Real menu: please share the restaurant's actual menu (Excel/CSV/photo): categories, item count, English + Urdu names, sizes, prices. The CSV import format is designed from it. | M2 | |
| 24 | Which items are sold **by weight** (price per kg, weight entered at order time), and which are **fixed-size** portions named in kg (e.g. karahi "½ kg / 1 kg" = fixed prices, not weighed)? Minimum weight / step (e.g. 250 g)? Is there a scale/device or does staff type the weight? | M2/M3 | |
| 25 | Channel prices: are Takeaway/Delivery prices different from Dine-in (e.g. delivery-app markup)? Proposal: an item is sold on a channel only if it has a price for that price list (otherwise hidden there, with an admin warning). Alternative: fall back to the Dine-in price. **M2a implemented the proposal** (hidden + GET /menu/warnings). | M2 | |
| 26 | Deals: how many, and are they fixed (all components set) or choice-based ("choose 1 karahi, choose 1 drink")? Is "serves N persons" just a label? Any deal with an optional upgrade price? **M2a supports fixed and choice slots and per-option upcharges.** | M2 | |
| 27 | Modifiers: which exist (spice level, no onion, extra raita, boneless…) and which carry a price? Are karahi styles (Peshawari / white / namkeen / koyla) separate items or a modifier? **M2a supports modifier groups with min/max and price deltas; either modelling works.** | M2 | |
| 28 | Tax categories: are all items one category (restaurant service), or are packaged goods (bottled water, cold drinks sold sealed) treated differently by the authority? CA must confirm before the menu is final. | M2/M5 | |
| 29 | Roman-Urdu search aliases on items (e.g. "tikka", "tika", "ٹکہ") - assumed yes (`items.search_terms`). Are item photos needed on the POS? (not in schema; would be a Phase 2 addition) | M2 | |
| 30 | Tips: when a customer adds a tip to a cash payment, does it go through the drawer (then the drawer holds it and the expected cash should include it) or is it handed straight to the staff? Card tips: paid out at shift end? Pooled between staff? **M6b leaves tips OUT of the expected cash** (recorded per payment, shown in the report) until answered. | M6b | |
| 31 | Khata: (a) is credit given to anyone or only approved regulars (now: only accounts a manager creates, each with a limit; limit 0 = no credit)? (b) should customers be allowed to pay **in advance** (negative balance / deposit for a dawat)? Now refused (`KHATA_OVERPAYMENT`). (c) any due dates, reminders, or a block after N days overdue? (d) printed statement / WhatsApp reminder format? | M6c | |
| 32 | Refunds: (a) must money go back through the **original tender** (card sale -> card refund) or may a manager choose any method (now: any active method; every refund needs `bill.refund` = managers, a reason, and is audited)? (b) time limit for returns? (c) does a refund need a second approver above some amount? (d) **tax**: credit notes carry tax 0 until M5; they must reverse tax at the ORIGINAL rate (see #18) and be reported to the authority (M7). | M6d | |
| 33 | Tax - things the OWNER/CA must decide in Admin -> Tax (the software ships no rates): (a) authority, NTN/STRN; (b) one category or several (packaged goods?); (c) rates per payment class and from which date, with the source; (d) is the service charge taxable (default yes); (e) **are menu prices tax-exclusive** (assumed: tax is added on top) - tax-inclusive pricing is not implemented; (f) the mixed-tender rule (default: any non-digital tender -> cash rate; PROPORTIONAL is not implemented). Questions #1-3, #10, #18, #19 are answered by whoever fills these in. | M5 | |
| 34 | Fiscal drivers: for each authority you must report to (PRA POS integration, SRB, KPRA, FBR): which one(s)? We need the authority's integration document, sandbox credentials and the registration/certification steps; real adapters implement `FiscalProvider` in `packages/fiscal-adapters`. Also: must the fiscal number be on the FIRST printed receipt (then the sale needs a short online wait) or may it follow (pending -> reprint)? Offline rules? | M7 | |
| 35 | Inventory: (a) deduct stock when the order is **sent to the kitchen** or when it is **paid** (now: paid)? (b) real yields (mutton after bone/fat, chicken) and portion weights per dish - the recipes need your numbers; (c) allow selling below zero stock (now: yes, shown red)? (d) who counts stock and how often; (e) do you buy mostly on credit from a few suppliers (supplier ledger) or cash from the market? | Phase 2 | |

