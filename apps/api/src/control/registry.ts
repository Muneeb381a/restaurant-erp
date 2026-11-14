import type { Express } from 'express';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { Env } from '../config/env';
import { buildContext } from '../http/build-context';
import { createApp } from '../http/app';
import type { AppContext } from '../http/context';
import { AppError } from '../http/errors';
import { createSecretBox, tenantJwtSecret, type SecretBox } from './secret-box';
import type { ControlDB } from './types';

/** One restaurant, ready to serve: its database, its own token secret, its own copy of the API. */
export interface TenantRuntime {
  id: string;
  slug: string;
  name: string;
  ctx: AppContext;
  app: Express;
}

export interface RegistryDeps {
  control: Kysely<ControlDB>;
  box: SecretBox;
  env: Env;
  logger: Logger;
  /** Signs every restaurant's tokens (each gets its own derived secret). */
  masterJwtSecret: string;
  /** How long a "this restaurant is active" answer is trusted before the control database is asked again. */
  statusTtlMs?: number;
  now?: () => number;
  /** Tests build a cheaper context (fast password hashing, silent log). */
  makeContext?: (databaseUrl: string, jwtSecret: string) => AppContext;
}

interface Entry {
  runtime: TenantRuntime;
  checkedAt: number;
  url: string;
}

/**
 * Finds the restaurant behind a request and keeps a small number of them warm per API instance.
 * Every restaurant is the unchanged single-restaurant API pointed at its own database, so nothing
 * in the order, billing or khata code knows other restaurants exist.
 */
export class TenantRegistry {
  private readonly warm = new Map<string, Entry>(); // insertion order = least recently used first
  private readonly building = new Map<string, Promise<Entry>>();
  private readonly statusTtl: number;
  private readonly now: () => number;

  constructor(private readonly d: RegistryDeps) {
    this.statusTtl = d.statusTtlMs ?? 15_000;
    this.now = d.now ?? Date.now;
  }

  async get(rawSlug: string): Promise<TenantRuntime> {
    const slug = rawSlug.toLowerCase();
    const hit = this.warm.get(slug);
    if (hit && this.now() - hit.checkedAt < this.statusTtl) {
      this.touch(slug, hit);
      return hit.runtime;
    }
    const row = await this.d.control
      .selectFrom('tenants')
      .select(['id', 'slug', 'name', 'status', 'db_url_enc', 'suspended_reason'])
      .where('slug', '=', slug)
      .executeTakeFirst();
    if (!row) {
      await this.evict(slug);
      throw new AppError(404, 'TENANT_NOT_FOUND', 'No restaurant with that code');
    }
    if (row.status === 'SUSPENDED') {
      await this.evict(slug);
      throw new AppError(403, 'TENANT_SUSPENDED', 'This restaurant is switched off', {
        name: row.name,
        ...(row.suspended_reason ? { reason: row.suspended_reason } : {}),
      });
    }
    if (row.status === 'ARCHIVED') {
      await this.evict(slug);
      throw new AppError(404, 'TENANT_NOT_FOUND', 'No restaurant with that code');
    }
    if (row.status !== 'ACTIVE' || !row.db_url_enc) {
      await this.evict(slug);
      throw new AppError(503, 'TENANT_UNAVAILABLE', 'This restaurant is not ready yet');
    }
    const url = this.d.box.decrypt(row.db_url_enc);
    if (hit && hit.url === url) {
      hit.checkedAt = this.now();
      this.touch(slug, hit);
      return hit.runtime;
    }
    if (hit) await this.evict(slug); // its database moved
    let pending = this.building.get(slug);
    if (!pending) {
      pending = Promise.resolve().then(() => this.build(row, url));
      this.building.set(slug, pending);
    }
    try {
      const entry = await pending;
      this.warm.set(slug, entry);
      await this.trim();
      return entry.runtime;
    } finally {
      this.building.delete(slug);
    }
  }

  /** Forget a restaurant (suspended, archived, database moved) and close its connections. */
  async evict(slug: string): Promise<void> {
    const hit = this.warm.get(slug);
    if (!hit) return;
    this.warm.delete(slug);
    await hit.runtime.ctx.db.destroy().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.warm.keys()].map((s) => this.evict(s)));
  }

  warmCount(): number {
    return this.warm.size;
  }

  private touch(slug: string, e: Entry): void {
    this.warm.delete(slug);
    this.warm.set(slug, e);
  }

  private build(row: { id: string; slug: string; name: string }, url: string): Entry {
    const secret = tenantJwtSecret(this.d.masterJwtSecret, row.id);
    const ctx =
      this.d.makeContext?.(url, secret) ??
      buildContext(this.d.env, this.d.logger.child({ tenant: row.slug }), {
        databaseUrl: url,
        jwtSecret: secret,
        poolMax: this.d.env.TENANT_POOL_MAX,
      });
    return {
      runtime: {
        id: row.id,
        slug: row.slug,
        name: row.name,
        ctx,
        app: createApp(ctx, {
          liveEvents: this.d.env.LIVE_EVENTS !== 'off',
          trustProxyHops: this.d.env.TRUST_PROXY_HOPS ?? 1,
        }),
      },
      checkedAt: this.now(),
      url,
    };
  }

  private async trim(): Promise<void> {
    const max = this.d.env.TENANT_CACHE_MAX;
    while (this.warm.size > max) {
      const oldest = this.warm.keys().next().value as string;
      await this.evict(oldest);
    }
  }
}

export function createRegistry(
  deps: Omit<RegistryDeps, 'box'> & { tenantSecretKey: string },
): TenantRegistry {
  return new TenantRegistry({ ...deps, box: createSecretBox(deps.tenantSecretKey) });
}
