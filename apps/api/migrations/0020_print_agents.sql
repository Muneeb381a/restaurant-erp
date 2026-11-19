-- Up Migration
-- The print helper: a small program on the counter computer that finds the printers installed there and
-- prints the jobs this restaurant queues, because a website (and the cloud server) cannot reach a USB or
-- LAN printer. The helper identifies itself with a long random key (only its hash is stored).
-- Jobs still live in print_jobs (the outbox), so nothing about ordering, retries or idempotency changes.

CREATE TABLE print_agents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id     uuid NOT NULL REFERENCES branches(id),
  name          text NOT NULL,
  key_hash      text NOT NULL,
  computer      text,
  printers_seen jsonb NOT NULL DEFAULT '[]'::jsonb,   -- what the helper found installed on its computer
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX print_agents_branch_idx ON print_agents (branch_id);

ALTER TABLE printers ADD COLUMN agent_id      uuid REFERENCES print_agents(id);
ALTER TABLE printers ADD COLUMN agent_printer text;     -- the printer's name on the helper's computer

DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'printers'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%conn_type%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE printers DROP CONSTRAINT %I', c); END IF;
END $$;
ALTER TABLE printers ADD CONSTRAINT printers_conn_type_check
  CHECK (conn_type IN ('NETWORK', 'USB', 'SERIAL', 'AGENT'));
