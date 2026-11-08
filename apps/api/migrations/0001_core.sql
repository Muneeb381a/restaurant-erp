-- Up Migration
-- Ported verbatim from db/001_core.sql (reference). Keep in sync: apps/api/test/db/migrations-sync.test.ts
-- =====================================================================
-- Restaurant ERP — 001 CORE SCHEMA  (PostgreSQL 15+)
-- Conventions
--   * ids: uuid (gen_random_uuid) so branches/devices can sync later
--   * money: BIGINT in paisa (1 PKR = 100 paisa). Never float.
--   * quantities: NUMERIC(12,3)
--   * *_bps = basis points (1% = 100 bps)
--   * timestamps: timestamptz; business dates: DATE (hotel/restaurant day, NOT calendar day)
--   * financial tables are APPEND-ONLY / immutable once settled (triggers at bottom)
-- =====================================================================

-- ---------- Tenancy / branches ----------
CREATE TABLE branches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL UNIQUE,
  name            text NOT NULL,
  timezone        text NOT NULL DEFAULT 'Asia/Karachi',
  ntn             text,
  strn            text,                       -- sales tax reg no. (or PNTN for PRA)
  tax_authority   text NOT NULL DEFAULT 'NONE'
                  CHECK (tax_authority IN ('PRA','SRB','KPRA','BRA','FBR','NONE')),
  address         text,
  phone           text,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE settings (
  branch_id  uuid NOT NULL REFERENCES branches(id),
  key        text NOT NULL,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (branch_id, key)
);
COMMENT ON TABLE settings IS
 'e.g. tax.service_charge_taxable, tax.mixed_tender_policy, billing.round_to_rupee, kot.print_on_send';

-- ---------- Auth / RBAC ----------
CREATE TABLE roles (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code  text NOT NULL UNIQUE,
  name  text NOT NULL
);
CREATE TABLE permissions (
  code        text PRIMARY KEY,
  description text NOT NULL
);
CREATE TABLE role_permissions (
  role_id         uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_code)
);
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id     uuid REFERENCES branches(id),     -- NULL = owner/all branches
  role_id       uuid NOT NULL REFERENCES roles(id),
  username      text NOT NULL UNIQUE,
  full_name     text NOT NULL,
  password_hash text,                              -- argon2id; managers/owner
  pin_hash      text,                              -- argon2id; waiters/cashiers quick login
  discount_limit_bps int NOT NULL DEFAULT 0,       -- max discount this user may give without approval
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE devices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id    uuid NOT NULL REFERENCES branches(id),
  name         text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('COUNTER','CAPTAIN','KDS','ADMIN')),
  token_hash   text NOT NULL,
  last_seen_at timestamptz,
  is_active    boolean NOT NULL DEFAULT true
);

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id),
  device_id    uuid REFERENCES devices(id),
  refresh_hash text NOT NULL,                       -- rotating refresh token (hashed)
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------- Business day & shifts ----------
CREATE TABLE business_days (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id     uuid NOT NULL REFERENCES branches(id),
  business_date date NOT NULL,
  status        text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  opened_at     timestamptz NOT NULL DEFAULT now(),
  opened_by     uuid REFERENCES users(id),
  closed_at     timestamptz,
  closed_by     uuid REFERENCES users(id),
  UNIQUE (branch_id, business_date)
);
CREATE UNIQUE INDEX one_open_day_per_branch ON business_days(branch_id) WHERE status = 'OPEN';

CREATE TABLE shifts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id           uuid NOT NULL REFERENCES branches(id),
  business_day_id     uuid NOT NULL REFERENCES business_days(id),
  device_id           uuid REFERENCES devices(id),
  opened_by           uuid NOT NULL REFERENCES users(id),
  opened_at           timestamptz NOT NULL DEFAULT now(),
  opening_float_paisa bigint NOT NULL DEFAULT 0 CHECK (opening_float_paisa >= 0),
  status              text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  closed_by           uuid REFERENCES users(id),
  closed_at           timestamptz,
  expected_cash_paisa bigint,
  counted_cash_paisa  bigint,
  variance_paisa      bigint GENERATED ALWAYS AS (counted_cash_paisa - expected_cash_paisa) STORED,
  notes               text
);
CREATE INDEX shifts_day_idx ON shifts(business_day_id);

