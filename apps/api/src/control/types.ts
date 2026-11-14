import type { ColumnType, Generated } from 'kysely';

/** Hand-written types for the control plane (small, so no codegen). */
type Created = ColumnType<Date, Date | string | undefined, never>;
type Nullable<T> = ColumnType<T | null, T | null | undefined, T | null>;

export type TenantStatus = 'PROVISIONING' | 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED' | 'FAILED';
export type TenantProvider = 'NEON' | 'LOCAL';

export interface PlatformAdminsTable {
  id: Generated<string>;
  username: string;
  full_name: string;
  password_hash: string;
  is_active: Generated<boolean>;
  failed_attempts: Generated<number>;
  last_failed_at: Nullable<Date>;
  locked_until: Nullable<Date>;
  created_at: Created;
}

export interface PlatformSessionsTable {
  id: Generated<string>;
  admin_id: string;
  refresh_hash: string;
  expires_at: Date;
  revoked_at: Nullable<Date>;
  created_at: Created;
}

export interface TenantsTable {
  id: Generated<string>;
  slug: string;
  name: string;
  status: Generated<TenantStatus>;
  plan: Generated<string>;
  provider: TenantProvider;
  provider_ref: Nullable<string>;
  region: Nullable<string>;
  db_url_enc: Nullable<string>;
  db_direct_url_enc: Nullable<string>;
  owner_name: string;
  owner_username: string;
  contact_phone: Nullable<string>;
  notes: Nullable<string>;
  last_error: Nullable<string>;
  created_by: Nullable<string>;
  created_at: Created;
  activated_at: Nullable<Date>;
  suspended_at: Nullable<Date>;
  suspended_reason: Nullable<string>;
  archived_at: Nullable<Date>;
}

export interface PlatformAuditLogTable {
  id: Generated<string>;
  at: Created;
  admin_id: Nullable<string>;
  action: string;
  tenant_id: Nullable<string>;
  detail: Generated<unknown>;
  ip: Nullable<string>;
}

export interface ControlDB {
  platform_admins: PlatformAdminsTable;
  platform_sessions: PlatformSessionsTable;
  tenants: TenantsTable;
  platform_audit_log: PlatformAuditLogTable;
}
