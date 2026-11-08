# Restaurant ERP — spec pack

Desi restaurant POS + billing ERP (Pakistan: PRA/SRB/FBR, Urdu/English, LAN-first).

## How to use with Claude Code in VS Code
1. Create a new empty folder, copy this whole pack into it (keep the folder names), `git init`.
2. Open the folder in VS Code → open Claude Code in the terminal (`claude`) or the extension.
3. Paste **Prompt 0** from `docs/KICKOFF-PROMPT.md`. Review its questions/gaps.
4. Then paste **Prompt 1 (M0)**. After M0 is green, continue milestone by milestone (M1 → M9).
5. Answer `docs/OPEN-QUESTIONS.md` (province, CA-confirmed tax rules, printers) before M5/M7.

## Status
M0 (foundation) is implemented — see `docs/demo/M0.md` for how to run and verify it.

## Contents
| File | Purpose |
|---|---|
| `CLAUDE.md` | Rules Claude Code follows automatically in this repo |
| `docs/ARCHITECTURE.md` | Full architecture, ADRs, tax/settlement algorithm, fiscal, printing, API, testing |
| `docs/PHASE-1-TASKS.md` | Milestones M0–M9 with acceptance criteria (+ Phase 2/3 backlog) |
| `docs/KICKOFF-PROMPT.md` | Ready-to-paste prompts |
| `db/001_core.sql` | Core schema (tested): menu, orders, KOT, bills, payments, credit notes, fiscal outbox, khata, audit, immutability triggers |
| `db/002_inventory_finance.sql` | Phase 2: ingredients, recipes, purchases, stock ledger, stocktake, expenses |
| `db/003_seed_dev.sql` | Dev seed (roles, permissions, payment methods, **placeholder** tax rules) |

## Important
- Tax rates in the seed are **placeholders** (Punjab 16%/8% from 1 Jul 2026; Sindh 15%/8%). Get a CA to confirm rates, mixed-tender treatment, service-charge/packing taxability and offline-receipt rules before going live.
- The schema was executed end-to-end (PGlite) with integrity tests: immutability, overpayment guard, one-open-order-per-table, bill math constraints.
