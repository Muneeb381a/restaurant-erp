# ADR 0034 — The token, and one printer at the counter

Status: accepted.

## The problem
A small restaurant has ONE printer, on the counter. Before this change: every station of a Send printed its own small slip (a mixed order = three slips), the kitchen slip and the bill only said "Order #17" in small type, the bill was printed only AFTER payment (so the customer paid without a printed bill in hand), and finding an order again meant scanning the floor.

## Decisions
- **The token is the day's order number** (`orders.order_no`, from `next_doc_no(... 'ORDER')`): assigned when the order is created, 1, 2, 3 ... per business day, never reused that day. No second counter was invented: one number to call, print and look up. It is printed huge (`TOKEN 17`, triple size, centred) at the top of every kitchen ticket (including cancel tickets and reprints) and on every bill and receipt (text and Urdu bitmap), and shown in big type on the order screen, the pay screen, the kitchen board and the takeaway list.
- **"One printer at the counter" is two independent settings**, with a one-tap preset in Admin, Settings:
  - `kot.single_ticket` (default off): a Send prints ONE combined ticket (token on top, each station as an inverted heading with its items, an item count, one cut) to the distinct printers that serve those stations. The kitchen display still gets one KOT per station (`kots` rows are unchanged). A reprint brings back the whole ticket of that Send (the KOTs created in the same moment for the same order). Job idempotency keys: `kot:<first kot>:combined:p<n>:<printer>`.
  - `receipt.print_after_payment` (default on): when off, paying prints nothing by itself (`printPolicy: MANUAL` in the settle result, so the browser does not auto-print either); the first receipt print on request is still the free original (print count stays 0), later ones remain duplicates with a reason.
- **The bill is printed before the money is taken**: `POST /bills/:id/print-bill` (permission `bill.create`, `Idempotency-Key` required) for a bill waiting for payment. It is a *provisional* bill: token, items, amount due, "*** BILL - NOT PAID ***", "Please pay at the counter", no payment lines, never opens the drawer, changes no print count and needs no reason. Each press is audited (`BILL_PRINT_PREBILL`); the same key never prints twice. With no thermal printer (a cloud shop) the data comes back and the browser prints it, like the receipt. The amount is the pre-bill amount: if tax is switched on and the payment class changes the tax at settlement, the paid receipt can differ (the tax feature stays off until an accountant verifies the rules).
- **Finding an order by token**: `GET /orders/by-token/:n` looks in the open business day (the last one when closed) and returns the order with its bill; the Tables screen has a "Find token" box that opens the order, or the pay screen when there is a bill (paid or not).
- Existing restaurants change nothing: both settings default to the old behaviour. The old "Order #n" small text is replaced by the token line.

## Not done / limits
- Tokens are per business day: the same number comes back tomorrow (the lookup is for today's customers).
- Single-ticket mode sends the whole ticket to EVERY distinct printer serving any of its stations; with two physical kitchen printers keep it off.

## Addendum: the table sequence (bill first, pay later)
Most restaurants give the bill first and take the money afterwards. The sequence, one tap per step, on the Tables screen:

1. **Table free** → tap: start the order (unchanged).
2. **Order** → add dishes → **Send to kitchen**: the kitchen ticket prints with the token (the toast says so: "Sent to the kitchen: BBQ, KARAHI · Token 17 · ticket printed"). If nothing could print and the Kitchen screen is hidden, that is reported (the printed ticket is then the only kitchen).
3. **Customer asks for the bill** → on the table's tile (or on the order screen) tap **Print bill**: one atomic request `POST /orders/:id/print-bill` bills the order if it has no bill (the order is frozen as BILLED, the table shows "Bill ready" with the amount) and prints it NOT PAID with the token. Pressing again reprints the same bill (never a second bill); the same `Idempotency-Key` never prints twice. Items not yet sent to the kitchen refuse it (`UNSENT_ITEMS`) with a message naming the table. With no thermal printer (a cloud shop) it opens the pay screen, which prints the bill from the browser.
4. **Customer pays** → the tile's **Take payment** (a BILLED table now opens straight on the pay screen) → pay → the order is SETTLED, **the table is free at once** and the paid screen says "Table T3 is free again". Whether a receipt also prints is the `receipt.print_after_payment` setting.
5. A customer who adds something after the bill is printed: open the table's pay screen and void the bill with a reason (existing, audited); the order opens again.

**Hiding the Kitchen screen**: `kitchen.screen_enabled` (default on). Off removes the Kitchen link, stops the board polling, and sends `/kitchen` back to the tables; Send to kitchen only prints. The "One printer at the counter" preset now switches on all three: single combined ticket, bill before payment (no auto receipt), Kitchen screen hidden.