CREATE TABLE cash_movements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id    uuid NOT NULL REFERENCES shifts(id),
  kind        text NOT NULL CHECK (kind IN ('PAID_OUT','CASH_IN','DROP','NO_SALE_OPEN')),
  amount_paisa bigint NOT NULL DEFAULT 0 CHECK (amount_paisa >= 0),
  reason      text,
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- Floor ----------
CREATE TABLE areas (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id),
  name      text NOT NULL,
  sort      int NOT NULL DEFAULT 0
);
CREATE TABLE dining_tables (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id),
  area_id   uuid REFERENCES areas(id),
  code      text NOT NULL,
  seats     int NOT NULL DEFAULT 4,
  pos_x     int, pos_y int,                        -- floor-plan layout
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (branch_id, code)
);

-- ---------- Kitchen stations & printers ----------
CREATE TABLE stations (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id),
  code      text NOT NULL,                         -- BBQ, TANDOOR, KARAHI, FRY, DRINKS
  name      text NOT NULL,
  UNIQUE (branch_id, code)
);
CREATE TABLE printers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id   uuid NOT NULL REFERENCES branches(id),
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('RECEIPT','KOT')),
  conn_type   text NOT NULL CHECK (conn_type IN ('NETWORK','USB','SERIAL')),
  host        text, port int DEFAULT 9100,
  paper_mm    int NOT NULL DEFAULT 80 CHECK (paper_mm IN (58,80)),
  is_active   boolean NOT NULL DEFAULT true
);
CREATE TABLE station_printers (
  station_id uuid NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  printer_id uuid NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
  PRIMARY KEY (station_id, printer_id)
);

-- ---------- Tax master ----------
CREATE TABLE tax_categories (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,                       -- RESTAURANT_SERVICE, PACKAGED_GOODS...
  name text NOT NULL
);
-- Effective-dated rules. payment_class decides the rate (Punjab: DIGITAL 8% / CASH_OTHER 16%).
CREATE TABLE tax_rules (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  authority          text NOT NULL CHECK (authority IN ('PRA','SRB','KPRA','BRA','FBR','NONE')),
  tax_category_id    uuid NOT NULL REFERENCES tax_categories(id),
  payment_class      text NOT NULL CHECK (payment_class IN ('CASH_OTHER','DIGITAL','ANY')),
  rate_bps           int  NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
  input_tax_adjustable boolean NOT NULL DEFAULT false,
  effective_from     date NOT NULL,
  effective_to       date,
  source_note        text,                         -- notification / finance act reference
  verified_by        text,                         -- who confirmed this rate (CA/consultant)
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  UNIQUE (authority, tax_category_id, payment_class, effective_from)
);

