# ADR 0005 — Web app foundation (M2b/M3b step 1)

**Status:** accepted

## Decisions

- **Stack:** React 18 + Vite, `react-router-dom`, **TanStack Query** for all server state, **Zustand** only for the auth tokens, **Tailwind 3** for styling, **i18next** for English/Urdu. No component library yet (shadcn/Radix would add ~10 packages; the app has a handful of buttons, cards and sheets, defined once in `index.css`). Revisit when forms grow.
- **The UI never computes authoritative numbers** (rule 5): it sends item/variant/qty/weight/modifier ids/deal picks and renders the server's totals (`formatRs` is display-only). The price shown on the item sheet is the list price for orientation.
- **Auth:** PIN login (`username` + PIN pad); tokens live in `localStorage` (the counter PC keeps its session until logout); `api()` attaches the bearer token and, on a 401, rotates the refresh token **once for all concurrent requests** (single flight — a rotating refresh token must never be replayed) and retries; a failed refresh logs out. A staff picker needs a device-token endpoint (planned).
- **Live data:** the floor, order and menu are polled (3–4 s; menu 30 s with ETag/304) until WebSocket events (`table.status`, `order.updated`) are added; mutations apply the server's returned order immediately, so the acting device never waits for the poll. A `VERSION_CONFLICT`/`ORDER_NOT_EDITABLE` reloads the order and tells the user. A `TABLE_OCCUPIED` response jumps to the existing order instead of failing.
- **Touch first:** every control has a 48 px minimum target (`min-h-touch`), the PIN pad and item grid are tablet-sized, the order screen is two panes (menu | cart) that stack on narrow screens.
- **Urdu/RTL:** `<html lang dir>` follows the language; layout uses Tailwind logical utilities (`ms-`, `me-`, `border-e`, `text-start`) so it mirrors without per-component work; item names use `name_ur` when present; the PIN pad stays LTR; a test checks that every English string has an Urdu one.
- **Tests:** Vitest + Testing Library for the API client (refresh single-flight, error mapping), login, item sheet rules, i18n; **Playwright** (`pnpm test:e2e`) drives the real stack against its own database (`erp_e2e`, ports 18081/15174): cashier opens day + shift and takes an order, a second tablet sees the table occupied, Urdu RTL, sign-out guard.

## Admin area

A permission-gated section (`/admin`): menu (inline price edit, new item, CSV import with a dry-run step, export), printers (status, test page, station mapping, failed jobs), tables, users. It reads one purpose-built payload (`GET /menu/admin`: every item with its price per channel) and uses the same endpoints as the API tests, so the UI adds no rules of its own: prices are parsed with the domain's `parseRupees` (invalid input is flagged and never sent), clearing a price is not offered (history is kept), and the import shows the server's validation by line number. Checkboxes that change server state update optimistically and roll back on error.

## Not yet

PWA install/offline shell, WebSocket push, deal editor, role/permission editor, settings screen, table transfer/merge/cancel UI, receipts and billing (M5/M6), idle auto-lock.
