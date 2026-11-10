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
| `DAY_NOT_OPEN`        | 409  | No business day is open (open it before taking orders or opening a shift)                                                                   |
| `DAY_ALREADY_OPEN`    | 409  | A business day is already open for the branch                                                                                               |
| `SHIFT_ALREADY_OPEN`  | 409  | The cashier (or the till/device) already has an open shift                                                                                  |
| `TABLE_OCCUPIED`      | 409  | The table already has an open order (`orderId` / `orderNo` in the body)                                                                     |
| `ORDER_NOT_EDITABLE`  | 409  | The order is BILLED / SETTLED / CANCELLED and can no longer be changed                                                                      |
| `ORDER_HELD`          | 409  | The order is parked; resume it first                                                                                                        |
| `ORDER_HAS_SENT_ITEMS`| 409  | Cancel refused: void the items already sent to the kitchen first                                                                            |
| `ITEM_NOT_EDITABLE`   | 409  | The line was already sent (edit = void + re-add) or is already void                                                                         |
| `ITEM_UNAVAILABLE`    | 409  | The item (or a deal component) is sold out (86) or no longer offered                                                                        |
| `ITEM_NOT_ON_MENU`    | 409  | The item has no price in this order's price list for the business date                                                                      |
| `NOTHING_TO_SEND`     | 409  | Send/reprint found nothing to print (no NEW lines, or every line of the KOT was voided)                                                      |
| `STATION_MISSING`     | 409  | Some items have no kitchen station, so nothing was sent (`items` lists them)                                                                 |
| `NO_PRINTER`          | 409  | The station of this KOT has no active printer                                                                                                |
| `VERSION_CONFLICT`    | 409  | `If-Match` does not match; `currentVersion` says what the order is now                                                                      |
| `PRECONDITION_REQUIRED`| 428 | A structural change needs the order version in `If-Match`                                                                                   |
| `INTERNAL_ERROR`      | 500  | Unexpected error (details only in server logs, correlate with `requestId`)                                                                  |

Domain rule violations (bad deal pick, modifier min/max, missing weight, …) return `VALIDATION_FAILED` (400) with a `reason` such as `DEAL_SLOT_COUNT`, `MODIFIER_GROUP_MIN` or `LINE_WEIGHT_REQUIRED`.

Planned (added with their milestones): `TAX_RULE_MISSING`, `TAX_RULE_AMBIGUOUS`, `SHIFT_NOT_OPEN`, `DISCOUNT_LIMIT`, `IDEMPOTENCY_CONFLICT`.
