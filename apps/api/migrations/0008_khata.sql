-- Up Migration
-- M6c: khata (customer credit). An append-only ledger with a signed amount, a credit limit and a
-- no-overpayment rule enforced by the database under a per-account lock.

-- ---------- permissions ----------
INSERT INTO permissions(code, description) VALUES
 ('khata.collect','View khata accounts, charge khata at settle, receive khata payments'),
 ('customer.manage','Create customers and khata accounts, set credit limits, adjust balances');

INSERT INTO role_permissions(role_id, permission_code)
SELECT r.id, p.code FROM roles r, permissions p
 WHERE r.code IN ('OWNER','MANAGER') AND p.code IN ('khata.collect','customer.manage');
INSERT INTO role_permissions(role_id, permission_code)
SELECT r.id, p.code FROM roles r, permissions p
 WHERE r.code = 'CASHIER' AND p.code = 'khata.collect';

-- ---------- ledger shape ----------
-- The generic ADJUST kind of 0001 had no direction. Nothing wrote to this table before M6c; refuse
-- to continue (rather than rewrite append-only history) if that ever turns out to be false.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM khata_entries) THEN
    RAISE EXCEPTION 'khata_entries is not empty: migrate its rows by hand before 0008';
  END IF;
END $$;

ALTER TABLE khata_entries DROP CONSTRAINT khata_entries_kind_check;
ALTER TABLE khata_entries ADD CONSTRAINT khata_entries_kind_check
  CHECK (kind IN ('CHARGE','PAYMENT','ADJUST_UP','ADJUST_DOWN','REFUND'));

ALTER TABLE khata_entries
  ADD COLUMN method_id       uuid REFERENCES payment_methods(id),
  ADD COLUMN shift_id        uuid REFERENCES shifts(id),
  ADD COLUMN reference       text,
  ADD COLUMN credit_note_id  uuid REFERENCES credit_notes(id),
  ADD COLUMN idempotency_key text,
  -- + raises what the customer owes, - lowers it
  ADD COLUMN delta_paisa     bigint GENERATED ALWAYS AS (
    CASE WHEN kind IN ('CHARGE','ADJUST_UP') THEN amount_paisa ELSE -amount_paisa END) STORED;

CREATE UNIQUE INDEX khata_entries_idem ON khata_entries(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX khata_entries_account_idx ON khata_entries(account_id, created_at);
CREATE UNIQUE INDEX khata_one_charge_per_payment ON khata_entries(payment_id) WHERE kind = 'CHARGE';

-- every kind carries what it needs to be traceable
ALTER TABLE khata_entries ADD CONSTRAINT khata_entry_shape CHECK (
  CASE kind
    WHEN 'CHARGE'      THEN bill_id IS NOT NULL AND payment_id IS NOT NULL
    WHEN 'PAYMENT'     THEN method_id IS NOT NULL AND shift_id IS NOT NULL
    WHEN 'REFUND'      THEN credit_note_id IS NOT NULL
    ELSE note IS NOT NULL
  END);

-- ---------- credit limit and no overpayment, serialised per account ----------
CREATE FUNCTION guard_khata_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE acct khata_accounts%ROWTYPE; bal bigint;
BEGIN
  SELECT * INTO acct FROM khata_accounts WHERE id = NEW.account_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'khata account % does not exist', NEW.account_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  SELECT COALESCE(SUM(delta_paisa), 0) INTO bal FROM khata_entries WHERE account_id = NEW.account_id;
  IF NEW.kind = 'CHARGE' THEN
    IF NOT acct.is_active THEN
      RAISE EXCEPTION 'khata account % is inactive', NEW.account_id USING ERRCODE = 'restrict_violation';
    END IF;
    IF bal + NEW.amount_paisa > acct.credit_limit_paisa THEN
      RAISE EXCEPTION 'credit limit exceeded: balance % + % > limit %', bal, NEW.amount_paisa, acct.credit_limit_paisa
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.kind = 'PAYMENT' THEN
    IF NEW.amount_paisa > bal THEN
      RAISE EXCEPTION 'payment % is more than the balance %', NEW.amount_paisa, bal USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER khata_entries_guard BEFORE INSERT ON khata_entries FOR EACH ROW EXECUTE FUNCTION guard_khata_entry();

-- cash received on a khata account goes into a drawer: only through an OPEN shift
CREATE TRIGGER khata_entries_shift_open BEFORE INSERT ON khata_entries
  FOR EACH ROW WHEN (NEW.shift_id IS NOT NULL) EXECUTE FUNCTION guard_shift_open();
