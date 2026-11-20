# ADR 0037 — Where an order came from, and a clearer bill

Status: accepted

## Context
Takeaway and online orders (Foodpanda, WhatsApp, phone) looked the same as counter orders on paper, so a rider's
"order A1B2" could not be matched to the slip. The bill was also hard to read at a glance.

## Decision
- `orders.external_ref` (migration 0022, max 40 chars) holds the platform's own order number; `orders.channel`
  (already present) says where it came from. Both are editable on an open order via `PATCH /orders/:id`.
- Every slip (KOT, combined KOT, token, bill; text and Urdu bitmap) prints a `[ FOODPANDA  #A1B2 ]` line under the
  type banner for any channel other than POS.
- Bill layout: token on top, ruled item list with a quantity column and "@ unit price each" for quantities above one,
  item count, an inverted TOTAL band, "You saved" when discounted, and a menu QR (`menu.public_url`, only when the
  public menu is enabled) on paid bills. Bills not yet paid carry no QR.
- No money logic changed: totals still come from the server.

## Offline
The service worker now precaches the whole build (`asset-manifest.json`) on install so a refresh with no internet
opens the app. Creating new orders, billing and payment still need the server (ADR 0026).
