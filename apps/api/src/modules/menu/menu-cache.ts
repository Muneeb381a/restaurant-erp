/**
 * In-process cache for the POS menu payload. The API is a single process, so a per-branch
 * revision counter bumped on every menu write is enough to invalidate it (no revision table).
 * Cached bodies are keyed by (branch, price list, business date); a date rollover therefore
 * naturally produces a new entry (and a new ETag).
 */
export interface CachedMenu {
  etag: string;
  body: string;
}

export class MenuCache {
  private readonly revisions = new Map<string, number>();
  private readonly entries = new Map<string, CachedMenu & { revision: number }>();

  revision(branchId: string): number {
    return this.revisions.get(branchId) ?? 0;
  }

  /** Call after ANY change that can alter the menu payload (items, prices, availability, …). */
  bump(branchId: string): void {
    this.revisions.set(branchId, this.revision(branchId) + 1);
  }

  get(branchId: string, key: string): CachedMenu | undefined {
    const hit = this.entries.get(`${branchId}|${key}`);
    return hit && hit.revision === this.revision(branchId) ? hit : undefined;
  }

  set(branchId: string, key: string, value: CachedMenu, revisionAtRead: number): void {
    this.entries.set(`${branchId}|${key}`, { ...value, revision: revisionAtRead });
  }
}
