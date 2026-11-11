-- Up Migration
-- Phase 2 (app layer): inventory, purchasing, stocktake, expenses. The stock ledger stays append-only:
-- stock = SUM(stock_movements). Corrections are new movements, never edits.

-- ---------- permissions ----------
INSERT INTO permissions(code, description) VALUES
 ('expense.manage','Record expenses and supplier payments');
INSERT INTO role_permissions(role_id, permission_code)
SELECT r.id, 'expense.manage' FROM roles r WHERE r.code IN ('OWNER','MANAGER','ACCOUNTANT');

-- ---------- master data integrity ----------
ALTER TABLE suppliers ADD CONSTRAINT suppliers_name_uq UNIQUE (branch_id, name);

-- ---------- stock ledger ----------
ALTER TABLE stock_movements ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX stock_movements_idem ON stock_movements(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- a movement belongs to the same branch as its ingredient
CREATE FUNCTION guard_stock_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ing_branch uuid;
BEGIN
  SELECT branch_id INTO ing_branch FROM ingredients WHERE id = NEW.ingredient_id;
  IF ing_branch IS DISTINCT FROM NEW.branch_id THEN
    RAISE EXCEPTION 'ingredient % does not belong to branch %', NEW.ingredient_id, NEW.branch_id USING ERRCODE = 'check_violation';
  END IF;
  -- signs by kind: receipts add, consumption removes (ADJUSTMENT may be either)
  IF NEW.kind IN ('OPENING','PURCHASE','PREP_IN','TRANSFER_IN') AND NEW.qty_base <= 0 THEN
    RAISE EXCEPTION '% must add stock', NEW.kind USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind IN ('SALE','WASTAGE','STAFF_MEAL','PREP_OUT','TRANSFER_OUT','RETURN_TO_SUPPLIER') AND NEW.qty_base >= 0 THEN
    RAISE EXCEPTION '% must remove stock', NEW.kind USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_movements_guard BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION guard_stock_movement();

-- ---------- purchases: a posted purchase is a document, not a draft ----------
ALTER TABLE purchases ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX purchases_idem ON purchases(idempotency_key) WHERE idempotency_key IS NOT NULL;
-- the same supplier invoice cannot be entered twice
CREATE UNIQUE INDEX purchases_supplier_invoice ON purchases(supplier_id, invoice_ref)
  WHERE supplier_id IS NOT NULL AND invoice_ref IS NOT NULL AND status <> 'VOID';
CREATE TRIGGER purchases_immutable BEFORE UPDATE OR DELETE ON purchases
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER purchase_lines_immutable BEFORE UPDATE OR DELETE ON purchase_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
-- what was paid is tracked by supplier_payments (also the payment made at purchase time)
ALTER TABLE supplier_payments ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX supplier_payments_idem ON supplier_payments(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX supplier_payments_supplier_idx ON supplier_payments(supplier_id);
CREATE INDEX purchases_supplier_idx ON purchases(supplier_id);

-- ---------- stocktake: a posted count is history ----------
CREATE FUNCTION guard_stocktake() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'stocktakes cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'POSTED' THEN
    RAISE EXCEPTION 'a posted stocktake is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stocktakes_guard BEFORE UPDATE OR DELETE ON stocktakes
  FOR EACH ROW EXECUTE FUNCTION guard_stocktake();

CREATE FUNCTION guard_stocktake_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM stocktakes WHERE id = COALESCE(NEW.stocktake_id, OLD.stocktake_id);
  IF st = 'POSTED' THEN
    RAISE EXCEPTION 'a posted stocktake is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER stocktake_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON stocktake_lines
  FOR EACH ROW EXECUTE FUNCTION guard_stocktake_line();

-- ---------- expenses: money out, append-only, idempotent ----------
ALTER TABLE expenses ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX expenses_idem ON expenses(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TRIGGER expenses_immutable BEFORE UPDATE OR DELETE ON expenses
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
-- money taken from a drawer needs an open shift (same rule as every other drawer movement)
CREATE TRIGGER expenses_shift_open BEFORE INSERT ON expenses
  FOR EACH ROW WHEN (NEW.shift_id IS NOT NULL) EXECUTE FUNCTION guard_shift_open();
CREATE TRIGGER supplier_payments_shift_open BEFORE INSERT ON supplier_payments
  FOR EACH ROW WHEN (NEW.shift_id IS NOT NULL) EXECUTE FUNCTION guard_shift_open();
CREATE TRIGGER purchases_shift_open BEFORE INSERT ON purchases
  FOR EACH ROW WHEN (NEW.shift_id IS NOT NULL) EXECUTE FUNCTION guard_shift_open();

-- ---------- recipes: a variant has one recipe (UNIQUE already); ingredient lines are not edited in place ----------
CREATE INDEX recipe_lines_ingredient_idx ON recipe_lines(ingredient_id);
