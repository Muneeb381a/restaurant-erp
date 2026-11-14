# ADR 0019 — Many restaurants in the cloud: a control plane and one database per restaurant

**Status:** accepted (printing from the cloud and a live stream on serverless are still open; see OPEN-QUESTIONS #39–#41)

## Context

Until now one API process served one restaurant from one database. The owner wants to run the system
on Vercel with Neon, keep a main admin above all restaurants, and be able to hand a restaurant to
someone else. The schema was written for one restaurant: half the tables carry `branch_id`, but
`users.username`, `customers.phone`, roles and tax rules are unique across the whole database, and the
financial tables are guarded by append-only triggers that were tested as they are.

## Decision

**A control plane and one database per restaurant.**

- A small **control database** (`apps/api/control-migrations`) knows which restaurants exist: `tenants`
  (code, name, status, plan, where the database is), `platform_admins`, `platform_sessions`,
  `platform_audit_log`. It holds no restaurant business data.
- **Each restaurant has its own database** with the unchanged schema (`migrations` + `migrations-phase2`).
  On Neon that is one *project* per restaurant, created through the Neon API when the platform admin
  adds the restaurant (Neon recommends project-per-tenant:
  https://neon.com/docs/guides/multitenancy). A project with no traffic scales to zero.
- **No row-level tenancy.** Rejected: adding `tenant_id` + RLS to 50 tables, rewriting the global unique
  keys and re-proving every append-only trigger, with the failure mode being one restaurant seeing
  another's money. Database-per-restaurant needs none of that and keeps per-restaurant restore.
- **The restaurant API is not re-implemented.** `TenantRegistry` builds, per restaurant, the ordinary
  `createApp(ctx)` with a context whose pool points at that restaurant's database, keeps up to
  `TENANT_CACHE_MAX` warm per instance (least recently used closed), and `/api/v1/r/<code>/…` hands the
  request to it with the prefix cut off. Order, billing and khata code do not know other restaurants exist.
- **Isolation is enforced twice.** Different database, and a different token-signing secret per restaurant
  (`HMAC(JWT_SECRET, tenantId)`): a token from restaurant A fails the signature check at B (tested).
- **Addresses:** `/r/<code>/…` for a restaurant, `/platform/…` for the platform admin, `/` asks for the code.
  One web build; the router `basename` is `/r/<code>`, so every existing route works unchanged. Moving
  between restaurants is a full page load; sessions are stored per restaurant.
- **Cloud mode is switched on by `CONTROL_DATABASE_URL`.** Without it the API is the single-restaurant
  server it always was (on-site installs, all existing tests and e2e).

### The platform admin

A separate login (username + password, argon2id, 5 tries / 10 minutes lockout, rotating refresh token, a
different secret from any restaurant's). Created only from the command line (`pnpm platform:admin
create`): no default account, no sign-up. The admin can create, edit, **switch off** (with a reason the
owner sees), switch on, **archive**, retry a half-finished setup, run updates, **reset the owner's
password** and see technical health (reachable, version, database size). Everything is in an
append-only audit log.

**The admin cannot see a restaurant's sales, customers, menu or money** (decision of the owner, OPEN-
QUESTIONS #42 records the alternative: time-limited, audited support access). There is no impersonation.

### Provisioning

`createTenant`: insert the row (`PROVISIONING`) → create the database → save its (encrypted) connection
strings at once → apply migrations over the **direct** connection → insert branch, price lists, payment
methods, settings, placeholder tax rules (still unverified: tax stays off until an accountant fills
them in) and the owner → `ACTIVE`. Every step can be repeated, so after a failure the restaurant is
`FAILED` with the reason and **Finish setup** continues where it stopped, never making a second
database. A timeout while creating a Neon project is flagged "may have created one: check the console"
(POST is not idempotent).

### Secrets

Connection strings are encrypted with AES-256-GCM (`TENANT_SECRET_KEY`) before they are stored; the API
never returns them. The owner's temporary password is shown once, is never stored in clear and must be
replaced at the first sign-in: `users.must_change_password` (migration 0015) makes the server accept
only `/auth/me`, `/auth/change-password` and `/auth/logout` until it is.

### Nothing is deleted

Archiving blocks the logins and hides the restaurant; the row and the database stay (a trigger refuses
`DELETE FROM tenants`). Deleting a Neon project is a deliberate, manual act in the Neon console.

## Consequences

- Cost grows with the restaurants you actually create, not in advance: Neon's free plan allows 100
  projects of 1 GB; beyond it, usage-based billing (compute hours and storage). An open restaurant
  keeps its compute awake during service because screens poll.
- A new release means migrating every restaurant: `pnpm platform:migrate` (control first, then each
  restaurant, one failing restaurant does not stop the others), or **Install updates** per restaurant.
- Restaurants run on one codebase: a bug fix reaches all of them at the next deploy. There is no
  per-restaurant version.
- Reports across restaurants (platform revenue per restaurant) do not exist and cannot be built from
  the control plane alone, by design.
