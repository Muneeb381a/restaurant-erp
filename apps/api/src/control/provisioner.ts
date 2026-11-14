import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { TenantProvider } from './types';

/** A database ready for a new restaurant: nothing in it yet (migrations come next). */
export interface ProvisionedDb {
  provider: TenantProvider;
  /** Neon project id, or the local database name: how to find it again. */
  providerRef: string;
  region: string | null;
  /** Connection the API uses on every request (Neon: the pooled endpoint). */
  url: string;
  /** Direct connection for migrations and maintenance (no pooler in between). */
  directUrl: string;
}

export interface Provisioner {
  readonly provider: TenantProvider;
  provision(slug: string): Promise<ProvisionedDb>;
}

export class ProvisionError extends Error {
  constructor(
    message: string,
    /** True when the request may still have created something (a timeout): look before retrying. */
    readonly mayHaveCreated = false,
  ) {
    super(message);
    this.name = 'ProvisionError';
  }
}

// ───────────────────────────────── Neon ─────────────────────────────────

export interface NeonOptions {
  apiKey: string;
  regionId: string;
  pgVersion?: number;
  /** Needed with a personal API key; an organisation key already knows its organisation. */
  orgId?: string;
  baseUrl?: string;
  /** Upper compute bound per restaurant (cost cap). */
  maxCu?: number;
  /** Compute is switched off after this many idle seconds (Neon's own default is 300). */
  suspendSeconds?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface NeonCreateResponse {
  project?: { id?: string };
  connection_uris?: {
    connection_parameters?: {
      database?: string;
      role?: string;
      password?: string;
      host?: string;
      pooler_host?: string;
    };
  }[];
}

const conn = (p: { role: string; password: string; host: string; database: string }): string =>
  `postgresql://${encodeURIComponent(p.role)}:${encodeURIComponent(p.password)}@${p.host}/${encodeURIComponent(p.database)}?sslmode=require`;

/**
 * One Neon *project* per restaurant, as Neon itself recommends for "a database per customer"
 * (https://neon.com/docs/guides/multitenancy). A project with no traffic scales to zero and costs
 * little more than its storage. Created through the Neon API; ready in a few seconds.
 */
export function createNeonProvisioner(o: NeonOptions): Provisioner {
  const doFetch = o.fetchImpl ?? fetch;
  const base = o.baseUrl ?? 'https://console.neon.tech/api/v2';
  return {
    provider: 'NEON',
    async provision(slug) {
      const body = {
        project: {
          name: `erp-${slug}`,
          region_id: o.regionId,
          pg_version: o.pgVersion ?? 17,
          ...(o.orgId ? { org_id: o.orgId } : {}),
          default_endpoint_settings: {
            autoscaling_limit_min_cu: 0.25,
            autoscaling_limit_max_cu: o.maxCu ?? 1,
            suspend_timeout_seconds: o.suspendSeconds ?? 300,
          },
        },
      };
      let res: Response;
      try {
        res = await doFetch(`${base}/projects`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${o.apiKey}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(o.timeoutMs ?? 60_000),
        });
      } catch {
        // POST is not idempotent: a timeout may still have created the project
        throw new ProvisionError('Could not reach Neon, or it took too long to answer', true);
      }
      if (!res.ok) {
        // 503 and 423 are safe to retry (Neon documents them so); any other refusal created nothing
        throw new ProvisionError(
          `Neon refused to create the project (HTTP ${res.status})`,
          res.status >= 500 && res.status !== 503,
        );
      }
      const data = (await res.json()) as NeonCreateResponse;
      const p = data.connection_uris?.[0]?.connection_parameters;
      const id = data.project?.id;
      if (!id || !p?.role || !p.password || !p.host || !p.database)
        throw new ProvisionError('Neon answered without a project id or connection details', true);
      return {
        provider: 'NEON',
        providerRef: id,
        region: o.regionId,
        directUrl: conn({ role: p.role, password: p.password, host: p.host, database: p.database }),
        url: conn({
          role: p.role,
          password: p.password,
          host: p.pooler_host ?? p.host,
          database: p.database,
        }),
      };
    },
  };
}

// ───────────────────────────────── local ─────────────────────────────────

/**
 * A new database on a Postgres server you already run (development, tests, or a self-hosted
 * multi-restaurant install). `adminUrl` must be allowed to CREATE DATABASE.
 */
export function createLocalProvisioner(adminUrl: string): Provisioner {
  return {
    provider: 'LOCAL',
    async provision(slug) {
      const name = `erp_${slug.replace(/-/g, '_')}_${randomBytes(3).toString('hex')}`;
      if (!/^[a-z0-9_]+$/.test(name)) throw new ProvisionError('Unsafe database name');
      const admin = new pg.Client({ connectionString: adminUrl });
      await admin.connect();
      try {
        await admin.query(`CREATE DATABASE "${name}"`);
      } finally {
        await admin.end();
      }
      const target = new URL(adminUrl);
      target.pathname = `/${name}`;
      const url = target.toString();
      return { provider: 'LOCAL', providerRef: name, region: null, url, directUrl: url };
    },
  };
}