-- ---------- Menu ----------
CREATE TABLE price_lists (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id),
  code      text NOT NULL,                         -- DINE_IN, TAKEAWAY, DELIVERY
  name      text NOT NULL,
  UNIQUE (branch_id, code)
);
CREATE TABLE categories (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id),
  parent_id uuid REFERENCES categories(id),
  name      text NOT NULL,
  name_ur   text,
  sort      int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true
);
CREATE TABLE items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id       uuid NOT NULL REFERENCES branches(id),
  category_id     uuid REFERENCES categories(id),
  station_id      uuid REFERENCES stations(id),
  tax_category_id uuid NOT NULL REFERENCES tax_categories(id),
  code            text,
  name            text NOT NULL,
  name_ur         text,
  kind            text NOT NULL DEFAULT 'STANDARD' CHECK (kind IN ('STANDARD','WEIGHT','DEAL')),
  is_available    boolean NOT NULL DEFAULT true,   -- 86'd toggle (sold out today)
  is_active       boolean NOT NULL DEFAULT true,
  sort            int NOT NULL DEFAULT 0,
  UNIQUE (branch_id, code)
);
-- Half / Full / Family / "per kg" are variants. Price+recipe live on the variant.
CREATE TABLE item_variants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id    uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  name       text NOT NULL,
  name_ur    text,
  sort       int NOT NULL DEFAULT 0,
  is_default boolean NOT NULL DEFAULT false,
  is_active  boolean NOT NULL DEFAULT true
);
CREATE TABLE item_prices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id     uuid NOT NULL REFERENCES item_variants(id) ON DELETE CASCADE,
  price_list_id  uuid NOT NULL REFERENCES price_lists(id),
  price_paisa    bigint NOT NULL CHECK (price_paisa >= 0),   -- WEIGHT items: price per kg
  effective_from date NOT NULL DEFAULT current_date,
  effective_to   date,
  UNIQUE (variant_id, price_list_id, effective_from)
);
CREATE TABLE modifier_groups (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id  uuid NOT NULL REFERENCES branches(id),
  name       text NOT NULL,
  name_ur    text,
  min_select int NOT NULL DEFAULT 0,
  max_select int NOT NULL DEFAULT 1,
  CHECK (max_select >= min_select)
);
CREATE TABLE modifiers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    uuid NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  name        text NOT NULL,
  name_ur     text,
  price_delta_paisa bigint NOT NULL DEFAULT 0,
  sort        int NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true
);
CREATE TABLE item_modifier_groups (
  item_id  uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  sort     int NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, group_id)
);
-- Deals/combos: item.kind='DEAL' has a fixed price (item_prices) and slots to choose from.
CREATE TABLE deal_slots (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  name         text NOT NULL,                      -- "Choose karahi", "Choose drink"
  qty          int  NOT NULL DEFAULT 1 CHECK (qty > 0),
  sort         int NOT NULL DEFAULT 0
);
CREATE TABLE deal_slot_options (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id     uuid NOT NULL REFERENCES deal_slots(id) ON DELETE CASCADE,
  variant_id  uuid NOT NULL REFERENCES item_variants(id),
  price_delta_paisa bigint NOT NULL DEFAULT 0,     -- upcharge for premium choice
  is_default  boolean NOT NULL DEFAULT false
);

-- ---------- Customers ----------
CREATE TABLE customers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  phone      text,
  notes      text,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX customers_phone_uq ON customers(phone) WHERE phone IS NOT NULL;
CREATE TABLE customer_addresses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  label       text,
  address     text NOT NULL,
  area        text,
  landmark    text
);

-- ---------- Document counters (gap-free per branch/day/type) ----------
CREATE TABLE doc_counters (
  branch_id       uuid NOT NULL REFERENCES branches(id),
  business_day_id uuid NOT NULL REFERENCES business_days(id),
  doc_type        text NOT NULL,                   -- ORDER, KOT, BILL, CREDIT_NOTE
  last_no         int  NOT NULL DEFAULT 0,
  PRIMARY KEY (branch_id, business_day_id, doc_type)
);
CREATE FUNCTION next_doc_no(p_branch uuid, p_day uuid, p_type text) RETURNS int
LANGUAGE sql AS $$
  INSERT INTO doc_counters AS c (branch_id, business_day_id, doc_type, last_no)
  VALUES (p_branch, p_day, p_type, 1)
  ON CONFLICT (branch_id, business_day_id, doc_type)
  DO UPDATE SET last_no = c.last_no + 1
  RETURNING last_no;
$$;

-- ---------- Orders ----------
CREATE TABLE orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id       uuid NOT NULL REFERENCES branches(id),
  business_day_id uuid NOT NULL REFERENCES business_days(id),
  order_no        int  NOT NULL,
  type            text NOT NULL CHECK (type IN ('DINE_IN','TAKEAWAY','DELIVERY')),
  channel         text NOT NULL DEFAULT 'POS'
                  CHECK (channel IN ('POS','PHONE','WHATSAPP','FOODPANDA','WEB','OTHER')),
  status          text NOT NULL DEFAULT 'OPEN'
                  CHECK (status IN ('OPEN','BILLED','SETTLED','CANCELLED')),
  table_id        uuid REFERENCES dining_tables(id),
  guests          int,
  customer_id     uuid REFERENCES customers(id),
  address_id      uuid REFERENCES customer_addresses(id),
  price_list_id   uuid NOT NULL REFERENCES price_lists(id),
  waiter_id       uuid REFERENCES users(id),
  notes           text,
  opened_by       uuid NOT NULL REFERENCES users(id),
  opened_at       timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  version         int NOT NULL DEFAULT 1,          -- optimistic locking
  UNIQUE (branch_id, business_day_id, order_no),
  CHECK (type <> 'DINE_IN' OR table_id IS NOT NULL OR status = 'CANCELLED')
);
-- one OPEN order per table at a time (merge/transfer handled in app)
CREATE UNIQUE INDEX one_open_order_per_table ON orders(table_id)
  WHERE status IN ('OPEN','BILLED') AND table_id IS NOT NULL;
