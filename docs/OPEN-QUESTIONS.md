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
