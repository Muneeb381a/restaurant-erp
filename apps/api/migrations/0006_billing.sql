-- Up Migration
-- M6a: billing and payments without the tax engine.

-- One live bill per order for now. Split bills (M5) replace this index with their own rule.
CREATE UNIQUE INDEX one_live_bill_per_order ON bills(order_id) WHERE status <> 'VOID';

-- A bill can only become SETTLED when its payments add up to its total EXACTLY. The overpayment
-- guard on payments (0001) already stops over-paying; this closes the opposite gap, an
-- under-paid settled bill. The API inserts the payments first, then flips the status
-- (ARCHITECTURE §6), all in one transaction.
CREATE FUNCTION guard_bill_settle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE paid bigint;
BEGIN
  SELECT COALESCE(SUM(amount_paisa), 0) INTO paid FROM payments WHERE bill_id = NEW.id;
  IF paid <> NEW.total_paisa THEN
    RAISE EXCEPTION 'bill % cannot be settled: payments (%) do not equal the total (%)', NEW.id, paid, NEW.total_paisa
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bills_settle_guard BEFORE UPDATE OF status ON bills
  FOR EACH ROW WHEN (NEW.status = 'SETTLED' AND OLD.status <> 'SETTLED')
  EXECUTE FUNCTION guard_bill_settle();
