# 0029 — The print helper

Status: accepted. Answers OPEN-QUESTIONS #39 (the "local print agent"); supersedes the kiosk-printing helper of ADR 0027 as the main way to print.

## Context
A website and a cloud server cannot reach a USB or LAN receipt printer, and a browser cannot list printers or
print without a dialog. The shop owner must not configure printers. The browser print window (ADR 0027) works but
asks every time, and nothing prints kitchen tickets in the cloud.

## Decision
- A small **print helper** runs on the counter computer (Windows PowerShell 5.1, already on every Windows
  10/11; the readable script is `apps/web/src/assets/print-helper/agent.ps1`). It lists the installed printers,
  ignores the virtual ones (PDF, XPS, fax), picks the one that looks like a receipt printer, asks the server for
  waiting jobs about every two seconds, sends the bytes to the printer as RAW (winspool), and reports the result.
- **Setup is one button**: Admin, Settings, Printing, "Set up printing on this computer" downloads one `.bat`
  that carries the restaurant's address and a key, installs the helper in `%LOCALAPPDATA%\PosPrintHelper`, makes it
  start with Windows (a Startup `.vbs`, no window) and starts it. Nothing is chosen by hand.
- **Server**: `print_agents` (key stored as a SHA-256 hash, shown once), printers with `conn_type = 'AGENT'`,
  and `/print-agent/hello|claim|jobs/:id/result`. The first `hello` creates a receipt printer and a kitchen printer
  on the chosen printer; a station without a chosen printer prints on the helper's kitchen printer.
- Jobs stay in the same `print_jobs` outbox: per-printer order, one job in flight per printer (the next waits for
  the answer), leases that expire if the helper dies mid-job, retry with backoff, give up after 2 hours,
  idempotency keys. The in-process LAN worker skips `AGENT` printers.
- **Fallback**: a helper's printer counts for receipts only while the helper called in during the last 90 s.
  Otherwise the till gets `receipts = 0` and opens the browser's print window, so a receipt is never lost.
  Kitchen tickets wait in the queue until the helper is back.
- The helper's key can be revoked (Remove): the key stops working and its printers are archived.

## Consequences
- Windows only for now (PowerShell + winspool). A Mac or Linux counter would need another helper.
- The helper prints RAW ESC/POS, so the printer must understand ESC/POS (all common thermal printers do) and its
  Windows driver must pass RAW data (the usual "POS-80" / generic drivers do).
- A duplicate is possible only if the computer dies in the instant between printing and reporting; the job is then
  offered again after its 30 s lease.
- Tried on a real Windows computer with a test printer on a file port: the raw ESC/POS bytes arrive intact. Not yet
  tried on a real iTech IT800.
