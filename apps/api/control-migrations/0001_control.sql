-- Up Migration
-- CONTROL PLANE. One small database that knows which restaurants exist and where each one's own
-- database lives. It holds NO restaurant business data (no orders, bills, customers, menu): every
-- restaurant keeps those in its own database, so one restaurant can never see another's money.

CREATE TABLE platform_admins (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username       text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9._-]{3,40}$'),
  full_name      text NOT NULL,
  password_hash  text NOT NULL,                     -- argon2id
  is_active      boolean NOT NULL DEFAULT true,
  failed_attempts int NOT NULL DEFAULT 0,
  last_failed_at timestamptz,
  locked_until   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id     uuid NOT NULL REFERENCES platform_admins(id),
  refresh_hash text NOT NULL,                       -- rotating refresh token (hashed)
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenants (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- the restaurant code in the address: /r/<slug>
  slug              text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name              text NOT NULL,
  -- PROVISIONING: database being created | FAILED: it stopped half way (retry is safe)
  status            text NOT NULL DEFAULT 'PROVISIONING'
                    CHECK (status IN ('PROVISIONING','ACTIVE','SUSPENDED','ARCHIVED','FAILED')),
  plan              text NOT NULL DEFAULT 'STANDARD',
  provider          text NOT NULL CHECK (provider IN ('NEON','LOCAL')),
  provider_ref      text,                           -- Neon project id, or the local database name
  region            text,
  -- connection strings are encrypted (AES-256-GCM, key in TENANT_SECRET_KEY), never stored in clear
  db_url_enc        text,                           -- pooled: what the API uses per request
  db_direct_url_enc text,                           -- direct: migrations and maintenance
  owner_name        text NOT NULL,
  owner_username    text NOT NULL,
  contact_phone     text,
  notes             text,
  last_error        text,
  created_by        uuid REFERENCES platform_admins(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  activated_at      timestamptz,
  suspended_at      timestamptz,
  suspended_reason  text,
  archived_at       timestamptz
);
CREATE INDEX tenants_status_idx ON tenants(status);

-- Everything the platform admin does, append-only.
CREATE TABLE platform_audit_log (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  admin_id  uuid REFERENCES platform_admins(id),
  action    text NOT NULL,
  tenant_id uuid REFERENCES tenants(id),
  detail    jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip        text
);
CREATE INDEX platform_audit_tenant_idx ON platform_audit_log(tenant_id, at DESC);

CREATE FUNCTION control_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER platform_audit_log_immutable BEFORE UPDATE OR DELETE ON platform_audit_log
  FOR EACH ROW EXECUTE FUNCTION control_forbid_mutation();

-- A restaurant is never deleted: archiving keeps the row (and its financial history) intact.
CREATE TRIGGER tenants_no_delete BEFORE DELETE ON tenants
  FOR EACH ROW EXECUTE FUNCTION control_forbid_mutation();