CREATE INDEX orders_day_idx ON orders(business_day_id, status);

CREATE TABLE kots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id       uuid NOT NULL REFERENCES branches(id),
  business_day_id uuid NOT NULL REFERENCES business_days(id),
  order_id        uuid NOT NULL REFERENCES orders(id),
  station_id      uuid NOT NULL REFERENCES stations(id),
  kot_no          int  NOT NULL,
  status          text NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','PREPARING','READY','DONE','CANCELLED')),
  is_rush         boolean NOT NULL DEFAULT false,
  print_count     int NOT NULL DEFAULT 0,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, business_day_id, kot_no)
);

CREATE TABLE order_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id              uuid NOT NULL REFERENCES orders(id),
  parent_order_item_id  uuid REFERENCES order_items(id),   -- deal components
  item_id               uuid NOT NULL REFERENCES items(id),
  variant_id            uuid NOT NULL REFERENCES item_variants(id),
  name_snapshot         text NOT NULL,                     -- "Chicken Karahi (Half)"
  name_ur_snapshot      text,
  qty                   numeric(12,3) NOT NULL CHECK (qty > 0),
  weight_g              int CHECK (weight_g IS NULL OR weight_g > 0),   -- WEIGHT items
  unit_price_paisa      bigint NOT NULL CHECK (unit_price_paisa >= 0),  -- per unit or per kg snapshot
  modifiers_total_paisa bigint NOT NULL DEFAULT 0,
  line_total_paisa      bigint NOT NULL CHECK (line_total_paisa >= 0),
  tax_category_id       uuid NOT NULL REFERENCES tax_categories(id),
  station_id            uuid REFERENCES stations(id),
  kot_id                uuid REFERENCES kots(id),
  course                int NOT NULL DEFAULT 1,
  status                text NOT NULL DEFAULT 'NEW'
                        CHECK (status IN ('NEW','SENT','PREPARING','READY','SERVED','VOID')),
  note                  text,
  void_reason           text,
  voided_by             uuid REFERENCES users(id),
  voided_at             timestamptz,
  is_complimentary      boolean NOT NULL DEFAULT false,
  created_by            uuid NOT NULL REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'VOID' OR (void_reason IS NOT NULL AND voided_by IS NOT NULL))
);
CREATE INDEX order_items_order_idx ON order_items(order_id);
CREATE INDEX order_items_kot_idx ON order_items(kot_id);

CREATE TABLE order_item_modifiers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_item_id     uuid NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  modifier_id       uuid REFERENCES modifiers(id),
  name_snapshot     text NOT NULL,
  price_delta_paisa bigint NOT NULL DEFAULT 0
);

-- ---------- Delivery ----------
CREATE TABLE riders (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id),
  name      text NOT NULL,
  phone     text,
  is_active boolean NOT NULL DEFAULT true
);
CREATE TABLE deliveries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            uuid NOT NULL UNIQUE REFERENCES orders(id),
  rider_id            uuid REFERENCES riders(id),
  status              text NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','ASSIGNED','OUT','DELIVERED','FAILED','RETURNED')),
  address_snapshot    text NOT NULL,
  contact_phone       text,
  delivery_charge_paisa bigint NOT NULL DEFAULT 0,
  cod_due_paisa       bigint NOT NULL DEFAULT 0,
  cod_settled_paisa   bigint,
  assigned_at         timestamptz,
  out_at              timestamptz,
  delivered_at        timestamptz,
  settled_at          timestamptz,
  settled_shift_id    uuid REFERENCES shifts(id)
);

