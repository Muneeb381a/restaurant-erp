# CLAUDE.md — Restaurant ERP (desi restaurant, Pakistan)

You are building a **production POS/billing ERP** for a desi restaurant. Read `docs/ARCHITECTURE.md` fully before writing code, and `docs/PHASE-1-TASKS.md` for the build order. The reference SQL is in `db/` (already tested) — migrations must preserve its constraints and triggers.

## Stack (do not change without asking)
- Node.js 22 + TypeScript (strict), pnpm workspaces monorepo, Express + Zod, Kysely + node-pg-migrate (SQL migrations), PostgreSQL 16.
- React + Vite + TanStack Query + Zustand + Tailwind/shadcn + react-i18next (en/ur, RTL), PWA.
- Vitest (+ fast-check), supertest, Playwright, Testcontainers (real Postgres for DB tests).
- Layout: `apps/api`, `apps/web`, `packages/domain`, `packages/printing`, `packages/fiscal-adapters`, `ops/`.

## Non‑negotiable rules
1. **Money is integer paisa.** Never use floats for money. Weight pricing uses integer math with explicit rounding (half‑up).
2. **No deletes, no edits of financial history.** payments, stock_movements, khata_entries, audit_log are append-only (DB triggers). Settled bills are immutable → corrections via credit notes. Do not weaken or bypass these triggers/constraints.
3. **Tax is computed at settlement** from effective-dated `tax_rules` + `payment_class` (cash vs digital). Never hard-code rates in code. Missing/duplicate rule = hard error. Seed rates are placeholders (`verified_by` NULL) — keep tax features disabled in production until a CA fills it.
4. **Idempotency everywhere money moves** (payments, fiscal submissions, print jobs). Use `Idempotency-Key` + DB unique keys.
5. **Business logic lives in `packages/domain` (pure, tested)**; API modules orchestrate transactions; UI never recomputes authoritative totals.
6. **One DB transaction per command** (settle, send-to-kitchen, transfer, merge, split). Lock with `FOR UPDATE`; optimistic `version` on orders.
7. **Every sensitive action** (void after KOT, discount, refund, reprint, shift reopen, price override, drawer open) requires permission + reason and writes `audit_log`.
8. **Module boundaries**: routes → service → repo. No cross-module table access except through service interfaces/events (reports are the exception).
9. **LAN-first**: nothing in the core order→bill→print path may depend on internet. Internet-only features go through the outbox/worker with retries.
10. Urdu support is a feature, not an afterthought: names stored as `name` + `name_ur`; receipts rendered as bitmap for Urdu.

## Working agreement
- Work **one milestone at a time** (see tasks file). Before coding a milestone: list the files you will touch and the tests you will write. After coding: run lint, typecheck, tests; fix everything; then summarise what changed and what remains.
- Write tests first for `packages/domain` (tax, rounding, split, weight pricing, deals) — include property-based tests (Σ parts = whole).
- Prefer small, reviewable commits (`feat(billing): …`, `fix(tax): …`). Never commit secrets. Keep `.env.example` current.
- If a requirement is ambiguous or legal/tax-related, **stop and ask** (add to `docs/OPEN-QUESTIONS.md`) instead of guessing.
- Do not add dependencies casually; justify each new package in the PR/commit message.
- Keep UI touch-first (min 48px targets), fast, and usable in Urdu RTL.

## Commands (create these scripts in M0)
```
pnpm dev            # api + web + postgres (docker compose up db) with hot reload
pnpm db:migrate     # run migrations
pnpm db:reset       # drop/create + migrate + dev seed (dev only)
pnpm test           # unit + integration
pnpm test:e2e       # playwright
pnpm lint && pnpm typecheck
docker compose -f ops/docker-compose.yml up -d    # production-like stack
```

## Definition of done (every task)
- Typecheck + lint + tests green; new logic has tests (domain 100% branch coverage on tax/money/split).
- Migrations are forward-only and tested on a fresh DB and on a DB with data.
- Permissions checked in API (not only hidden in UI); audit entries written where required.
- No TODOs left in money/tax/fiscal paths; error codes are stable and documented.
- Docs updated (`docs/`), including any new decision as a short ADR.
