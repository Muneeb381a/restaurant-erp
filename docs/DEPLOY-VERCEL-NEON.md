# Deploying on Vercel with Neon (many restaurants)

This puts the system on the internet for several restaurants, each with its **own Neon database**, under
one **platform admin**. Read [ADR 0019](adr/0019-multi-restaurant-cloud.md) and
[ADR 0020](adr/0020-vercel-neon-deployment.md) first for why it is built this way and what it cannot do.

> **Be clear about the trade-off.** A restaurant on this deployment needs the internet to take an order,
> and cannot print to a LAN receipt printer yet (it prints from the browser). That is right for demos,
> owners who only watch the dashboard, and small places with good internet. A busy restaurant should
> still run the on-site install in `ops/` (docker compose + Caddy).

## What you need

| | |
|---|---|
| Vercel **Pro** | Hobby is non-commercial; giving a restaurant to someone else is commercial |
| A Neon account | the free plan is enough to start (100 projects) |
| Node 22 + pnpm | on your computer, for the one-time setup commands |

## 1. Neon: the control database and an API key

1. In the Neon console create a project called `erp-control` (any region near your users).
2. On its dashboard copy two connection strings: **pooled** (host has `-pooler`) → `CONTROL_DATABASE_URL`
   for Vercel; **direct** (no `-pooler`) → used on your computer for migrations.
3. Account settings → **API keys** → create one → `NEON_API_KEY`. It lets the API create a project per
   restaurant. Treat it like a password.
4. `NEON_REGION_ID`: where each restaurant's database lives, e.g. `aws-us-east-2` (list in the Neon docs).
   If the API refuses with a message about the organisation, also set `NEON_ORG_ID` (the `org-…` id from
   the organisation settings).

## 2. Secrets

Generate once and keep them in a password manager. **Losing `TENANT_SECRET_KEY` makes every
restaurant's stored connection string unreadable. Changing `JWT_SECRET` signs everyone out.**

```bash
openssl rand -base64 48   # JWT_SECRET
openssl rand -base64 48   # PLATFORM_JWT_SECRET   (different from JWT_SECRET)
openssl rand -base64 32   # TENANT_SECRET_KEY     (exactly 32 bytes)
```

## 3. Prepare the control database (on your computer, once)

Put the **direct** control URL and the secrets in a local `.env` (never commit it), then:

```bash
CONTROL_DATABASE_URL="<direct url>" TENANT_SECRET_KEY="…" PLATFORM_JWT_SECRET="…" \
PROVISIONER=neon NEON_API_KEY="…" NEON_REGION_ID="aws-us-east-2" JWT_SECRET="…" \
  pnpm platform:migrate                        # creates the control tables
  pnpm platform:admin create root "Your Name"  # prints the password ONCE: save it
```

There is no default admin and no sign-up page. Another admin: `pnpm platform:admin create <name> "<Full Name>"`;
forgotten password: `pnpm platform:admin reset <name>`.

## 4. Vercel

1. `npm i -g vercel`, `vercel login`, then in the repo root `vercel link` (create a new project).
2. Environment variables (Project → Settings → Environment Variables, **Production**):

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `CONTROL_DATABASE_URL` | the **pooled** control URL |
| `JWT_SECRET`, `PLATFORM_JWT_SECRET`, `TENANT_SECRET_KEY` | from step 2 |
| `PROVISIONER` | `neon` |
| `NEON_API_KEY`, `NEON_REGION_ID` (`NEON_ORG_ID` if needed) | from step 1 |
| `LIVE_EVENTS` | `off` (no live stream on serverless; screens refresh on a timer) |
| `TRUST_PROXY_HOPS` | `1` |
| `LOG_LEVEL` | `info` |

3. `vercel deploy --prod`. The project's `vercel.json` runs `node scripts/vercel-build.mjs`, which builds the
   web app and the API function (see ADR 0020).
4. Check `https://<your-project>.vercel.app/health` → `{"status":"ok","mode":"cloud",…}`.

