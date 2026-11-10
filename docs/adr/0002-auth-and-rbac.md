# ADR 0002 — Authentication, sessions and RBAC (M1)

**Status:** accepted (M1)

## Decisions

- **Credentials:** PIN (4–8 digits, cashiers/waiters) and password (≥ 8 chars, managers/owner), both hashed with **argon2id** (`@node-rs/argon2`, OWASP parameters). Login is `username + secret`: PINs are hashed, hence not searchable and not unique, so the UI shows a user picker first.
- **Tokens:** access token = HS256 JWT, 15 min, claims `sub` + `sid` only. Every request also checks the session row (not revoked/expired, user active), so logout, deactivation and role changes take effect **immediately**, not after 15 minutes. Refresh token = `<sessionId>.<random secret>`, rotated on every use; only `sha256(secret)` is stored (secrets are high-entropy, unlike PINs). Replaying a superseded refresh secret revokes the session (`REFRESH_REUSED`). A client that loses a refresh response will therefore have to log in again — accepted in favour of theft detection.
- **Lockout:** 5 failures within 10 minutes lock the account for 10 minutes (shared counter for PIN and password, serialised by a row lock so parallel guessing cannot bypass it). Unknown users run a dummy hash verification so timing does not reveal valid usernames. Unlocking: wait, reset credentials, or `POST /users/:id/unlock` (audited).
- **Permissions:** `role_permissions`, cached per role for 30 s and invalidated on edit. Checked in the API (`requirePermission`); the UI only hides things. Reads of floor/config data need authentication only (POS staff need them); writes need `settings.manage`, tax fields need `tax.manage`.
- **No privilege escalation:** you can only assign/modify roles (and grant permissions) that you fully hold yourself; OWNER's permission set is fixed; the last active owner cannot be removed.
- **Branch scoping:** branch users are pinned to their branch; owner-level users (branch NULL) send `x-branch-id` (or use the only branch). Rows of other branches are 404, not 403.
- **Devices:** registered by `device.manage`; the raw token is shown once and only its hash is stored; a login may present `x-device-token` to bind the session to a device; revoking a device ends its sessions.
- **Audit:** every administrative write and every login/logout/failure appends to `audit_log` **in the same transaction** as the change (before/after JSON). Values under credential-looking keys are redacted defensively.
- **Reference data in migrations:** permissions, roles and their mapping are inserted by migration `0002_auth_rbac.sql` (production needs them), not by the dev seed. A migration that adds a permission must also grant it (at least to OWNER); a test enforces that OWNER holds every permission.

## Consequences

- Sessions are checked in the DB on each request (one indexed join) — fine on a LAN, and the price of instant revocation.
- No self-service "forgot PIN": a manager resets it.
- HS256 with a single `JWT_SECRET` (env). Rotating it logs everybody out.
