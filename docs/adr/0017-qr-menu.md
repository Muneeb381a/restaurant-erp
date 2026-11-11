# ADR 0017 — Customer QR menu

**Status:** accepted

## Context
Guests should be able to scan a QR code on the table and read today's menu on their own phone, without
installing anything and without staff devices being exposed. Nothing in the order -> bill -> print path may
depend on the internet (CLAUDE.md rule 9), so the menu must work over the restaurant's own Wi-Fi.

## Decision
- **One public, read-only endpoint:** `GET /api/v1/public/menu?branch=<id>`. It is the only unauthenticated
  business endpoint. It is **off** until the owner turns on `menu.public_enabled` (then `404 MENU_NOT_PUBLIC`).
- **Narrow payload:** restaurant name/address/phone, today's date, an optional note, the service-charge
  percentage (so the footer can say it), categories, and priced dishes from the DINE_IN list for today's
  business date with a sold-out flag, and deal contents as plain names. It never returns codes, stations,
  costs, search terms, modifiers, variant ids or anything about orders or staff. A test asserts this.
- **Same source as the POS:** it reuses `getMenu` (cached per branch/date, invalidated on menu writes), so the
  guest sees exactly the prices the till charges; marking a dish unavailable (86) shows "Sold out" within the
  page's 60 s refresh.
- **Cheap and safe to expose:** `Cache-Control: public, max-age=30` + ETag/304, and a per-client fixed-window
  limit (240/min, keyed by `X-Forwarded-For` behind the reverse proxy). Errors: `MENU_NOT_PUBLIC`,
  `RATE_LIMITED`, `BRANCH_REQUIRED` when several branches exist and no `branch` is given.
- **Settings** (all `settings.manage`): `menu.public_enabled`, `menu.public_note` (<= 300 chars),
  `menu.public_url` (http/https address the QR points to). The link is `<url>/m?b=<branchId>`.
- **QR drawn in the browser** with the small dependency-free `qrcode-generator` (MIT, ~25 kB; needed because
  the repo had only the printer-side QR). Error correction M; always dark-on-white with a quiet zone so it scans
  in dark mode too. The admin page prints a poster (print stylesheet) or downloads a PNG.
- **Guest page** `/m` (outside the staff shell): mobile-first, English/Urdu (RTL), category chips, search,
  sold-out and deal labels, today's note, price footnote. No ordering.

## Consequences
- The address must be reachable from guests' phones: the till's LAN address (e.g. `http://192.168.1.10`),
  not `localhost`. The admin page warns about localhost. Over plain HTTP on a LAN there is nothing sensitive
  to protect: the page only shows the public menu.
- Turning the switch off closes it immediately for new loads (cached copies live <= 30 s).
- Future: a per-table QR (`?t=<table>`) for table-aware ordering, photos, allergens (OPEN-QUESTIONS #37).
