import type { Queryable } from '../../shared/tx';

export interface AuditEntry {
  branchId?: string | null;
  userId?: string | null;
  deviceId?: string | null;
  /** e.g. USER_CREATE, ROLE_PERMISSIONS_SET, LOGIN_FAILED, BILL_DISCOUNT */
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  ip?: string | null;
}

const SECRET_KEY = /(hash|password|pin|token|secret)/i;

/** Defensive: audit rows must never contain credentials, even if a caller passes a full row. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        // Booleans (e.g. has_pin, passwordChanged) cannot carry a secret and are useful to keep.
        SECRET_KEY.test(k) && typeof v !== 'boolean' && v !== null
          ? '[REDACTED]'
          : redactSecrets(v),
      ]),
    );
  }
  return value;
}

/**
 * Appends to audit_log. Pass the open transaction so the audit row commits atomically with the
 * change it describes (CLAUDE.md rules 6 and 7).
 */
export async function writeAudit(q: Queryable, e: AuditEntry): Promise<void> {
  await q
    .insertInto('audit_log')
    .values({
      branch_id: e.branchId ?? null,
      user_id: e.userId ?? null,
      device_id: e.deviceId ?? null,
      action: e.action,
      entity: e.entity,
      entity_id: e.entityId ?? null,
      before: e.before === undefined ? null : (redactSecrets(e.before) as never),
      after: e.after === undefined ? null : (redactSecrets(e.after) as never),
      reason: e.reason ?? null,
      ip: e.ip ?? null,
    })
    .execute();
}
