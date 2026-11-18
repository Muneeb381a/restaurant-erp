# 0027 — Printing with no printer setup in the cloud

Status: accepted. Narrows OPEN-QUESTIONS #39 (the local print agent is still the long-term answer).

## Context
A shop owner must not have to configure printers. In the cloud the server cannot reach a LAN or USB
printer, and a website cannot list the computer's printers or print without a dialog (browser rule).

## Decision
- A printer is never a required setup step (`optional`), and in the cloud the Printers screen, the
  "printer offline" bar and the "no printer for station" warning are not shown.
- When a payment completes and no receipt printer is configured (`receipts === 0`), the receipt opens for
  printing by itself; the "Print receipt" and "Reprint" buttons stay.
- Auto print without a dialog is done by the browser, not the app: Admin, Settings has a one-time helper
  that downloads a tiny `.bat` file opening the restaurant in Edge/Chrome with `--kiosk-printing`, which
  sends each print to the computer's default printer. The person who sets up the counter computer
  installs the driver, makes it the default printer and uses that file; nothing else is configured.
- We do not claim detection: websites cannot see printers. WebUSB/Web Serial were rejected for now
  (Windows' own USB printer driver usually blocks WebUSB; Serial needs a COM port).

## Consequences
- Kitchen tickets in the cloud are still read from the kitchen screen (no thermal KOT); that needs the
  local print agent.
- A computer opened the normal way still shows the print dialog, once per receipt.
