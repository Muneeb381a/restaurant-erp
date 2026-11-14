# ADR 0020 — Deploying on Vercel with Neon

**Status:** accepted for demos and small cloud restaurants; **on-site install stays the recommendation for a busy restaurant** (CLAUDE.md rule 9, LAN-first)

## What was checked (sources)

- Express runs on Vercel as **one Vercel Function** on Fluid compute; `express.static` is ignored (static
  files come from the CDN); the usual function limits apply (https://vercel.com/docs/frameworks/backend/express).
- Duration: 300 s default on every plan, 800 s maximum on Pro (https://vercel.com/docs/functions/limitations).
- **Hobby is non-commercial**: giving a restaurant to someone else needs **Pro** (https://vercel.com/docs/limits/fair-use-policy).
- Neon: use the **pooled** host (`-pooler`, PgBouncer transaction mode) for the app and the **direct**
  host for migrations; the pooler does not support `LISTEN/NOTIFY` or session advisory locks
  (https://neon.com/docs/connect/connection-pooling).
- Neon Free: 100 projects, 1 GB each (20 GB total), computes suspend after 5 idle minutes; paid is
  usage-based (https://neon.com/faqs/free-plan-limits-and-quotas).

## Decisions

- **Build Output API, not framework detection.** `scripts/vercel-build.mjs` writes `.vercel/output`: the
  Vite build as static files, the API as one esbuild-bundled ES module (`apps/api/src/vercel.ts`), the SQL
  migration folders next to it (`ERP_API_ROOT`) and the one native module (argon2). The workspace
  packages are TypeScript source (`@erp/domain` exports `src/index.ts`), which Vercel's own function
  compiler does not handle across a pnpm workspace; bundling removes the question. `pnpm vercel:local` runs the
  exact bundle behind the same routes and headers.
- **Routes:** files first; `/api/*` and `/health` → the function; everything else → `index.html`. Security
  headers (CSP, nosniff, frame deny, HSTS) are set in `config.json`; API responses are `no-store`.
- **No workers.** The print and fiscal workers are long-running and belong to a restaurant's own install.
  Fiscal submission is off until an accountant verifies the tax rules; printing is below.
- **No live stream** (`LIVE_EVENTS=off`). The hub is in process memory, and instances do not share
  memory; the screens fall back to polling every 8 s or more and say "Auto-refresh" instead of
  "Reconnecting". A push channel across instances needs Redis (or similar): OPEN-QUESTIONS #40.
- **Connections:** `pg` pool of `TENANT_POOL_MAX` (3) per restaurant per instance with a 10 s idle
  timeout, over the pooled URL; `TENANT_CACHE_MAX` (25) restaurants warm per instance.
- **`TRUST_PROXY_HOPS=1`** so audit entries and lockouts see the visitor, not Vercel's proxy.
- **Not fixed by this deployment:** the public-menu rate limiter and nothing else is in memory; on
  serverless it is per instance. Add a Vercel Firewall rate-limit rule on `/api/v1/platform/auth/login`,
  `/api/v1/r/*/auth/*` and `/api/v1/r/*/public/*`.

## Consequences

- Receipts and kitchen tickets cannot reach a LAN thermal printer from Vercel. First step: print from the
  browser; second: a small local print agent that fetches jobs (OPEN-QUESTIONS #39).
- A restaurant's internet outage is its outage; with the on-site install it is not.
- Cost: Vercel Pro per seat plus function usage, Neon per restaurant by usage.
