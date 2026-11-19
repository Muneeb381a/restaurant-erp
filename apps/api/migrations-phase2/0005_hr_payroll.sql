-- Up Migration
-- HR, milestone 3: payroll. A pay RUN covers one period (a month, a week or a day) and holds one PAYSLIP per
-- person. A run is a DRAFT (recalculated freely, manual lines allowed) until it is APPROVED; after that nothing
-- in it can change (a correction is a manual line in the next run) and the attendance of that period is locked.
-- Money paid goes through the existing expenses ledger (category SALARY), once per payment (append-only).
-- No legal rate is built in: every rate is a branch setting the owner types (docs/OPEN-QUESTIONS.md #46).

INSERT INTO permissions(code, description) VALUES
 ('payroll.view','See pay runs and payslips'),
 ('payroll.manage','Prepare pay runs: calculate, add manual lines, cancel a draft'),
 ('payroll.approve','Approve a pay run (locks it and its attendance)'),
 ('payroll.pay','Record salary payments');
INSERT INTO role_permissions(role_id, permission_code)
SELECT r.id, p.code FROM roles r
CROSS JOIN (VALUES ('payroll.view'),('payroll.manage'),('payroll.approve'),('payroll.pay')) AS p(code)
WHERE r.code = 'OWNER';
INSERT INTO role_permissions(role_id, permission_code)
SELECT r.id, p.code FROM roles r
CROSS JOIN (VALUES ('payroll.view'),('payroll.manage')) AS p(code)
WHERE r.code = 'MANAGER';
INSERT INTO role_permissions(role_id, permission_code)
SELECT r.id, p.code FROM roles r
CROSS JOIN (VALUES ('payroll.view'),('payroll.manage'),('payroll.pay')) AS p(code)
WHERE r.code = 'ACCOUNTANT';

-- recurring allowances and deductions of one person, applied once in each of their pay runs
CREATE TABLE employee_pay_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id    uuid NOT NULL REFERENCES branches(id),
  employee_id  uuid NOT NULL REFERENCES employees(id),
  kind         text NOT NULL CHECK (kind IN ('ALLOWANCE','DEDUCTION')),
  name         text NOT NULL CHECK (length(btrim(name)) > 0),
  amount_paisa bigint NOT NULL CHECK (amount_paisa > 0),
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX employee_pay_items_employee_idx ON employee_pay_items(employee_id);

CREATE TABLE payroll_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id    uuid NOT NULL REFERENCES branches(id),
  run_no       int NOT NULL,
  frequency    text NOT NULL CHECK (frequency IN ('MONTHLY','WEEKLY','DAILY')),
  period_from  date NOT NULL,
  period_to    date NOT NULL,
  status       text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','CANCELLED')),
  note         text,
  created_by   uuid REFERENCES users(id),
  approved_by  uuid REFERENCES users(id),
  approved_at  timestamptz,
  cancel_reason text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, run_no),
  CHECK (period_to >= period_from),
  CHECK (status <> 'APPROVED' OR approved_at IS NOT NULL)
);
-- one live run per period and frequency
CREATE UNIQUE INDEX payroll_runs_period_uq ON payroll_runs(branch_id, frequency, period_from, period_to)
  WHERE status <> 'CANCELLED';

CREATE TABLE payslips (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id        uuid NOT NULL REFERENCES branches(id),
  run_id           uuid NOT NULL REFERENCES payroll_runs(id),
  employee_id      uuid NOT NULL REFERENCES employees(id),
  pay_type         text NOT NULL CHECK (pay_type IN ('MONTHLY','DAILY','HOURLY')),
  rate_paisa       bigint NOT NULL CHECK (rate_paisa >= 0),       -- the rate used, frozen at calculation
  tally            jsonb NOT NULL,                                  -- the day counts (half-days) behind the pay
  worked_minutes   int NOT NULL DEFAULT 0,
  late_count       int NOT NULL DEFAULT 0,
  late_minutes     int NOT NULL DEFAULT 0,
  overtime_minutes int NOT NULL DEFAULT 0,
  warnings         text[] NOT NULL DEFAULT '{}',
  gross_paisa      bigint NOT NULL DEFAULT 0 CHECK (gross_paisa >= 0),
  deductions_paisa bigint NOT NULL DEFAULT 0 CHECK (deductions_paisa >= 0),
  net_paisa        bigint NOT NULL DEFAULT 0,                       -- may be negative in a draft; approval refuses that
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, employee_id)
);
CREATE INDEX payslips_employee_idx ON payslips(employee_id);

