-- Up Migration
-- M5: the tax engine. Rates live in tax_rules (data, never code); the owner or their accountant manages
-- them. Tax is OFF until `tax.enabled` is switched on, which the API only allows when every rule in use
-- exists, is unambiguous and has been verified by a named person.

-- ---------- per-line tax (credit notes need to reverse it at the original rate) ----------
ALTER TABLE bill_lines
  ADD COLUMN tax_paisa    bigint NOT NULL DEFAULT 0 CHECK (tax_paisa >= 0),
  ADD COLUMN tax_rate_bps int,
  ADD COLUMN tax_rule_id  uuid REFERENCES tax_rules(id);

-- A taxed bill's header tax must equal the sum of its line taxes at the moment it is settled.
CREATE OR REPLACE FUNCTION guard_bill_settle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE paid bigint; line_tax bigint; taxed boolean;
BEGIN
  SELECT COALESCE(SUM(amount_paisa), 0) INTO paid FROM payments WHERE bill_id = NEW.id;
  IF paid <> NEW.total_paisa THEN
    RAISE EXCEPTION 'bill % cannot be settled: payments (%) do not equal the total (%)', NEW.id, paid, NEW.total_paisa
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(SUM(tax_paisa), 0), bool_or(tax_rule_id IS NOT NULL) INTO line_tax, taxed
    FROM bill_lines WHERE bill_id = NEW.id;
  IF COALESCE(taxed, false) AND line_tax <> NEW.tax_paisa THEN
    RAISE EXCEPTION 'bill %: header tax (%) is not the sum of the line taxes (%)', NEW.id, NEW.tax_paisa, line_tax
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- ---------- tax rules: no overlapping periods, and history is immutable ----------
ALTER TABLE tax_rules ADD CONSTRAINT tax_rules_no_overlap EXCLUDE USING gist (
  authority WITH =,
  tax_category_id WITH =,
  payment_class WITH =,
  daterange(effective_from, effective_to, '[]') WITH &&
);

CREATE FUNCTION guard_tax_rule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tax rules are history and cannot be deleted (end them with effective_to)' USING ERRCODE = 'restrict_violation';
  END IF;
  -- a rate is never edited: add a new rule from a new date. Only the end date and the paperwork may change.
  IF (NEW.authority, NEW.tax_category_id, NEW.payment_class, NEW.rate_bps, NEW.effective_from)
     IS DISTINCT FROM
     (OLD.authority, OLD.tax_category_id, OLD.payment_class, OLD.rate_bps, OLD.effective_from) THEN
    RAISE EXCEPTION 'a tax rule''s rate, scope and start date cannot be changed; add a new rule' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tax_rules_guard BEFORE UPDATE OR DELETE ON tax_rules
  FOR EACH ROW EXECUTE FUNCTION guard_tax_rule();
