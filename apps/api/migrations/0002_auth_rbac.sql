-- Up Migration
-- M1: auth lockout columns + RBAC reference data (permissions, roles, role mapping).
-- Reference data lives in a migration (not the dev seed) because production needs it too.
-- Convention: any migration that adds a permission must also grant it to the roles that need it
-- (including OWNER).

-- ---------- PIN / password lockout (architecture §12: 5 tries / 10 min) ----------
ALTER TABLE users
  ADD COLUMN failed_attempts int NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  ADD COLUMN last_failed_at  timestamptz,
  ADD COLUMN locked_until    timestamptz;

CREATE UNIQUE INDEX devices_token_hash_uq ON devices(token_hash);
CREATE UNIQUE INDEX sessions_refresh_hash_uq ON sessions(refresh_hash);
CREATE INDEX sessions_user_idx ON sessions(user_id);

-- ---------- Permissions ----------
INSERT INTO permissions(code, description) VALUES
 ('order.create','Create/modify orders'),
 ('order.transfer','Transfer / merge / split tables'),
 ('order.cancel','Cancel a whole order'),
 ('kot.void','Void items after KOT sent'),
 ('kot.reprint','Reprint KOT'),
 ('bill.create','Create/pre-bill'),
 ('bill.discount','Give discount (up to own limit)'),
 ('bill.discount.unlimited','Discount above own limit / approve discounts'),
 ('bill.settle','Take payment and settle'),
 ('bill.reprint','Reprint bill'),
 ('bill.refund','Create credit note / refund'),
 ('bill.void','Void an unsettled bill'),
 ('price.override','Override an item price on an order'),
 ('shift.open','Open shift'),
 ('shift.close','Close shift'),
 ('shift.reopen','Reopen closed shift'),
 ('day.close','Close business day'),
 ('cash.paid_out','Paid-out / cash drop'),
 ('drawer.open','Open cash drawer without a sale (no-sale)'),
 ('menu.manage','Edit menu, prices, deals'),
 ('menu.availability','Toggle item availability (86)'),
 ('tax.manage','Edit tax rules and tax settings'),
 ('user.manage','Manage users and roles'),
 ('report.view','View reports'),
 ('report.financial','View financial / tax reports'),
 ('audit.view','View the audit log'),
 ('stock.manage','Purchases, wastage, stocktake'),
 ('settings.manage','Branch settings, printers, floor, payment methods, price lists'),
 ('device.manage','Register and revoke devices');

-- ---------- Roles ----------
INSERT INTO roles(code, name) VALUES
 ('OWNER','Owner'),('MANAGER','Manager'),('CASHIER','Cashier'),
 ('CAPTAIN','Captain / Waiter'),('KITCHEN','Kitchen'),('STORE','Store keeper'),('ACCOUNTANT','Accountant');

-- OWNER: everything
INSERT INTO role_permissions(role_id, permission_code)
SELECT r.id, p.code FROM roles r, permissions p WHERE r.code = 'OWNER';

-- MANAGER: everything except user / tax / settings / device management
INSERT INTO role_permissions(role_id, permission_code)
SELECT r.id, p.code FROM roles r, permissions p
 WHERE r.code = 'MANAGER' AND p.code NOT IN ('user.manage','tax.manage','settings.manage','device.manage');

INSERT INTO role_permissions(role_id, permission_code)
SELECT r.id, p.code FROM roles r, permissions p
 WHERE r.code = 'CASHIER' AND p.code IN ('order.create','order.transfer','kot.reprint','bill.create','bill.discount',
   'bill.settle','bill.reprint','shift.open','shift.close','cash.paid_out','drawer.open','menu.availability','report.view');

INSERT INTO role_permissions(role_id, permission_code)
SELECT r.id, p.code FROM roles r, permissions p
 WHERE r.code = 'CAPTAIN' AND p.code IN ('order.create','order.transfer','kot.reprint','bill.create');

INSERT INTO role_permissions(role_id, permission_code)
SELECT r.id, p.code FROM roles r, permissions p
 WHERE r.code = 'KITCHEN' AND p.code IN ('menu.availability');

INSERT INTO role_permissions(role_id, permission_code)
SELECT r.id, p.code FROM roles r, permissions p
 WHERE r.code = 'STORE' AND p.code IN ('stock.manage','report.view');

INSERT INTO role_permissions(role_id, permission_code)
SELECT r.id, p.code FROM roles r, permissions p
 WHERE r.code = 'ACCOUNTANT' AND p.code IN ('report.view','report.financial','audit.view');
