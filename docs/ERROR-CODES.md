# API error codes

Errors are RFC 7807 `application/problem+json` with a stable `code`. Codes are never renamed or reused; new ones are only added. Every response carries `requestId` (also the `x-request-id` header).

| Code | HTTP | Meaning |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | Zod validation of the request failed; `issues` lists the problems |
| `NOT_FOUND` | 404 | No such route / resource |
| `INTERNAL_ERROR` | 500 | Unexpected error (details only in server logs) |

Planned (added with their milestones): `TAX_RULE_MISSING`, `TAX_RULE_AMBIGUOUS`, `SHIFT_NOT_OPEN`, `DISCOUNT_LIMIT`, `PERMISSION_DENIED`, `VERSION_CONFLICT`, `IDEMPOTENCY_CONFLICT`.
