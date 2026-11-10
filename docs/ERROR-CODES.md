# API error codes

Errors are RFC 7807 `application/problem+json` with a stable `code`. Codes are never renamed or reused; new ones are only added. Every response carries `requestId` (also the `x-request-id` header).

| Code                  | HTTP | Meaning                                                                                                                                     |
| --------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `VALIDATION_FAILED`   | 400  | Request body/query/params invalid (Zod `issues` included), unknown setting key, malformed JSON                                              |
| `BRANCH_REQUIRED`     | 400  | Owner-level user did not send a valid `x-branch-id` and there is not exactly one active branch                                              |
| `UNAUTHENTICATED`     | 401  | Missing/invalid/expired access token, revoked or expired session, invalid refresh token                                                     |
| `INVALID_CREDENTIALS` | 401  | Wrong username / password / PIN (deliberately identical for unknown users, inactive users and a device of another branch)                   |
| `REFRESH_REUSED`      | 401  | A superseded refresh token was replayed; the session has been revoked                                                                       |
| `DEVICE_INVALID`      | 401  | `x-device-token` unknown or revoked                                                                                                         |
| `PERMISSION_DENIED`   | 403  | Authenticated but lacking the permission (`permission` field names it) or attempting privilege escalation (`missing` lists the permissions) |
| `NOT_FOUND`           | 404  | No such route, or the resource does not exist **in your branch**                                                                            |
| `CONFLICT`            | 409  | Unique value already exists, or an action on yourself that is not allowed (e.g. deactivating your own account)                              |
| `REFERENCE_VIOLATION` | 409  | Foreign-key conflict (referenced row missing, or still in use)                                                                              |
| `CONSTRAINT_VIOLATION`| 400/409 | A database CHECK failed (400) or an immutability/append-only guard blocked the operation (409)                                           |
| `ROLE_PROTECTED`      | 409  | The OWNER role's permissions cannot be edited                                                                                               |
| `LAST_OWNER`          | 409  | The last active owner cannot be deactivated or demoted                                                                                      |
| `ACCOUNT_LOCKED`      | 423  | 5 failed logins within 10 minutes; `retryAfterSeconds` says when to retry. An admin can `POST /users/:id/unlock`                            |
| `INTERNAL_ERROR`      | 500  | Unexpected error (details only in server logs, correlate with `requestId`)                                                                  |

Planned (added with their milestones): `TAX_RULE_MISSING`, `TAX_RULE_AMBIGUOUS`, `SHIFT_NOT_OPEN`, `DISCOUNT_LIMIT`, `VERSION_CONFLICT`, `IDEMPOTENCY_CONFLICT`.
