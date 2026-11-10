# Demo — M6c: khata (customer credit)

1. Sign in as `manager` → **Khata** → **+ New account**: *Haji Rashid*, phone, limit Rs 1,000. (Cashiers can open the list and take payments but have no "New account" button.)
2. As `cashier` (shift open): order, send, **Bill**, then **+ Customer Khata (credit)** → search *Rashid* → pick. The chip shows what he owes and the available credit. **Settle bill**. Do it twice: Rs 800 is on his account.
3. A third Rs 400 sale: the screen warns "Over the credit limit. Available: Rs 200" and the server refuses it (`KHATA_LIMIT_EXCEEDED`); the bill stays payable. Split instead: Rs 200 on khata + the rest in cash.
4. **Khata** → *Haji Rashid*: balance Rs 1,000, ledger of three credit sales. **Receive payment** → Cash → Rs 1,500 is refused (more than owed); Rs 300 is accepted, the balance is Rs 700 and the Rs 300 is in the drawer (expected cash at shift close includes it).
5. Managers can **Adjust balance** (reason required), **Change limit** and **Switch off** the account.

```bash
curl -X POST $API/khata/accounts/$ACCT/payments -H "Authorization: Bearer $T" \
  -H 'Idempotency-Key: khata-pay-0001' -H 'content-type: application/json' \
  -d '{"methodId":"<cash id>","amountPaisa":30000}'
```

## What the tests prove

- `khata-guards.test.ts` (DB): limit exact/over, zero limit, inactive, **two parallel charges → one wins**, overpayment, closed shift, entry shape, append-only, one charge per payment, idempotency key.
- `khata.test.ts` (HTTP, 10): accounts and search, credit sale (ledger, receipt, drawer untouched), limit error with `availablePaisa`, rules (account required, one tender, no tip, inactive, permission revoked), parallel credit sales, collections into the drawer, adjustments, day report.
- Playwright `06-khata.spec.ts`: the three flows above in the browser.
