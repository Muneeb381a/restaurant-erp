# ADR 0012 — The tax engine (M5): data, not code

**Status:** accepted. The software ships **no rates**; the owner or their accountant enters them (Admin -> Tax).

## Decisions

- **Rates are rows** in `tax_rules` (authority, category, payment class `CASH_OTHER | DIGITAL | ANY`, rate in basis points, effective-from/to, source note, `verified_by`). Nothing in code knows a rate. The dev seed contains *placeholder* rows (unverified) that do nothing until someone confirms them.
- **Off by default.** `tax.enabled` (needs `tax.manage`) switches the engine on. The API refuses (`TAX_NOT_READY`, with a list of `problems`) unless: the branch has a tax authority; **every category used by an active item has exactly one rule for BOTH payment classes today**; and every one of those rules has a named `verified_by`. Switching it off is always allowed.
- **Hard errors, never guesses.** At pricing time a missing rule is `TAX_RULE_MISSING` and an ambiguous one `TAX_RULE_AMBIGUOUS` (including a class rule next to an `ANY` rule); the bill is not created/settled. The database prevents overlapping periods (exclusion constraint), makes a rule's rate/scope/start immutable and undeletable (a change = end the old rule + add a new one from a date), and the API also refuses `ANY`-vs-class overlaps.
- **Maths** (`packages/domain/src/billing/tax.ts`, 100 % coverage + property tests): per line, base = net - its share of the bill discount (+ its share of the service charge when `tax.service_charge_taxable`, default true); tax = base x the line's own rate, half-up; **the bill tax is the sum of the line taxes**. Lines carry `tax_paisa / tax_rate_bps / tax_rule_id`; a header rate is stored only when all lines share one rule. A DB trigger checks header tax = sum of line taxes at settlement.
- **The rate depends on how the bill is paid**, which is only known at settlement. Pre-bill and discounts price with the highest-rate class (`CASH_OTHER`); `GET /bills/:id/quotes` returns the total for each class and the payment screen shows the one the chosen tenders imply (all digital -> DIGITAL, anything else incl. khata -> CASH_OTHER). **At settle the server re-prices with the real class and the tenders must equal that total exactly**; a bill paid the "wrong" amount is refused and stays payable.
- **Credit notes reverse tax at the original rate**: a line's paid value includes its tax; returning part of a line returns the same fraction of its tax (telescoping half-up, so steps = whole); `credit_notes.tax_paisa` and `credit_note_lines.tax_paisa` are filled; the slip says "incl. tax reversed".
- **Receipts and reports:** the receipt shows "Sales tax 16%" and NTN/STRN when the bill carries tax; the Z-report has a Tax section (by rate and class, less reversals, net payable).
- **Audit:** category/rule creation and rule updates are audited.

## Not done / limits

- Tax-inclusive menu prices and the PROPORTIONAL mixed-tender policy (OPEN-QUESTIONS #33).
- Input-tax adjustment is stored (`input_tax_adjustable`) but not used.
- Fiscal submission to the authority (M7) is separate and builds on the stored line taxes.
