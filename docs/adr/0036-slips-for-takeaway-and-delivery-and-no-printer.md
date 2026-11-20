# ADR 0036 — Slips for takeaway and delivery; printing when there is no printer; no more STATION_MISSING

Status: accepted. Follows ADR 0034.

## Decisions
- **The order button is "Print KOT" in every mode** (no more "Send to kitchen"), with a separate **Print token** next to it. Counter mode (Kitchen screen off) only decides whether the Kitchen screen exists.
- **A dish without a station never blocks the send.** The line goes to a default `KITCHEN` station (created on first use, reused after) and prints under that heading; the menu shows a "No station" chip explaining it. A dish whose station was set after it was added is resolved to its current station first. `STATION_MISSING` is no longer thrown.
- **Nothing stays unprinted without a way to print it.** If a station had no printer, the Send response includes `ticket` (the whole Send as one ticket) and the screen opens a modal with the kitchen ticket and a Print button (the browser prints it; only the slip is printed). `POST /orders/:id/print-token` with no thermal receipt printer returns `browser` and the screen opens the same kind of modal for the token. The pre-bill already did this.
- **Takeaway and delivery know who they are for.** Migration 0021 adds `orders.customer_name`, `customer_phone`, `delivery_address` (all optional, capped, editable while the order is open; the address is kept only on a delivery). A chip in the order header ("Add customer name / phone") opens a dialog.
- **The slips:** a takeaway or delivery slip carries a big inverted `TAKEAWAY` / `DELIVERY` banner under the token (a dine-in slip carries its table). The kitchen ticket and the token slip show name and phone; the address appears only on the **bill** of a delivery (the paper the rider carries) and never on the slip the customer keeps. The Urdu bill has the same lines.

## Addendum: no station set up, still prints
A restaurant that never mapped a station to a printer (one printer on the counter) gets its tickets anyway: when NO station-to-printer choice exists anywhere in the branch, a ticket goes to the branch's kitchen printer, or when there is none to its receipt printer (a helper's printer only while the helper is online). Station or no station: the dish prints under its station or under KITCHEN. Once ANY station is mapped, the owner's choices are respected: a station left unmapped stays unprinted and the screen's Print modal takes over.
