# 0025 — The app opens without internet; writes still need the server

Status: accepted

## Context
In cloud mode a short internet cut used to leave a blank browser error instead of the till. The
architecture (decision 13) keeps the server as the only source of truth and does not queue writes.
Tax, bill numbers and fiscal numbers are all assigned by the server at settlement, and what a fiscal
authority allows offline is not yet known (OPEN-QUESTIONS #6, #34, #45).

## Decision
- A small hand-written service worker (`public/sw.js`, no new package) keeps the **app shell** and its
  hashed files so the app opens with no internet. Pages are network-first (a new deploy arrives at
  once; 4 s timeout, then the cached shell). `/assets`, `/fonts` and icons are cache-first.
- The service worker **never touches `/api` or `/health`**: nothing about a guest, a bill or a session is
  cached, so a shared device leaks nothing.
- Each restaurant is installable as an app (`/api/v1/public/tenants/:slug/manifest`, a manifest that
  opens on that restaurant's own sign-in); single-restaurant installs use `/manifest.webmanifest`.
- Writes are **not queued**. Mutations use `networkMode: 'always'`, so a payment can never sit paused
  and fire later; a request that cannot reach the server fails at once as `OFFLINE` with a clear message,
  and a banner says why saving is not possible.
- The worker is registered only in production builds (a dev service worker serves stale files).
  `/sw.js` and the manifest are served `no-cache`.

## Consequences
- With no internet staff can keep reading what is on screen but cannot add items, send, bill or pay.
- The restaurant's own LAN server (single-restaurant install) is unaffected and is still the answer for
  a till that must never stop.
- Queued order-taking would reverse decision 13 and needs the owner's and accountant's answer first
  (OPEN-QUESTIONS #45).
