-- Up Migration
-- M3: floor & orders. Open-day permission, one open shift per user/device, order hold,
-- and freezing of order lines once their order is SETTLED/CANCELLED (closes the gap where only
-- bill_lines were immutable).

-- ---------- permission (granted at the same time, per the 0002 convention) ----------
INSERT INTO permissions(code, description) VALUES ('day.open', 'Open the business day');
INSERT INTO role_permissions(role_id, permission_code)
SELECT r.id, 'day.open' FROM roles r WHERE r.code IN ('OWNER', 'MANAGER', 'CASHIER');

-- ---------- shifts: a cashier / a till has at most one open shift ----------
CREATE UNIQUE INDEX one_open_shift_per_user ON shifts(opened_by) WHERE status = 'OPEN';
CREATE UNIQUE INDEX one_open_shift_per_device ON shifts(device_id) WHERE status = 'OPEN' AND device_id IS NOT NULL;

-- ---------- orders: parked (held) orders ----------
ALTER TABLE orders ADD COLUMN held_at timestamptz;
CREATE INDEX orders_open_idx ON orders(branch_id, status) WHERE status IN ('OPEN', 'BILLED');

-- ---------- order lines are frozen once the order is final ----------
-- After SETTLED/CANCELLED nothing about WHAT was sold may change (use credit notes). The kitchen
-- may still progress a line (status / kot_id), e.g. a takeaway paid before it is ready, but a
-- line can no longer be voided.
CREATE FUNCTION guard_order_items() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  o_status text;
  skip text[] := ARRAY['status', 'kot_id'];
BEGIN
  SELECT status INTO o_status FROM orders WHERE id = COALESCE(NEW.order_id, OLD.order_id);
  IF o_status IN ('SETTLED', 'CANCELLED') THEN
    IF TG_OP = 'INSERT' OR TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'order is % — its lines are frozen', o_status USING ERRCODE = 'restrict_violation';
    END IF;
    IF (to_jsonb(NEW) - skip) IS DISTINCT FROM (to_jsonb(OLD) - skip)
       OR (NEW.status = 'VOID' AND OLD.status <> 'VOID') THEN
      RAISE EXCEPTION 'order is % — its lines are frozen (use a credit note)', o_status USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER order_items_guard BEFORE INSERT OR UPDATE OR DELETE ON order_items
  FOR EACH ROW EXECUTE FUNCTION guard_order_items();

CREATE FUNCTION guard_order_item_modifiers() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o_status text;
BEGIN
  SELECT o.status INTO o_status
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
   WHERE oi.id = COALESCE(NEW.order_item_id, OLD.order_item_id);
  IF o_status IN ('SETTLED', 'CANCELLED') THEN
    RAISE EXCEPTION 'order is % — its lines are frozen', o_status USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER order_item_modifiers_guard BEFORE INSERT OR UPDATE OR DELETE ON order_item_modifiers
  FOR EACH ROW EXECUTE FUNCTION guard_order_item_modifiers();