-- ---------- Billing ----------
CREATE TABLE payment_methods (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id    uuid NOT NULL REFERENCES branches(id),
  code         text NOT NULL,                      -- CASH, CARD, JAZZCASH, EASYPAISA, RAAST_QR, KHATA
  name         text NOT NULL,
  tender_class text NOT NULL CHECK (tender_class IN ('CASH_OTHER','DIGITAL')),
  opens_drawer boolean NOT NULL DEFAULT false,
  needs_reference boolean NOT NULL DEFAULT false,
  is_active    boolean NOT NULL DEFAULT true,
  UNIQUE (branch_id, code)
);

CREATE TABLE bills (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id            uuid NOT NULL REFERENCES branches(id),
  business_day_id      uuid NOT NULL REFERENCES business_days(id),
  order_id             uuid NOT NULL REFERENCES orders(id),   -- many bills per order = split bill
  bill_no              int  NOT NULL,
  status               text NOT NULL DEFAULT 'DRAFT'
                       CHECK (status IN ('DRAFT','PRE_BILLED','SETTLED','VOID')),
  customer_id          uuid REFERENCES customers(id),
  subtotal_paisa       bigint NOT NULL DEFAULT 0,
  discount_paisa       bigint NOT NULL DEFAULT 0 CHECK (discount_paisa >= 0),
  discount_reason      text,
  discount_approved_by uuid REFERENCES users(id),
  service_charge_paisa bigint NOT NULL DEFAULT 0 CHECK (service_charge_paisa >= 0),
  taxable_paisa        bigint NOT NULL DEFAULT 0,
  tax_rule_id          uuid REFERENCES tax_rules(id),
  tax_rate_bps         int,
  tax_payment_class    text CHECK (tax_payment_class IN ('CASH_OTHER','DIGITAL')),
  tax_paisa            bigint NOT NULL DEFAULT 0 CHECK (tax_paisa >= 0),
  round_off_paisa      bigint NOT NULL DEFAULT 0,
  total_paisa          bigint NOT NULL DEFAULT 0,
  shift_id             uuid REFERENCES shifts(id),            -- shift that settled it
  settled_by           uuid REFERENCES users(id),
  settled_at           timestamptz,
  fiscal_status        text NOT NULL DEFAULT 'NOT_REQUIRED'
                       CHECK (fiscal_status IN ('NOT_REQUIRED','PENDING','SUBMITTED','FAILED')),
  fiscal_invoice_no    text,
  fiscal_qr            text,
  fiscal_submitted_at  timestamptz,
  print_count          int NOT NULL DEFAULT 0,
  created_by           uuid NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, business_day_id, bill_no),
  -- arithmetic invariant once a bill is priced:
  CONSTRAINT bill_total_math CHECK (
    status = 'DRAFT' OR
    total_paisa = taxable_paisa + tax_paisa + round_off_paisa
  ),
  CONSTRAINT bill_taxable_math CHECK (
    status = 'DRAFT' OR
    taxable_paisa = subtotal_paisa - discount_paisa + service_charge_paisa
  ),
  CONSTRAINT bill_settled_needs_class CHECK (
    status <> 'SETTLED' OR (tax_payment_class IS NOT NULL AND settled_at IS NOT NULL AND shift_id IS NOT NULL)
  )
);
CREATE INDEX bills_order_idx ON bills(order_id);
CREATE INDEX bills_day_idx ON bills(business_day_id, status);

CREATE TABLE bill_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id          uuid NOT NULL REFERENCES bills(id),
  line_kind        text NOT NULL DEFAULT 'ITEM' CHECK (line_kind IN ('ITEM','CHARGE')),
  order_item_id    uuid REFERENCES order_items(id),
  description      text NOT NULL,
  qty              numeric(12,3) NOT NULL DEFAULT 1,
  unit_price_paisa bigint NOT NULL DEFAULT 0,
  portion_bps      int NOT NULL DEFAULT 10000 CHECK (portion_bps BETWEEN 1 AND 10000), -- split one item across bills
  net_paisa        bigint NOT NULL,                -- line amount before bill-level discount/tax
  tax_category_id  uuid REFERENCES tax_categories(id),
  CHECK (line_kind = 'CHARGE' OR order_item_id IS NOT NULL)
);
CREATE INDEX bill_lines_bill_idx ON bill_lines(bill_id);

