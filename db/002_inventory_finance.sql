-- =====================================================================
-- Restaurant ERP — 002 INVENTORY, RECIPES, PURCHASING, EXPENSES  (Phase 2)
-- Stock = SUM(stock_movements). Movements are append-only. Never UPDATE a quantity.
-- =====================================================================

CREATE TABLE suppliers (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id),
  name      text NOT NULL,
  phone     text,
  notes     text,
  is_active boolean NOT NULL DEFAULT true
);

-- base_uom is the smallest stored unit: g, ml or pcs. kg/litre conversions happen in the UI/API.
CREATE TABLE ingredients (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id        uuid NOT NULL REFERENCES branches(id),
  name             text NOT NULL,
  name_ur          text,
  category         text,                           -- GOSHT, SABZI, MASALA, OIL, BEVERAGE, PACKAGING
  base_uom         text NOT NULL CHECK (base_uom IN ('g','ml','pcs')),
  purchase_uom     text NOT NULL,                  -- kg, litre, dozen, carton ...
  purchase_to_base numeric(14,4) NOT NULL CHECK (purchase_to_base > 0),   -- 1 kg = 1000 g
  yield_bps        int NOT NULL DEFAULT 10000 CHECK (yield_bps BETWEEN 1 AND 10000), -- gosht after bone/fat loss
  is_prep          boolean NOT NULL DEFAULT false, -- semi-finished (gravy base, boiled gosht)
  reorder_level    numeric(14,3),
  avg_cost_per_base numeric(14,6) NOT NULL DEFAULT 0, -- paisa per base unit, USABLE basis (after yield)
  is_active        boolean NOT NULL DEFAULT true,
  UNIQUE (branch_id, name)
);

CREATE TABLE recipes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id uuid UNIQUE REFERENCES item_variants(id) ON DELETE CASCADE,   -- sellable recipe (Half/Full)
  ingredient_id uuid UNIQUE REFERENCES ingredients(id) ON DELETE CASCADE,  -- prep recipe (produces a prep ingredient)
  output_qty_base numeric(14,3) NOT NULL DEFAULT 1,                        -- prep batches: how much it yields
  is_active  boolean NOT NULL DEFAULT true,
  CHECK ((variant_id IS NOT NULL) <> (ingredient_id IS NOT NULL))
);
CREATE TABLE recipe_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id     uuid NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  ingredient_id uuid NOT NULL REFERENCES ingredients(id),
  qty_base      numeric(14,3) NOT NULL CHECK (qty_base > 0),   -- WEIGHT variants: qty per 1000 g sold
  UNIQUE (recipe_id, ingredient_id)
);

CREATE TABLE purchases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id       uuid NOT NULL REFERENCES branches(id),
  business_day_id uuid REFERENCES business_days(id),
  supplier_id     uuid REFERENCES suppliers(id),
  invoice_ref     text,
  status          text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','POSTED','VOID')),
  paid_paisa      bigint NOT NULL DEFAULT 0,
  total_paisa     bigint NOT NULL DEFAULT 0,
  payment_source  text CHECK (payment_source IN ('DRAWER_CASH','OWNER_CASH','BANK','CREDIT')),
  shift_id        uuid REFERENCES shifts(id),      -- set when paid from drawer cash
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE purchase_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id   uuid NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  ingredient_id uuid NOT NULL REFERENCES ingredients(id),
  qty_purchase_uom numeric(14,3) NOT NULL CHECK (qty_purchase_uom > 0),
  unit_cost_paisa  bigint NOT NULL CHECK (unit_cost_paisa >= 0),   -- per purchase_uom
  line_total_paisa bigint NOT NULL
);

CREATE TABLE stock_movements (
  id              bigserial PRIMARY KEY,
  branch_id       uuid NOT NULL REFERENCES branches(id),
  ingredient_id   uuid NOT NULL REFERENCES ingredients(id),
  kind            text NOT NULL CHECK (kind IN
                    ('OPENING','PURCHASE','SALE','WASTAGE','STAFF_MEAL','ADJUSTMENT',
                     'PREP_IN','PREP_OUT','TRANSFER_IN','TRANSFER_OUT','RETURN_TO_SUPPLIER')),
  qty_base        numeric(14,3) NOT NULL CHECK (qty_base <> 0),    -- signed: + in, - out
  unit_cost_per_base numeric(14,6),                                -- cost snapshot
  reason_code     text,                                            -- SPOILAGE, OVERCOOK, DROPPED, RETURNED_BY_GUEST...
  ref_type        text, ref_id uuid,                               -- ORDER_ITEM, PURCHASE, STOCKTAKE, PREP_BATCH
  business_day_id uuid REFERENCES business_days(id),
  note            text,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_mov_ing_idx ON stock_movements(ingredient_id, created_at);
CREATE INDEX stock_mov_ref_idx ON stock_movements(ref_type, ref_id);
CREATE TRIGGER stock_movements_immutable BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE VIEW stock_on_hand AS
  SELECT branch_id, ingredient_id, SUM(qty_base) AS qty_base
  FROM stock_movements GROUP BY branch_id, ingredient_id;

CREATE TABLE stocktakes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id       uuid NOT NULL REFERENCES branches(id),
  business_day_id uuid REFERENCES business_days(id),
  status          text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','POSTED')),
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  posted_at       timestamptz
);
CREATE TABLE stocktake_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stocktake_id  uuid NOT NULL REFERENCES stocktakes(id) ON DELETE CASCADE,
  ingredient_id uuid NOT NULL REFERENCES ingredients(id),
  system_qty    numeric(14,3) NOT NULL,
  counted_qty   numeric(14,3),
  UNIQUE (stocktake_id, ingredient_id)
);

-- Cost snapshot per sold line (so recipe/price changes never rewrite history)
ALTER TABLE order_items ADD COLUMN cost_paisa_snapshot bigint;

CREATE TABLE supplier_payments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid NOT NULL REFERENCES suppliers(id),
  purchase_id uuid REFERENCES purchases(id),
  amount_paisa bigint NOT NULL CHECK (amount_paisa > 0),
  source      text NOT NULL CHECK (source IN ('DRAWER_CASH','OWNER_CASH','BANK')),
  shift_id    uuid REFERENCES shifts(id),
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER supplier_payments_immutable BEFORE UPDATE OR DELETE ON supplier_payments
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE expenses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id       uuid NOT NULL REFERENCES branches(id),
  business_day_id uuid REFERENCES business_days(id),
  category        text NOT NULL,                   -- RENT, ELECTRICITY, GAS, SALARY, REPAIR, MISC
  amount_paisa    bigint NOT NULL CHECK (amount_paisa > 0),
  paid_from       text NOT NULL CHECK (paid_from IN ('DRAWER_CASH','OWNER_CASH','BANK')),
  shift_id        uuid REFERENCES shifts(id),
  note            text,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
