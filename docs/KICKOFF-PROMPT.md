# Kickoff prompts for Claude Code (paste in order)

## Prompt 0 — Orientation (paste first, in the repo root)
```
Read CLAUDE.md, docs/ARCHITECTURE.md, docs/PHASE-1-TASKS.md and the SQL in db/.
Do NOT write code yet. Reply with:
1) a 10-line summary of the system as you understand it,
2) any contradictions or gaps you found in the docs/schema (be specific),
3) the exact file/folder plan for Milestone M0,
4) questions you need answered before M5 (tax) and M7 (fiscal).
Add the questions to docs/OPEN-QUESTIONS.md.
```

## Prompt 1 — Milestone M0
```
Implement Milestone M0 from docs/PHASE-1-TASKS.md exactly as specified.
Use pnpm workspaces. Port db/001_core.sql and db/002_inventory_finance.sql into node-pg-migrate SQL migrations
(keep every constraint/trigger; 002 can be a separate migration we apply later). Add DB-level tests (Testcontainers)
that prove: payments are append-only, settled bills are immutable, overpayment is blocked, one open order per table,
one open business day per branch. Make `pnpm dev`, `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm db:reset` work.
When finished: run everything, fix failures, and give me a short report (what was built, how to run, what's next).
```

## Prompt N — Any later milestone (template)
```
Implement Milestone M<N> from docs/PHASE-1-TASKS.md.
First list the files you'll create/change and the tests you'll write, then implement.
Follow CLAUDE.md rules (integer paisa, append-only ledgers, tax at settlement, idempotency, audit).
Write domain tests first. Run lint, typecheck and all tests; fix failures.
If anything is legally/tax ambiguous, stop and add it to docs/OPEN-QUESTIONS.md instead of guessing.
End with: summary, how to demo it (docs/demo/M<N>.md), and risks you see.
```

## Prompt for the tax engine (M5) — extra-careful version
```
Milestone M5. Start ONLY with packages/domain: money, line pricing (incl. weight and deal allocation),
discounts, service charge, tax class resolution (policy setting), tax computation, round-to-rupee, split bills,
credit-note reversal at original rate. Write table-driven + property-based tests first (sum of parts = whole,
total = taxable + tax + round_off, never negative). Show me the test list for review before implementing the
settle transaction in apps/api.
```
