-- =====================================================================
-- 003 DEV SEED — safe demo data. NOT for production as-is.
-- TAX RULES BELOW ARE PLACEHOLDERS: verified_by is NULL on purpose.
-- The app must refuse to enable fiscal/tax features until a CA/consultant fills verified_by.
-- =====================================================================
INSERT INTO permissions(code, description) VALUES
 ('order.create','Create/modify orders'),
 ('order.transfer','Transfer / merge / split tables'),
 ('kot.void','Void items after KOT sent'),
 ('kot.reprint','Reprint KOT'),
 ('bill.create','Create/pre-bill'),
 ('bill.discount','Give discount (up to own limit)'),
 ('bill.discount.unlimited','Discount above own limit / approve discounts'),
 ('bill.settle','Take payment and settle'),
 ('bill.reprint','Reprint bill'),
 ('bill.refund','Create credit note / refund'),
 ('shift.open','Open shift'),
 ('shift.close','Close shift'),
 ('shift.reopen','Reopen closed shift'),
 ('day.close','Close business day'),
 ('cash.paid_out','Paid-out / cash drop'),
 ('menu.manage','Edit menu, prices, deals'),
 ('tax.manage','Edit tax rules'),
 ('user.manage','Manage users and roles'),
 ('report.view','View reports'),
 ('report.financial','View financial / tax reports'),
 ('stock.manage','Purchases, wastage, stocktake'),
 ('settings.manage','Branch settings, printers, devices');

INSERT INTO roles(code, name) VALUES
 ('OWNER','Owner'),('MANAGER','Manager'),('CASHIER','Cashier'),
 ('CAPTAIN','Captain / Waiter'),('KITCHEN','Kitchen'),('STORE','Store keeper'),('ACCOUNTANT','Accountant');

-- OWNER: everything
INSERT INTO role_permissions SELECT r.id, p.code FROM roles r, permissions p WHERE r.code='OWNER';
-- MANAGER: everything except user/tax/settings management
INSERT INTO role_permissions SELECT r.id, p.code FROM roles r, permissions p
 WHERE r.code='MANAGER' AND p.code NOT IN ('user.manage','tax.manage','settings.manage');
INSERT INTO role_permissions SELECT r.id, p.code FROM roles r, permissions p
 WHERE r.code='CASHIER' AND p.code IN ('order.create','order.transfer','kot.reprint','bill.create','bill.discount',
   'bill.settle','bill.reprint','shift.open','shift.close','cash.paid_out','report.view');
INSERT INTO role_permissions SELECT r.id, p.code FROM roles r, permissions p
 WHERE r.code='CAPTAIN' AND p.code IN ('order.create','order.transfer','kot.reprint','bill.create');
INSERT INTO role_permissions SELECT r.id, p.code FROM roles r, permissions p
 WHERE r.code='STORE' AND p.code IN ('stock.manage','report.view');
INSERT INTO role_permissions SELECT r.id, p.code FROM roles r, permissions p
 WHERE r.code='ACCOUNTANT' AND p.code IN ('report.view','report.financial');

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
