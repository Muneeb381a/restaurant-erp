-- Up Migration
-- M6d: credit notes (refunds / returns) against SETTLED bills. Tax is 0 until M5; the tax columns
-- stay so the original-rate reversal can be added without a schema change.

ALTER TABLE credit_notes
  ADD COLUMN idempotency_key text,
  ADD COLUMN refund_reference text;
CREATE UNIQUE INDEX credit_notes_idem ON credit_notes(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX credit_notes_bill_idx ON credit_notes(bill_id);
CREATE INDEX credit_note_lines_line_idx ON credit_note_lines(bill_line_id);

-- Only a settled bill can be credited.
CREATE FUNCTION guard_credit_note() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b bills%ROWTYPE; returned bigint;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- history is immutable; only the fiscal submission fields may change later (M7)
    IF (NEW.bill_id, NEW.cn_no, NEW.reason, NEW.net_paisa, NEW.tax_paisa, NEW.total_paisa, NEW.refund_method_id,
        NEW.shift_id, NEW.approved_by, NEW.created_by, NEW.business_day_id, NEW.branch_id)
       IS DISTINCT FROM
       (OLD.bill_id, OLD.cn_no, OLD.reason, OLD.net_paisa, OLD.tax_paisa, OLD.total_paisa, OLD.refund_method_id,
        OLD.shift_id, OLD.approved_by, OLD.created_by, OLD.business_day_id, OLD.branch_id) THEN
      RAISE EXCEPTION 'credit notes are immutable (only fiscal fields can change)' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- serialise credit notes of one bill, then check the bill
  SELECT * INTO b FROM bills WHERE id = NEW.bill_id FOR UPDATE;
  IF NOT FOUND OR b.status <> 'SETTLED' THEN
    RAISE EXCEPTION 'only a SETTLED bill can be credited' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT COALESCE(SUM(total_paisa), 0) INTO returned FROM credit_notes WHERE bill_id = NEW.bill_id;
  IF returned + NEW.total_paisa > b.total_paisa THEN
    RAISE EXCEPTION 'credit notes (% + %) would exceed the bill total (%)', returned, NEW.total_paisa, b.total_paisa
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER credit_notes_guard BEFORE INSERT OR UPDATE ON credit_notes
  FOR EACH ROW EXECUTE FUNCTION guard_credit_note();

-- A line cannot be returned more often than it was sold; the line row is locked to serialise.
CREATE FUNCTION guard_credit_note_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sold numeric; returned numeric; cn_bill uuid; line_bill uuid;
BEGIN
  SELECT bill_id, qty INTO line_bill, sold FROM bill_lines WHERE id = NEW.bill_line_id FOR UPDATE;
  SELECT bill_id INTO cn_bill FROM credit_notes WHERE id = NEW.credit_note_id;
  IF line_bill IS DISTINCT FROM cn_bill THEN
    RAISE EXCEPTION 'that line is not on the credited bill' USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(SUM(qty), 0) INTO returned FROM credit_note_lines WHERE bill_line_id = NEW.bill_line_id;
  IF returned + NEW.qty > sold THEN
    RAISE EXCEPTION 'returning % + % of a line that sold %', returned, NEW.qty, sold USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER credit_note_lines_qty_guard BEFORE INSERT ON credit_note_lines
  FOR EACH ROW EXECUTE FUNCTION guard_credit_note_line();

-- The shift and the day must be open (cash goes back out of that drawer); doc number is per day.
CREATE TRIGGER credit_notes_shift_open BEFORE INSERT ON credit_notes
  FOR EACH ROW EXECUTE FUNCTION guard_shift_open();
CREATE TRIGGER credit_notes_day_open BEFORE INSERT ON credit_notes
  FOR EACH ROW EXECUTE FUNCTION guard_day_open();

-- Statement order of the khata ledger must not depend on timestamps that can tie (a credit sale and
-- its refund in the same millisecond, imported opening balances, tests with a fixed clock).
ALTER TABLE khata_entries ADD COLUMN seq bigserial NOT NULL;
CREATE INDEX khata_entries_seq_idx ON khata_entries(account_id, seq);