To look at exactly what will be deployed before sending it: `pnpm vercel:build && pnpm vercel:local`
(needs the same variables in the shell; serves the real bundle on http://127.0.0.1:3000).

## 5. Create the first restaurant

1. Open `https://<your-project>.vercel.app/platform`, sign in with the admin from step 3.
2. **New restaurant**: name, code (it becomes `/r/<code>`), owner's name. Wait 10 to 30 seconds.
3. The next screen shows the address, the owner's username and a **temporary password, once**. Copy it or
   send it to the owner on WhatsApp from there.
4. The owner opens the address, signs in (**Use a password instead** on the sign-in screen), and is made to
   choose their own password before anything else.
5. The owner follows **Admin → Setup**: menu, tables, printers, users. Tax stays off until an accountant
   fills in the rates ([OPEN-QUESTIONS](OPEN-QUESTIONS.md) #1–#3, #14).

## Everyday operations

| Task | Where |
|---|---|
| Switch a restaurant off (unpaid, misuse) | Platform → the restaurant → **Switch off**, with a reason the owner sees. Logins and open screens stop within seconds. Nothing is deleted. |
| Owner locked out / forgot | **Reset the owner's password**: a new temporary password, old sessions end |
| A restaurant stuck at "Setup failed" | open it → **Finish setup** (continues, never a second database). If the message says a project *may* have been created, look in the Neon console first |
| After every deploy | `pnpm platform:migrate` (control, then every restaurant; one failure does not stop the rest), or **Install updates** on one restaurant |
| Who did what | Platform → **Activity** (append-only) |
| A restaurant leaves | **Archive** (code stops working, data kept). Deleting its Neon project is manual, in the Neon console, and cannot be undone |
| Errors | Every failed request (HTTP 5xx) is noted in the control database. Platform → the restaurants list shows **Errors (24 h)** for each, and a restaurant's page lists them with the request id to search in the Vercel log. Nothing about the guest, the bill or the request body is kept; rows older than 30 days are purged. Run `pnpm platform:migrate` once after deploying this (adds the table) |
| Is it up? | Point a free uptime pinger (UptimeRobot, Better Stack) at `https://<your-domain>/health` every 5 minutes, alert by SMS/WhatsApp/email. It answers `503` when the control database is unreachable |
| Backups | `pnpm platform:backup` every night (a dump per restaurant + the control database, checked after writing), `pnpm platform:restore` for one restaurant. Neon's point-in-time history is a second net. Full guide: [BACKUP-RESTORE](BACKUP-RESTORE.md) |

## Limits you should know

- **No live stream:** screens poll (every 8 s at the fastest), so an order sent from a phone shows on the
  kitchen screen within a few seconds, not instantly. Many devices mean many requests: watch Vercel usage.
- **Printing:** receipts and kitchen tickets do not reach LAN printers from here. Browser printing is the
  first step, a local print agent the second (OPEN-QUESTIONS #39).
- **Fiscal / tax-authority submission is not run** in the cloud deployment.
- **Rate limits:** the in-process limiter on the public menu is per instance. Add Vercel Firewall rules for
  `/api/v1/platform/auth/login`, `/api/v1/r/*/auth/*`, `/api/v1/r/*/public/*`.
- **The platform admin cannot see a restaurant's data.** If you want audited support access, say so
  (OPEN-QUESTIONS #42).

## Troubleshooting

| Symptom | Cause |
|---|---|
| `/health` is 500 / function crashes at start | a required variable is missing: the error in Vercel → Logs names it |
| "Setup failed: create database: Neon refused (HTTP 401)" | wrong `NEON_API_KEY`, or a personal key needs `NEON_ORG_ID` |
| "Setup failed: migrate: …" | the Neon database is reachable but a migration failed: the message says which; fix, then **Finish setup** |
| Restaurant says "Cannot reach the server" | the function or the restaurant's database is waking up; wait a few seconds |
| Everyone signed out after a deploy | `JWT_SECRET` changed |
| A restaurant's data "disappeared" | wrong code in the address: each restaurant is its own database; check `/r/<code>` |
