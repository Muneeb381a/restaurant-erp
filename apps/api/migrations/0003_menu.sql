-- Up Migration
-- M2: menu integrity. Prices cannot overlap, stable keys for import, search aliases,
-- deal/kind guards, and the default tax category as reference data (no tax logic here).

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- A variant has at most one price per price list on any given day (same philosophy as tax_rules:
-- never guess). Inclusive ranges; NULL effective_to = open-ended.
ALTER TABLE item_prices ADD CONSTRAINT item_prices_no_overlap EXCLUDE USING gist (
  variant_id WITH =,
  price_list_id WITH =,
  daterange(effective_from, effective_to, '[]') WITH &&
);

-- Stable key so modifier groups can be referenced from imports/exports.
ALTER TABLE modifier_groups ADD COLUMN code text;
CREATE UNIQUE INDEX modifier_groups_branch_code_uq ON modifier_groups(branch_id, code) WHERE code IS NOT NULL;

-- Roman-Urdu / alias search on the POS ("tikka tika ٹکہ").
ALTER TABLE items ADD COLUMN search_terms text;

-- No duplicate names (case-insensitive) where they would be ambiguous.
CREATE UNIQUE INDEX categories_branch_parent_name_uq
  ON categories(branch_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
CREATE UNIQUE INDEX item_variants_item_name_uq ON item_variants(item_id, lower(name));
CREATE UNIQUE INDEX item_variants_one_default_uq ON item_variants(item_id) WHERE is_default;
CREATE UNIQUE INDEX deal_slot_options_slot_variant_uq ON deal_slot_options(slot_id, variant_id);

-- ---------- Deal guards ----------
CREATE FUNCTION guard_deal_slot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM items WHERE id = NEW.deal_item_id AND kind = 'DEAL') THEN
    RAISE EXCEPTION 'deal slots can only belong to items of kind DEAL' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deal_slots_guard BEFORE INSERT OR UPDATE ON deal_slots
  FOR EACH ROW EXECUTE FUNCTION guard_deal_slot();

-- A deal option must be a real item variant, never another deal (no nested deals).
CREATE FUNCTION guard_deal_option() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM item_variants v JOIN items i ON i.id = v.item_id
    WHERE v.id = NEW.variant_id AND i.kind = 'DEAL'
  ) THEN
    RAISE EXCEPTION 'a deal option cannot itself be a deal' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deal_slot_options_guard BEFORE INSERT OR UPDATE ON deal_slot_options
  FOR EACH ROW EXECUTE FUNCTION guard_deal_option();

-- An item's kind decides how it is priced and ordered; it cannot change once it has history
-- (orders) or deal structure.
CREATE FUNCTION guard_item_kind() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind AND (
       EXISTS (SELECT 1 FROM order_items WHERE item_id = OLD.id)
    OR EXISTS (SELECT 1 FROM deal_slots WHERE deal_item_id = OLD.id)
  ) THEN
    RAISE EXCEPTION 'item % has orders or deal slots; its kind cannot change', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER items_kind_guard BEFORE UPDATE OF kind ON items
  FOR EACH ROW EXECUTE FUNCTION guard_item_kind();

-- ---------- Reference data ----------
-- Every item needs a tax category. Rates/rules are NOT defined here (see tax_rules, M5).
INSERT INTO tax_categories(code, name) VALUES ('RESTAURANT_SERVICE', 'Restaurant / food service')
ON CONFLICT (code) DO NOTHING;
