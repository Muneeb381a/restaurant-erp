-- Up Migration
-- Kitchen display: a ticket moves NEW -> PREPARING -> READY -> DONE on screen, with timestamps so
-- the kitchen can see how long each ticket has waited and how long it took.
ALTER TABLE kots
  ADD COLUMN started_at timestamptz,
  ADD COLUMN ready_at   timestamptz,
  ADD COLUMN done_at    timestamptz;
CREATE INDEX kots_active_idx ON kots(branch_id, status) WHERE status IN ('NEW', 'PREPARING', 'READY');

INSERT INTO permissions(code, description) VALUES
  ('kitchen.view',   'See the kitchen board'),
  ('kitchen.update', 'Mark kitchen tickets preparing or ready'),
  ('kitchen.serve',  'Mark ready tickets as served');

-- OWNER and MANAGER: everything; KITCHEN: see and progress; waiters and cashiers: see and serve.
INSERT INTO role_permissions(role_id, permission_code)
SELECT r.id, p.code FROM roles r, permissions p
 WHERE r.code IN ('OWNER', 'MANAGER') AND p.code IN ('kitchen.view', 'kitchen.update', 'kitchen.serve');
INSERT INTO role_permissions(role_id, permission_code)
SELECT r.id, p.code FROM roles r, permissions p
 WHERE r.code = 'KITCHEN' AND p.code IN ('kitchen.view', 'kitchen.update');
INSERT INTO role_permissions(role_id, permission_code)
SELECT r.id, p.code FROM roles r, permissions p
 WHERE r.code IN ('CAPTAIN', 'CASHIER') AND p.code IN ('kitchen.view', 'kitchen.serve');
