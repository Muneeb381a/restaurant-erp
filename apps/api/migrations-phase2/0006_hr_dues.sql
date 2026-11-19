-- Up Migration
-- HR, milestone 4: money a staff member owes the restaurant (a salary advance, a loan, a fine) and its
-- recovery from pay. A due is a LEDGER (given/fined, recovered, written off); the balance is always added up
-- and can never go below zero. Recovery is a deduction line on the payslip; it is booked in the ledger
-- only when the pay run is APPROVED, once per payslip. Advances and loans are paid out through the expenses
-- ledger (category STAFF_ADVANCE); a fine pays nothing out.

CREATE TABLE staff_dues (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id        uuid NOT NULL REFERENCES branches(id),
  employee_id      uuid NOT NULL REFERENCES employees(id),
  kind             text NOT NULL CHECK (kind IN ('ADVANCE','LOAN','FINE')),
  principal_paisa  bigint NOT NULL CHECK (principal_paisa > 0),
  installment_paisa bigint NOT NULL DEFAULT 0 CHECK (installment_paisa >= 0 AND installment_paisa <= principal_paisa),
  reason           text NOT NULL CHECK (length(btrim(reason)) > 0),
  paused           boolean NOT NULL DEFAULT false,
  closed_at        timestamptz,                         -- set when written off
  expense_id       uuid UNIQUE REFERENCES expenses(id), -- the cash that went out (advance, loan)
  created_by       uuid REFERENCES users(id),
  idempotency_key  text NOT NULL UNIQUE,                -- pressing Save twice records one due
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'FINE') = (expense_id IS NULL))
);
CREATE INDEX staff_dues_employee_idx ON staff_dues(employee_id);

CREATE TABLE staff_due_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  due_id        uuid NOT NULL REFERENCES staff_dues(id),
  kind          text NOT NULL CHECK (kind IN ('DISBURSE','FINE','RECOVERY','WRITE_OFF')),
  amount_paisa  bigint NOT NULL CHECK (amount_paisa > 0),
  payslip_id    uuid REFERENCES payslips(id),
  note          text,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'RECOVERY' OR payslip_id IS NOT NULL)
);
CREATE INDEX staff_due_entries_due_idx ON staff_due_entries(due_id);
-- a payslip recovers a due at most once
CREATE UNIQUE INDEX staff_due_entries_recovery_uq ON staff_due_entries(due_id, payslip_id) WHERE kind = 'RECOVERY';
CREATE TRIGGER staff_due_entries_immutable BEFORE UPDATE OR DELETE ON staff_due_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- the balance can never go below zero, in any order of entries
CREATE FUNCTION guard_staff_due_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bal bigint;
BEGIN
  SELECT COALESCE(sum(CASE WHEN kind IN ('DISBURSE','FINE') THEN amount_paisa ELSE -amount_paisa END), 0)
    INTO bal FROM staff_due_entries WHERE due_id = NEW.due_id;
  IF NEW.kind IN ('RECOVERY','WRITE_OFF') AND bal - NEW.amount_paisa < 0 THEN
    RAISE EXCEPTION 'that would take more (%) than is owed (%)', NEW.amount_paisa, bal USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER staff_due_entries_guard BEFORE INSERT ON staff_due_entries
  FOR EACH ROW EXECUTE FUNCTION guard_staff_due_entry();

-- payslip lines may now be recoveries of a due
ALTER TABLE payslip_lines DROP CONSTRAINT IF EXISTS payslip_lines_source_check;
ALTER TABLE payslip_lines ADD CONSTRAINT payslip_lines_source_check CHECK (source IN ('COMPUTED','ITEM','MANUAL','RECOVERY'));
ALTER TABLE payslip_lines ADD COLUMN due_id uuid REFERENCES staff_dues(id);
