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
- **Decided:** one QR for the whole restaurant, not one per table.

## Addendum: guest information (migration 0014)
- Per dish, all optional and display-only: short description (en/ur), labels (`HALAL`, `VEGETARIAN`, `SPICY`,
  `CHEF`, `NEW`), allergens (`MILK`, `GLUTEN`, `NUTS`, `EGG`, `SOY`, `FISH`, `SESAME`, `SHELLFISH`), a photo, and
  `hidden_from_guests`. Label and allergen codes are CHECK-constrained and listed in `@erp/domain`.
- Allergens are shown only as "Contains: …". The system never claims a dish is "free from" something: it cannot
  know about cross-contact in the kitchen, so the page also tells guests to ask staff.
- **Hidden items** are removed from the guest menu, from deal contents that list them, from categories left
  empty, and their photo returns 404. They stay on the till's menu and are sold as usual.
- **Photos** live in `item_images` (bytea, one per item, <= 600 kB) so the till needs no file server. The admin
  browser shrinks every upload to a <= 800 px JPEG; the server checks the first bytes (JPEG/PNG/WebP only, an SVG
  or a mislabelled file is refused), caps the size (413) and serves with `nosniff`. Guest URLs carry a version
  (`?v=`) so phones cache a photo for a day and still see a replacement immediately. Staff preview through an
  authenticated `GET /items/:id/image`.
- The guest page can filter "Vegetarian only" when at least one dish carries that label. CSV import/export does
  not carry these fields (they are edited per dish in the dialog).

## Addendum: the guest page is a menu card
The page is set like a printed menu, not an app list: cream paper in a double gold rule on a dark "table",
the restaurant name in a display serif with the Urdu name beneath, a "Menu" rule with the date, the day's note
as a double-ruled "From the kitchen today" panel, an index of categories (sticky, with search and
"Vegetarian only"), category headings between ornament rules, and each dish as name, dotted leader and price
(sizes such as Half/Full on their own leader lines), an italic description, small-caps labels separated by
dots, "* Contains: …", and the photo as a framed print. Sold-out dishes are struck through. Urdu uses Nastaliq
and the layout mirrors (prices on the left of the leader).
Fonts are bundled files in `public/fonts` (no CDN, works offline on the LAN): Playfair Display (Medium, Bold,
Italic; latin subset) and Noto Nastaliq Urdu (Regular, Bold; arabic subset, ~160 kB each, fetched only when
Urdu text is shown). Both are SIL OFL 1.1; licences sit beside the files. They were copied from the
`@fontsource` packages, so nothing was added to `package.json`.