CREATE TABLE payslip_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payslip_id   uuid NOT NULL REFERENCES payslips(id),
  kind         text NOT NULL CHECK (kind IN ('EARNING','DEDUCTION')),
  code         text NOT NULL,
  label        text NOT NULL,
  detail       text,
  amount_paisa bigint NOT NULL CHECK (amount_paisa >= 0),
  source       text NOT NULL CHECK (source IN ('COMPUTED','ITEM','MANUAL')),
  sort_no      int NOT NULL DEFAULT 0,
  created_by   uuid REFERENCES users(id)
);
CREATE INDEX payslip_lines_slip_idx ON payslip_lines(payslip_id);

-- ---------- immutability ----------
-- a run may only go DRAFT -> APPROVED or DRAFT -> CANCELLED; never deleted, never edited afterwards
CREATE FUNCTION guard_payroll_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payroll_runs are never deleted (cancel a draft instead)' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'payroll run % is % and can no longer change', OLD.id, OLD.status USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payroll_runs_guard BEFORE UPDATE OR DELETE ON payroll_runs
  FOR EACH ROW EXECUTE FUNCTION guard_payroll_run();

-- payslips and their lines of an approved (or cancelled) run are frozen
CREATE FUNCTION guard_payslip_tables() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE slip_id uuid; run_status text;
BEGIN
  IF TG_TABLE_NAME = 'payslips' THEN
    SELECT status INTO run_status FROM payroll_runs WHERE id = COALESCE(NEW.run_id, OLD.run_id);
  ELSE
    slip_id := COALESCE(NEW.payslip_id, OLD.payslip_id);
    SELECT r.status INTO run_status FROM payslips s JOIN payroll_runs r ON r.id = s.run_id WHERE s.id = slip_id;
  END IF;
  IF run_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION '% of a % pay run cannot change', TG_TABLE_NAME, run_status USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER payslips_guard BEFORE INSERT OR UPDATE OR DELETE ON payslips
  FOR EACH ROW EXECUTE FUNCTION guard_payslip_tables();
CREATE TRIGGER payslip_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON payslip_lines
  FOR EACH ROW EXECUTE FUNCTION guard_payslip_tables();

-- ---------- salary payments: append-only, through the expenses ledger ----------
CREATE TABLE payroll_payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id       uuid NOT NULL REFERENCES branches(id),
  payslip_id      uuid NOT NULL REFERENCES payslips(id),
  amount_paisa    bigint NOT NULL CHECK (amount_paisa > 0),
  paid_from       text NOT NULL CHECK (paid_from IN ('DRAWER_CASH','OWNER_CASH','BANK')),
  expense_id      uuid NOT NULL UNIQUE REFERENCES expenses(id),
  note            text,
  paid_by         uuid NOT NULL REFERENCES users(id),
  idempotency_key text NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payroll_payments_slip_idx ON payroll_payments(payslip_id);
CREATE TRIGGER payroll_payments_immutable BEFORE UPDATE OR DELETE ON payroll_payments
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- a payment needs an approved run and can never take the total paid above the net pay
CREATE FUNCTION guard_payroll_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run_status text; net bigint; paid bigint;
BEGIN
  SELECT r.status, s.net_paisa INTO run_status, net
    FROM payslips s JOIN payroll_runs r ON r.id = s.run_id WHERE s.id = NEW.payslip_id;
  IF run_status IS DISTINCT FROM 'APPROVED' THEN
    RAISE EXCEPTION 'a payslip can only be paid once its run is approved' USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(sum(amount_paisa), 0) INTO paid FROM payroll_payments WHERE payslip_id = NEW.payslip_id;
  IF paid + NEW.amount_paisa > net THEN
    RAISE EXCEPTION 'payments (%) would exceed the net pay (%)', paid + NEW.amount_paisa, net USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payroll_payments_guard BEFORE INSERT ON payroll_payments
  FOR EACH ROW EXECUTE FUNCTION guard_payroll_payment();
