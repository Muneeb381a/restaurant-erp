# Demo — M6d: refunds / credit notes

1. As `cashier` sell 2 x Chicken Tikka for cash and settle. A cashier can open it from **Bills** but sees no Refund button.
2. As `manager` (open your own shift first - a cash refund comes out of your drawer): **Bills** -> the bill -> **Refund**. Type 1 in the Tikka quantity, choose **Cash**: the refund total is computed by the server (a bill with a discount or service charge returns a fair share). Add a reason -> **Refund**. The credit note prints and the drawer opens.
3. Open the bill again: the credit-note history is listed. **Refund** -> *Return everything left* returns the rest; nothing is left afterwards and the button disappears. The total returned always equals the bill total, including round-off.
4. Card sale -> refund needs a reference; khata sale -> refund to **Khata** lowers the customer's balance, up to what the bill charged.
5. Shift close and Z-report show the refunds and the net after refunds.

## What the tests prove

- `refund.test.ts` (domain, property tests), `credit-note-guards.test.ts` (DB: settled only, total cap, line cap, parallel returns, immutability, open shift), `credit-notes.test.ts` (HTTP, 11), permission probes, Playwright `07-refund.spec.ts`.
