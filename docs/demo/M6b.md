# Demo — M6b: drawer, shift close, day close, Z-report

Sign in as `cashier` / PIN `1234` with an open shift (see M6.md).

1. **Cash drawer** button (top bar) → *Paid out / cash in / drop*: choose Paid out, Rs 50, reason "Ice". Trying Rs 9,999,999 is refused ("not that much cash in the drawer").
2. **No sale (open drawer)** with a reason → the drawer pulses; it is recorded and audited.
3. **Close shift**: count the cash and type the total. The expected amount is hidden until you commit. If it does not match you must write a note; then the result shows *Short / Over / Matches*, and the shift slip prints.
4. Sign in as `manager` → **Close day**. While orders are open the dialog lists them (`#1, #2…`); nothing is abandoned silently. When everything is settled/cancelled and all shifts are closed, the day closes and the **Z-report** prints (sales, payments by method, order types, shifts and variance, voids/cancels).
5. Reprint a closed shift or day with a reason (`POST /reports/reprint`) → "REPRINT #1".

```bash
curl -X POST $API/cash-movements -H "Authorization: Bearer $T" -H 'Idempotency-Key: drop-2026-11-10-1' \
  -H 'content-type: application/json' -d '{"kind":"DROP","amountPaisa":100000,"reason":"To safe"}'
curl -X POST $API/shifts/$SHIFT/close -H "Authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"countedCashPaisa":514000,"notes":"Rs 10 note missing"}'
curl -X POST $API/business-days/close -H "Authorization: Bearer $MANAGER_T"
```

## What the tests prove

- `shifts.test.ts` (12) and `shift-guards.test.ts` (DB triggers): movements and expected cash, over-withdrawal refused, blind count, variance note, audit, slip/Z printed, closed shift takes no money, reopen rules, day-close blockers, closed day immutable, reprint numbering.
- Playwright `05-shift-and-day.spec.ts`: paid-out and no-sale (drawer pulse reaches the printer), blind close with variance, day close blocked by open orders, cashiers have no Close-day button.
- Permission matrix probes for all new endpoints × 7 roles.
