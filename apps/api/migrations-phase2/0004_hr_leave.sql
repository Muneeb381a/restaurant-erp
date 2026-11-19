-- Up Migration
-- HR, milestone 2: leave. Entitlements are a LEGAL matter (see docs/OPEN-QUESTIONS.md #46), so no number is
-- built in: a leave type has an optional yearly allowance that the owner types, and NULL means "no limit is
-- tracked". All leave is counted in HALF-DAY units (a day = 2) so nothing needs fractions.

INSERT INTO permissions(code, description) VALUES
 ('leave.view','See leave types, balances and requests'),
 ('leave.manage','Enter, approve, reject and cancel leave; set leave types and give or correct balances');
INSERT INTO role_permissions(role_id, permission_code)
SELECT r.id, p.code FROM roles r
CROSS JOIN (VALUES ('leave.view'),('leave.manage')) AS p(code)
WHERE r.code IN ('OWNER','MANAGER');
INSERT INTO role_permissions(role_id, permission_code)
SELECT r.id, 'leave.view' FROM roles r WHERE r.code = 'ACCOUNTANT';

CREATE TABLE leave_types (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id           uuid NOT NULL REFERENCES branches(id),
  code                text NOT NULL CHECK (code ~ '^[A-Z0-9_]{1,20}$'),
  name                text NOT NULL CHECK (length(btrim(name)) > 0),
  name_ur             text,
  paid                boolean NOT NULL DEFAULT true,       -- payroll deducts nothing for paid leave
  allowance_half_days int CHECK (allowance_half_days IS NULL OR allowance_half_days >= 0),  -- per calendar year; NULL = not limited
  allow_negative      boolean NOT NULL DEFAULT false,      -- may a balance go below zero (an advance on next year's leave)?
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, code)
);

CREATE TABLE leave_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id       uuid NOT NULL REFERENCES branches(id),
  employee_id     uuid NOT NULL REFERENCES employees(id),
  leave_type_id   uuid NOT NULL REFERENCES leave_types(id),
  from_date       date NOT NULL,
  to_date         date NOT NULL,
  is_half_day     boolean NOT NULL DEFAULT false,
  half_days       int NOT NULL CHECK (half_days > 0),     -- working days it uses, in half-day units, fixed when requested
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
  reason          text,
  requested_by    uuid REFERENCES users(id),
  decided_by      uuid REFERENCES users(id),
  decided_at      timestamptz,
  decision_note   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (to_date >= from_date),
  CHECK (NOT is_half_day OR (from_date = to_date AND half_days = 1)),
  CHECK (status = 'PENDING' OR decided_at IS NOT NULL)
);
CREATE INDEX leave_requests_employee_idx ON leave_requests(employee_id, from_date);
CREATE INDEX leave_requests_branch_status_idx ON leave_requests(branch_id, status);

-- the days of an approved leave are written into attendance as LEAVE and point back at the request,
-- so cancelling the leave can take exactly those days away again
ALTER TABLE attendance ADD COLUMN leave_request_id uuid REFERENCES leave_requests(id);
CREATE INDEX attendance_leave_request_idx ON attendance(leave_request_id) WHERE leave_request_id IS NOT NULL;

-- Opening balances and corrections. Append-only: a mistake is fixed by another row.
CREATE TABLE leave_adjustments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id      uuid NOT NULL REFERENCES branches(id),
  employee_id    uuid NOT NULL REFERENCES employees(id),
  leave_type_id  uuid NOT NULL REFERENCES leave_types(id),
  year           int NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  half_days      int NOT NULL CHECK (half_days <> 0),
  reason         text NOT NULL CHECK (length(btrim(reason)) > 0),
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leave_adjustments_employee_idx ON leave_adjustments(employee_id, year);
CREATE TRIGGER leave_adjustments_immutable BEFORE UPDATE OR DELETE ON leave_adjustments
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
