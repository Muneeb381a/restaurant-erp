# ADR 0001 — Money representation

**Status:** accepted (M0)

**Decision:** Money is an integer number of paisa, typed as a branded `number` (`Paisa` in `packages/domain`), validated with `Number.isSafeInteger`.

- Postgres `BIGINT` columns are parsed by node-postgres via a global type parser (`apps/api/src/shared/db.ts`) → `paisaFromDb`, which throws if a value is not a safe integer. Nothing is ever silently rounded.
- `NUMERIC` columns (quantities) stay as strings and are handled with integer math (×1000) inside `packages/domain`; they are never converted with float arithmetic.
- JSON APIs send paisa as integers. Safe range ≈ Rs 90 trillion, far beyond any bill.

**Why not `bigint`:** it does not serialise to JSON, complicates React/Zod code, and brings no benefit within the safe range. The parser guard makes overflow a loud error instead of silent corruption.

**Consequence:** `parseFloat` is banned by ESLint; multiplication/division (tax, weight pricing) must go through explicit half-up helpers in `packages/domain` (added in M3/M5, with 100% branch coverage).
