-- Up Migration
-- M6b: shift close, cash movements and day close. The rules the API relies on are enforced here too.

-- ---------- cash movements: append-only, idempotent, only into an OPEN shift ----------
ALTER TABLE cash_movements ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX cash_movements_idem ON cash_movements(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX cash_movements_shift_idx ON cash_movements(shift_id);

CREATE TRIGGER cash_movements_immutable BEFORE UPDATE OR DELETE ON cash_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------- money can only move through an OPEN shift ----------
CREATE FUNCTION guard_shift_open() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM shifts WHERE id = NEW.shift_id;
  IF st IS DISTINCT FROM 'OPEN' THEN
    RAISE EXCEPTION 'shift % is % — it cannot take %', NEW.shift_id, COALESCE(st, 'missing'), TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payments_shift_open        BEFORE INSERT ON payments        FOR EACH ROW EXECUTE FUNCTION guard_shift_open();
CREATE TRIGGER cash_movements_shift_open  BEFORE INSERT ON cash_movements  FOR EACH ROW EXECUTE FUNCTION guard_shift_open();

-- ---------- a closed shift is history: the only change allowed is an (audited) reopen ----------
CREATE FUNCTION guard_shift() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'shifts cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'CLOSED' THEN
    IF NEW.status = 'OPEN'
       AND NEW.closed_at IS NULL AND NEW.closed_by IS NULL
       AND NEW.counted_cash_paisa IS NULL AND NEW.expected_cash_paisa IS NULL
       AND NEW.id = OLD.id AND NEW.branch_id = OLD.branch_id AND NEW.business_day_id = OLD.business_day_id
       AND NEW.opened_by = OLD.opened_by AND NEW.opening_float_paisa = OLD.opening_float_paisa THEN
      RETURN NEW; -- reopen
    END IF;
    RAISE EXCEPTION 'shift % is closed and immutable (reopen it first)', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.opening_float_paisa <> OLD.opening_float_paisa OR NEW.opened_by <> OLD.opened_by THEN
    RAISE EXCEPTION 'the opening float and owner of a shift cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status = 'CLOSED' AND (NEW.counted_cash_paisa IS NULL OR NEW.expected_cash_paisa IS NULL
                                OR NEW.closed_at IS NULL OR NEW.closed_by IS NULL) THEN
    RAISE EXCEPTION 'closing a shift needs the counted and expected cash and who closed it' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shifts_guard BEFORE UPDATE OR DELETE ON shifts FOR EACH ROW EXECUTE FUNCTION guard_shift();

-- ---------- a closed business day stays closed ----------
CREATE FUNCTION guard_business_day() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'business days cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'CLOSED' THEN
    RAISE EXCEPTION 'business day % is closed and immutable', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status = 'CLOSED' AND (NEW.closed_at IS NULL OR NEW.closed_by IS NULL) THEN
    RAISE EXCEPTION 'closing a business day needs closed_at and closed_by' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_days_guard BEFORE UPDATE OR DELETE ON business_days FOR EACH ROW EXECUTE FUNCTION guard_business_day();

-- ---------- nothing new starts in a day that is closed (or closing) ----------
-- FOR SHARE makes an in-flight insert and a day close serialise: closing waits for inserters to
-- finish, and inserters that arrive later see CLOSED.
CREATE FUNCTION guard_day_open() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM business_days WHERE id = NEW.business_day_id AND status = 'OPEN' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'business day % is not open', NEW.business_day_id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_day_open BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION guard_day_open();
CREATE TRIGGER shifts_day_open BEFORE INSERT ON shifts FOR EACH ROW EXECUTE FUNCTION guard_day_open();

-- ---------- print queue: shift/day reports and "no sale" drawer pulses ----------
ALTER TABLE print_jobs DROP CONSTRAINT print_jobs_kind_check;
ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_kind_check
  CHECK (kind IN ('KOT', 'KOT_CANCEL', 'RECEIPT', 'TEST', 'REPORT', 'DRAWER'));
