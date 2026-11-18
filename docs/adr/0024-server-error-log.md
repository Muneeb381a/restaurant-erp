# 0024 — A small server-error log in the control database

Status: accepted

## Context
In cloud mode one API serves many restaurants. When something fails on our side the owner phones, and
the operator has nothing to look at but Vercel's raw log. We want to see *which restaurant* is having
trouble, early, without adding a paid monitoring service or storing anything about guests or money.

## Decision
- Every HTTP 5xx answer is recorded in `error_events` (control database): time, restaurant (from the
  address), status, the stable error code, method, a **route shape** (ids and numbers replaced by `:id`,
  query string dropped) and the request id that is also in the server log.
- No request body, headers, user, names, amounts or error messages are stored. The route shape is the
  only part of the address kept, so tokens in a query string never reach the table.
- The record is written **before** the response is finished (bounded to 1 s), because a serverless
  function can be frozen once it has answered. Recording can never fail or slow a request beyond that bound.
- Platform admins see "Errors (24 h)" per restaurant and the list on a restaurant's page
  (`GET /platform/errors`). Rows older than 30 days are deleted at random on ~2 % of failures.
- Uptime is checked from outside (a free pinger on `/health`); the API cannot report its own death.

## Consequences
- 4xx are not recorded (they are the client's mistakes: wrong PIN, validation).
- A failure of the control database itself cannot be recorded there; the pinger covers that.
- Requests that never reach the app (platform-level timeouts) are not seen; Vercel's log has them.
- Not financial history, so rows may be deleted; this does not touch the append-only rules.
