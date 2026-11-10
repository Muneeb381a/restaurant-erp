import type { Kysely } from 'kysely';
import type { DB } from '../../db/types';
import type { Clock } from '../../shared/clock';

/**
 * role_permissions cache (architecture §9). Short TTL + explicit invalidation when a role's
 * permissions are edited, so a revoked permission takes effect within seconds at worst.
 */
export class PermissionCache {
  private readonly entries = new Map<string, { perms: Set<string>; expires: number }>();

  constructor(
    private readonly db: Kysely<DB>,
    private readonly clock: Clock,
    private readonly ttlMs = 30_000,
  ) {}

  async get(roleId: string): Promise<Set<string>> {
    const now = this.clock.now().getTime();
    const hit = this.entries.get(roleId);
    if (hit && hit.expires > now) return hit.perms;
    const rows = await this.db
      .selectFrom('role_permissions')
      .select('permission_code')
      .where('role_id', '=', roleId)
      .execute();
    const perms = new Set(rows.map((r) => r.permission_code));
    this.entries.set(roleId, { perms, expires: now + this.ttlMs });
    return perms;
  }

  invalidate(roleId?: string): void {
    if (roleId) this.entries.delete(roleId);
    else this.entries.clear();
  }
}
