-- Up Migration
-- M4: kitchen tickets and the print outbox.

-- Printers remember how they last behaved, so the UI can show "offline" without probing.
ALTER TABLE printers
  ADD COLUMN last_ok_at    timestamptz,
  ADD COLUMN last_error    text,
  ADD COLUMN last_error_at timestamptz;

-- Transactional outbox for everything that goes to a printer (ARCHITECTURE §8). A ticket is
-- rendered when the KOT is created and stored as bytes, so a printer outage or a restart never
-- loses it and a retry reprints exactly the same ticket. `idempotency_key` makes creating the
-- same job twice impossible (rule 4), e.g. a retried "send".
CREATE TABLE print_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq             bigserial NOT NULL,   -- strict queue order per printer (created_at can tie)
  branch_id       uuid NOT NULL REFERENCES branches(id),
  printer_id      uuid NOT NULL REFERENCES printers(id),
  kind            text NOT NULL CHECK (kind IN ('KOT', 'KOT_CANCEL', 'RECEIPT', 'TEST')),
  ref_type        text,
  ref_id          uuid,
  title           text NOT NULL,
  payload         bytea NOT NULL,
  status          text NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'IN_FLIGHT', 'DONE', 'FAILED', 'DEAD')),
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until     timestamptz,
  last_error      text,
  idempotency_key text NOT NULL UNIQUE,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  printed_at      timestamptz
);
CREATE INDEX print_jobs_queue_idx ON print_jobs(printer_id, seq)
  WHERE status IN ('PENDING', 'FAILED', 'IN_FLIGHT');
CREATE INDEX print_jobs_ref_idx ON print_jobs(ref_type, ref_id);

-- Print history is never deleted (what was sent to the kitchen is evidence).
CREATE TRIGGER print_jobs_no_delete BEFORE DELETE ON print_jobs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- A KOT keeps who sent it (created_by exists) and how many times it has been printed
-- (print_count exists). Each KOT is unique per order line set; nothing else to add.
