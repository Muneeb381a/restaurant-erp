-- Up Migration
-- M7: fiscal reporting outbox. Documents are queued in the same transaction that creates them and sent
-- to the authority by a worker, so a sale never waits for (or fails because of) the internet.

-- The mock provider exercises the pipeline until a real authority driver exists.
ALTER TABLE fiscal_jobs DROP CONSTRAINT fiscal_jobs_provider_check;
ALTER TABLE fiscal_jobs ADD CONSTRAINT fiscal_jobs_provider_check
  CHECK (provider IN ('PRA','SRB','KPRA','BRA','FBR','NONE','MOCK'));

-- A refused document (not a network problem) is parked until a human looks at it.
ALTER TABLE fiscal_jobs ADD COLUMN permanent boolean NOT NULL DEFAULT false;
DROP INDEX fiscal_jobs_due_idx;
CREATE INDEX fiscal_jobs_due_idx ON fiscal_jobs(next_attempt_at)
  WHERE status IN ('PENDING','FAILED') AND NOT permanent;
CREATE INDEX fiscal_jobs_doc_idx ON fiscal_jobs(doc_type, doc_id);

ALTER TABLE credit_notes
  ADD COLUMN fiscal_qr text,
  ADD COLUMN fiscal_submitted_at timestamptz;

-- What was reported is evidence: jobs are never deleted and a DONE job never changes.
CREATE FUNCTION guard_fiscal_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'fiscal jobs are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'DONE' THEN
    RAISE EXCEPTION 'a reported fiscal job is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.doc_type, NEW.doc_id, NEW.provider, NEW.idempotency_key) IS DISTINCT FROM
     (OLD.doc_type, OLD.doc_id, OLD.provider, OLD.idempotency_key) THEN
    RAISE EXCEPTION 'a fiscal job''s document and provider cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_jobs_guard BEFORE UPDATE OR DELETE ON fiscal_jobs
  FOR EACH ROW EXECUTE FUNCTION guard_fiscal_job();
