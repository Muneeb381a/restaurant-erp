# ADR 0021 — Many restaurants on one Postgres server (database + login each)

Status: accepted. Refines [0019](0019-multi-restaurant-cloud.md) and [0020](0020-vercel-neon-deployment.md).

## Context
0019 gave every restaurant its own Neon project. Each project has its own compute, so cost and the plan's
project limit grow with every restaurant, which is too expensive for small restaurants. The first real
attempt also showed that the Neon free plan refuses a custom suspend time (HTTP 412).

## Decision
The default provisioner (`PROVISIONER=local`) creates, on ONE Postgres server (a single Neon project in
production), for each restaurant: its own login role, its own database owned by that role, and
`REVOKE ALL ... FROM PUBLIC` on that database. The app connects through the pooled host
(`-pooler`), migrations through the direct host. The per-project Neon provisioner stays available
(`PROVISIONER=neon`) for a restaurant that needs its own compute and backups.

## Consequences
- Isolation stays at database level: one restaurant's login cannot open another's database.
- Compute is shared: a very busy restaurant can slow the others; backups/point-in-time restore are for the
  whole project, not one restaurant (take a `pg_dump` per restaurant for a single restore).
- The control database lives in the same project in the simplest setup; tenant logins have no rights on
  its tables. A separate project for the control database is a later hardening step.
- Per-restaurant Neon `projects` are no longer created by default, so no API key is needed at runtime.
