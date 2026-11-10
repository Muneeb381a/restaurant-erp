-- =====================================================================
-- 003 DEV SEED — safe demo data. NOT for production as-is.
-- TAX RULES BELOW ARE PLACEHOLDERS: verified_by is NULL on purpose.
-- The app must refuse to enable fiscal/tax features until a CA/consultant fills verified_by.
-- =====================================================================
-- NOTE: permissions, roles and role_permissions are reference data and live in migration 0002_auth_rbac.sql.

INSERT INTO tax_categories(code, name) VALUES ('RESTAURANT_SERVICE','Restaurant / food service');

DO $$
DECLARE b uuid; tc uuid;
BEGIN
  INSERT INTO branches(code, name, tax_authority) VALUES ('MAIN','Demo Desi Restaurant','NONE') RETURNING id INTO b;
  SELECT id INTO tc FROM tax_categories WHERE code='RESTAURANT_SERVICE';

  INSERT INTO price_lists(branch_id, code, name) VALUES
    (b,'DINE_IN','Dine-in'),(b,'TAKEAWAY','Takeaway'),(b,'DELIVERY','Delivery');

  INSERT INTO payment_methods(branch_id, code, name, tender_class, opens_drawer, needs_reference) VALUES
    (b,'CASH','Cash','CASH_OTHER',true,false),
    (b,'CARD','Debit/Credit Card','DIGITAL',false,true),
    (b,'JAZZCASH','JazzCash','DIGITAL',false,true),
    (b,'EASYPAISA','Easypaisa','DIGITAL',false,true),
    (b,'RAAST_QR','Raast / Bank QR','DIGITAL',false,true),
    (b,'KHATA','Customer Khata (credit)','CASH_OTHER',false,false);

  INSERT INTO stations(branch_id, code, name) VALUES
    (b,'BBQ','BBQ'),(b,'TANDOOR','Tandoor'),(b,'KARAHI','Karahi / Handi'),(b,'FRY','Fry'),(b,'DRINKS','Drinks');

  INSERT INTO settings(branch_id, key, value) VALUES
    (b,'tax.service_charge_taxable','true'),
    (b,'tax.mixed_tender_policy','"HIGHEST_RATE_IF_ANY_NON_DIGITAL"'),
    (b,'billing.round_to_rupee','true'),
    (b,'billing.service_charge_bps','0'),
    (b,'kot.print_on_send','true');

  -- PLACEHOLDER tax rules. Confirm with a CA before use.
  INSERT INTO tax_rules(authority, tax_category_id, payment_class, rate_bps, effective_from, source_note) VALUES
    ('PRA', tc, 'CASH_OTHER', 1600, '2026-07-01', 'Punjab Finance Act 2026 — restaurants, non-digital (VERIFY)'),
    ('PRA', tc, 'DIGITAL',     800, '2026-07-01', 'Punjab Finance Act 2026 — card/wallet/QR, no input adjustment (VERIFY)'),
    ('SRB', tc, 'CASH_OTHER', 1500, '2025-07-01', 'Sindh standard rate (VERIFY)'),
    ('SRB', tc, 'DIGITAL',     800, '2025-07-01', 'Sindh reduced digital rate (VERIFY)');
END $$;
