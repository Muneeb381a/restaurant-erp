# ADR 0011 — Live updates (SSE), Urdu bitmap receipts, settings, table actions

**Status:** accepted

## Live updates: Server-Sent Events instead of WebSockets

- `GET /api/v1/events` is an authenticated, branch-scoped `text/event-stream`. After every **successful write request** (non-GET, status < 400) the API publishes `event: change` with only a **topic** (`orders`, `day`, `khata`, `menu`, `printers`, `misc`) to that branch's clients. No data travels on the stream: clients refetch through the normal API, so permissions, branch scoping and ETags stay in one place and nothing sensitive can leak.
- **Why SSE, not WebSockets:** the need is one-way "something changed" hints; SSE is plain HTTP (works through the existing proxy and LAN setup, no upgrade handshake), needs **no new dependency**, and reconnects trivially. Commands still go over normal HTTP with versioning and idempotency, so a second duplex channel adds nothing. If server-to-device pushes or a KDS with acknowledgements are needed later, WebSockets can be added beside it.
- **Client** (`apps/web/src/lib/live.ts`): one `fetch` stream while signed in (fetch, not `EventSource`, so the bearer token is a header, never a URL), reconnect with backoff 1 s to 15 s, token refresh through the normal API path, refresh bursts debounced to one. On (re)connect everything is invalidated once, so changes missed while offline are caught. **Polling stays as a safety net**: 3 s while disconnected, 30 s while connected.
- **Limits:** the hub is in-process (one API process per restaurant, ARCHITECTURE §3). Print-queue state changes made by a separate worker process are not published; printer health keeps its own 5 s poll. A heartbeat comment every 20 s keeps proxies from closing idle streams.
- **A stale floor can never be tapped:** table buttons stay disabled until the floor was fetched after the page mounted, and screens that change table state drop the floor cache instead of marking it stale (an e2e run found a cashier tapping a just-freed table through stale cache).

## Urdu receipts as a bitmap

- Setting `receipt.language` = `en` (ESC/POS text) or `ur`. Urdu receipts are drawn with `@napi-rs/canvas` (Skia, prebuilt binaries, Arabic-script shaping and RTL) using **Noto Naskh Arabic** and **Noto Sans** (SIL OFL, bundled with licence in `packages/printing/fonts`), thresholded to 1 bit and sent as `GS v 0` bands of at most 255 rows (58 mm = 384 dots, 80 mm = 576). Labels come from one reviewable table (`UR` in `receipt-ur.ts`); item names use the order's Urdu snapshot with English fallback; numbers and dates are kept left-to-right; the branch has `name_ur`. Drawer-kick and DUPLICATE behaviour are unchanged. Shift slips, Z-reports and credit notes are still English text.
- Cost: bigger print payloads (tens of KB per receipt) and a slower first print (font load). Nastaliq style is not used (Naskh shapes reliably at thermal resolution); the owner may prefer another font (OPEN-QUESTIONS #8 lists the printers).

## Settings page and table actions

- Admin → Settings: restaurant name (English/Urdu), address, phone, service charge, round-to-rupee, receipt language, kitchen printing on send (all through existing, audited endpoints). Order page: move table, merge another table's order, cancel order (`order.transfer` / `order.cancel`; the API enforces the same rules as before).