-- Payments are APPEND-ONLY. Mistakes are corrected with credit notes / refund rows, never edits.
CREATE TABLE payments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id          uuid NOT NULL REFERENCES bills(id),
  shift_id         uuid NOT NULL REFERENCES shifts(id),
  method_id        uuid NOT NULL REFERENCES payment_methods(id),
  tender_class     text NOT NULL CHECK (tender_class IN ('CASH_OTHER','DIGITAL')),
  amount_paisa     bigint NOT NULL CHECK (amount_paisa > 0),   -- applied to the bill
  tendered_paisa   bigint,                                      -- cash handed over
  change_paisa     bigint NOT NULL DEFAULT 0,
  tip_paisa        bigint NOT NULL DEFAULT 0 CHECK (tip_paisa >= 0),
  reference        text,                                        -- card RRN / wallet txn id
  idempotency_key  text NOT NULL UNIQUE,
  received_by      uuid NOT NULL REFERENCES users(id),
  received_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_bill_idx ON payments(bill_id);
CREATE INDEX payments_shift_idx ON payments(shift_id);

CREATE TABLE credit_notes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id         uuid NOT NULL REFERENCES branches(id),
  business_day_id   uuid NOT NULL REFERENCES business_days(id),
  bill_id           uuid NOT NULL REFERENCES bills(id),
  cn_no             int NOT NULL,
  reason            text NOT NULL,
  net_paisa         bigint NOT NULL CHECK (net_paisa >= 0),
  tax_paisa         bigint NOT NULL CHECK (tax_paisa >= 0),
  total_paisa       bigint NOT NULL CHECK (total_paisa = net_paisa + tax_paisa),
  refund_method_id  uuid REFERENCES payment_methods(id),
  shift_id          uuid NOT NULL REFERENCES shifts(id),
  approved_by       uuid NOT NULL REFERENCES users(id),
  created_by        uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  fiscal_status     text NOT NULL DEFAULT 'NOT_REQUIRED'
                    CHECK (fiscal_status IN ('NOT_REQUIRED','PENDING','SUBMITTED','FAILED')),
  fiscal_invoice_no text,
  UNIQUE (branch_id, business_day_id, cn_no)
);
CREATE TABLE credit_note_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_note_id uuid NOT NULL REFERENCES credit_notes(id),
  bill_line_id  uuid NOT NULL REFERENCES bill_lines(id),
  qty           numeric(12,3) NOT NULL CHECK (qty > 0),
  net_paisa     bigint NOT NULL,
  tax_paisa     bigint NOT NULL
);

-- ---------- Fiscal integration outbox ----------
CREATE TABLE fiscal_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id       uuid NOT NULL REFERENCES branches(id),
  doc_type        text NOT NULL CHECK (doc_type IN ('BILL','CREDIT_NOTE')),
  doc_id          uuid NOT NULL,
  provider        text NOT NULL CHECK (provider IN ('PRA','SRB','KPRA','BRA','FBR','NONE')),
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','IN_FLIGHT','DONE','FAILED')),
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  request         jsonb,
  response        jsonb,
  last_error      text,
  idempotency_key text NOT NULL UNIQUE,            -- = provider + doc_id; never double-report
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fiscal_jobs_due_idx ON fiscal_jobs(next_attempt_at) WHERE status IN ('PENDING','FAILED');

