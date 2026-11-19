-- Up Migration
-- HR, milestone 1: the people who work here, and whether they came. (Leave, holidays' pay rules and payroll
-- come in later migrations and build on these tables.)
--
-- An EMPLOYEE is not the same as a USER: a cook, a helper or a delivery rider may never sign in. An employee
-- can be linked to a user account (a cashier who is also on the payroll), and nothing else depends on that link.
-- Employees are never deleted: a person who leaves gets status LEFT and a left_date; their history stays.

-- ---------- permissions ----------
INSERT INTO permissions(code, description) VALUES
 ('employee.view','See the staff list and their details'),
 ('employee.manage','Add and change staff, their pay terms and their clock-in PIN'),
 ('attendance.view','See attendance (who came, late, overtime)'),
 ('attendance.mark','Mark and correct attendance for any day'),
 ('attendance.clock','Run the clock-in / clock-out screen (staff enter their own PIN)');
INSERT INTO role_permissions(role_id, permission_code)
SELECT r.id, p.code FROM roles r
CROSS JOIN (VALUES ('employee.view'),('employee.manage'),('attendance.view'),('attendance.mark'),('attendance.clock')) AS p(code)
WHERE r.code IN ('OWNER','MANAGER');
INSERT INTO role_permissions(role_id, permission_code)
SELECT r.id, p.code FROM roles r
CROSS JOIN (VALUES ('employee.view'),('attendance.view')) AS p(code)
WHERE r.code = 'ACCOUNTANT';
INSERT INTO role_permissions(role_id, permission_code)
SELECT r.id, 'attendance.clock' FROM roles r WHERE r.code = 'CASHIER';

-- ---------- employees ----------
CREATE TABLE employees (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id        uuid NOT NULL REFERENCES branches(id),
  code             text NOT NULL CHECK (code ~ '^[A-Za-z0-9._-]{1,20}$'),   -- the staff number
  full_name        text NOT NULL CHECK (length(btrim(full_name)) > 0),
  full_name_ur     text,
  phone            text,
  cnic             text,                                  -- personal data: shown only to employee.view
  address          text,
  emergency_contact text,
  designation      text NOT NULL DEFAULT '',
  department       text NOT NULL DEFAULT 'OTHER'
                   CHECK (department IN ('KITCHEN','FLOOR','COUNTER','DELIVERY','STORE','ADMIN','OTHER')),
  join_date        date NOT NULL,
  left_date        date,
  status           text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ON_NOTICE','LEFT')),
  -- how they are paid (used by payroll): monthly salary, a daily wage or an hourly rate
  pay_type         text NOT NULL DEFAULT 'MONTHLY' CHECK (pay_type IN ('MONTHLY','DAILY','HOURLY')),
  base_pay_paisa   bigint NOT NULL DEFAULT 0 CHECK (base_pay_paisa >= 0),   -- per month, per day or per hour
  pay_frequency    text NOT NULL DEFAULT 'MONTHLY' CHECK (pay_frequency IN ('MONTHLY','WEEKLY','DAILY')),
  weekly_off       smallint[] NOT NULL DEFAULT '{}',      -- 0 = Sunday … 6 = Saturday
  shift_start      time,                                  -- their usual hours: what "late" and "overtime" are measured against
  shift_end        time,
  payout_method    text CHECK (payout_method IN ('CASH','JAZZCASH','EASYPAISA','BANK')),
  payout_account   text,
  user_id          uuid UNIQUE REFERENCES users(id),      -- optional: the same person's sign-in
  pin_hash         text,                                  -- argon2id of the clock-in PIN
  pin_failed       int NOT NULL DEFAULT 0,
  pin_locked_until timestamptz,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, code),
  CHECK (left_date IS NULL OR left_date >= join_date),
  CHECK (status <> 'LEFT' OR left_date IS NOT NULL),
  CHECK ((shift_start IS NULL) = (shift_end IS NULL)),
  CHECK (weekly_off <@ ARRAY[0,1,2,3,4,5,6]::smallint[])
);
CREATE INDEX employees_branch_status_idx ON employees(branch_id, status);

-- ---------- attendance: one row per person per day ----------
CREATE TABLE attendance (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id        uuid NOT NULL REFERENCES branches(id),
  employee_id      uuid NOT NULL REFERENCES employees(id),
  work_date        date NOT NULL,                         -- the business day it belongs to (a night shift belongs to the day it started)
  status           text NOT NULL CHECK (status IN ('PRESENT','ABSENT','HALF_DAY','LEAVE','WEEKLY_OFF','HOLIDAY')),
  clock_in         timestamptz,
  clock_out        timestamptz,
  worked_minutes   int CHECK (worked_minutes IS NULL OR worked_minutes >= 0),
  late_minutes     int NOT NULL DEFAULT 0 CHECK (late_minutes >= 0),
  overtime_minutes int NOT NULL DEFAULT 0 CHECK (overtime_minutes >= 0),
  source           text NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL','KIOSK')),
  note             text,
  marked_by        uuid REFERENCES users(id),             -- NULL when the person clocked in themselves
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, work_date),
  CHECK (clock_out IS NULL OR clock_in IS NULL OR clock_out >= clock_in)
);
CREATE INDEX attendance_branch_date_idx ON attendance(branch_id, work_date);

-- an attendance row and its employee belong to the same branch
CREATE FUNCTION guard_attendance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE emp_branch uuid;
BEGIN
  SELECT branch_id INTO emp_branch FROM employees WHERE id = NEW.employee_id;
  IF emp_branch IS DISTINCT FROM NEW.branch_id THEN
    RAISE EXCEPTION 'employee % does not belong to branch %', NEW.employee_id, NEW.branch_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attendance_guard BEFORE INSERT OR UPDATE ON attendance
  FOR EACH ROW EXECUTE FUNCTION guard_attendance();

-- ---------- public and restaurant holidays ----------
CREATE TABLE holidays (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id    uuid NOT NULL REFERENCES branches(id),
  holiday_date date NOT NULL,
  name         text NOT NULL CHECK (length(btrim(name)) > 0),
  UNIQUE (branch_id, holiday_date)
);