-- ---------- Khata (customer credit) — append-only ledger ----------
CREATE TABLE khata_accounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id          uuid NOT NULL REFERENCES branches(id),
  customer_id        uuid NOT NULL REFERENCES customers(id),
  credit_limit_paisa bigint NOT NULL DEFAULT 0 CHECK (credit_limit_paisa >= 0),
  is_active          boolean NOT NULL DEFAULT true,
  UNIQUE (branch_id, customer_id)
);
CREATE TABLE khata_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES khata_accounts(id),
  kind         text NOT NULL CHECK (kind IN ('CHARGE','PAYMENT','ADJUST')),
  amount_paisa bigint NOT NULL CHECK (amount_paisa > 0),   -- sign comes from kind (ADJUST uses note + counter-entry)
  bill_id      uuid REFERENCES bills(id),
  payment_id   uuid REFERENCES payments(id),
  note         text,
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------- Audit & sync outbox ----------
CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  branch_id  uuid REFERENCES branches(id),
  user_id    uuid REFERENCES users(id),
  device_id  uuid REFERENCES devices(id),
  action     text NOT NULL,                       -- BILL_DISCOUNT, KOT_VOID, REPRINT, SHIFT_REOPEN...
  entity     text NOT NULL,
  entity_id  uuid,
  before     jsonb,
  after      jsonb,
  reason     text,
  ip         inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_entity_idx ON audit_log(entity, entity_id);
CREATE INDEX audit_time_idx ON audit_log(created_at);

CREATE TABLE outbox_events (                       -- for cloud sync / webhooks (Phase 2+)
  id           bigserial PRIMARY KEY,
  branch_id    uuid NOT NULL REFERENCES branches(id),
  aggregate    text NOT NULL,
  aggregate_id uuid NOT NULL,
  type         text NOT NULL,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX outbox_unpublished_idx ON outbox_events(id) WHERE published_at IS NULL;

-- =====================================================================
-- IMMUTABILITY GUARDS
-- =====================================================================
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% not allowed)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER payments_immutable      BEFORE UPDATE OR DELETE ON payments      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER khata_entries_immutable BEFORE UPDATE OR DELETE ON khata_entries FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_log_immutable     BEFORE UPDATE OR DELETE ON audit_log     FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER credit_notes_no_delete  BEFORE DELETE ON credit_notes            FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER credit_note_lines_immut BEFORE UPDATE OR DELETE ON credit_note_lines FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Bills: never deleted; once SETTLED/VOID only fiscal + bookkeeping columns may change.
CREATE FUNCTION guard_bills() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  skip text[] := ARRAY['fiscal_status','fiscal_invoice_no','fiscal_qr','fiscal_submitted_at','print_count','updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bills cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('SETTLED','VOID') THEN
    IF (to_jsonb(NEW) - skip) IS DISTINCT FROM (to_jsonb(OLD) - skip) THEN
      RAISE EXCEPTION 'bill % is % and immutable (use a credit note)', OLD.id, OLD.status
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER bills_guard BEFORE UPDATE OR DELETE ON bills FOR EACH ROW EXECUTE FUNCTION guard_bills();

-- bill_lines frozen once the parent bill is SETTLED/VOID
CREATE FUNCTION guard_bill_lines() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b_status text; b_id uuid;
BEGIN
  b_id := COALESCE(NEW.bill_id, OLD.bill_id);
  SELECT status INTO b_status FROM bills WHERE id = b_id;
  IF b_status IN ('SETTLED','VOID') THEN
    RAISE EXCEPTION 'bill % is % — lines are frozen', b_id, b_status USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER bill_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON bill_lines
  FOR EACH ROW EXECUTE FUNCTION guard_bill_lines();

-- A bill's payments may never exceed its total (guards double-click / replay bugs)
CREATE FUNCTION guard_payment_total() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE paid bigint; tot bigint; st text;
BEGIN
  SELECT total_paisa, status INTO tot, st FROM bills WHERE id = NEW.bill_id;
  IF st NOT IN ('PRE_BILLED','SETTLED','DRAFT') THEN
    RAISE EXCEPTION 'cannot pay a % bill', st USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT COALESCE(SUM(amount_paisa),0) + NEW.amount_paisa INTO paid FROM payments WHERE bill_id = NEW.bill_id;
  IF paid > tot THEN
    RAISE EXCEPTION 'payments (%) exceed bill total (%)', paid, tot USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payments_total_guard BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION guard_payment_total();
