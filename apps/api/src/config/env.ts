import { z } from 'zod';

const secret = (name: string) => z.string().min(32, `${name} must be at least 32 characters`);

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(18080),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    /** The restaurant's database (single-restaurant mode), or unused in cloud mode. */
    DATABASE_URL: z.string().url().optional(),
    /** Run the print/outbox worker inside the API process (default: yes in development, no in production). */
    EMBEDDED_WORKER: z.enum(['true', 'false']).optional(),
    /** HS256 signing secret for access tokens. Generate with `openssl rand -base64 48`. */
    JWT_SECRET: secret('JWT_SECRET'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(15 * 60),
    REFRESH_TOKEN_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(12 * 60 * 60),

    // ───── cloud mode: many restaurants, each with its own database ─────
    /** Setting this switches the API to cloud mode (see docs/adr/0019-multi-restaurant-cloud.md). */
    CONTROL_DATABASE_URL: z.string().url().optional(),
    /** 32 bytes, base64: encrypts each restaurant's connection string. `openssl rand -base64 32` */
    TENANT_SECRET_KEY: z.string().optional(),
    /** Signs platform-admin tokens. Different from JWT_SECRET on purpose. */
    PLATFORM_JWT_SECRET: z.string().optional(),
    /** Where a new restaurant's database comes from. */
    PROVISIONER: z.enum(['neon', 'local']).optional(),
    NEON_API_KEY: z.string().optional(),
    NEON_REGION_ID: z.string().optional(),
    NEON_ORG_ID: z.string().optional(),
    NEON_PG_VERSION: z.coerce.number().int().min(14).max(18).optional(),
    /** `local` provisioner: a Postgres server that may CREATE DATABASE. */
    LOCAL_PROVISIONER_ADMIN_URL: z.string().url().optional(),
    /** Connections kept per restaurant on one API instance (serverless: keep it small). */
    TENANT_POOL_MAX: z.coerce.number().int().min(1).max(20).default(3),
    /** Restaurants kept warm per API instance; the least recently used are closed. */
    TENANT_CACHE_MAX: z.coerce.number().int().min(1).max(200).default(25),
    /** How many proxies sit in front of the API (Vercel: 1), so `req.ip` is the visitor, not the proxy. */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).optional(),
    /** `off`: no live stream (serverless has no memory shared between requests); screens poll instead. */
    LIVE_EVENTS: z.enum(['on', 'off']).optional(),
  })
  .superRefine((v, ctx) => {
    const cloud = !!v.CONTROL_DATABASE_URL;
    const need = (cond: unknown, path: string, message: string): void => {
      if (!cond) ctx.addIssue({ code: 'custom', path: [path], message });
    };
    if (!cloud) {
      need(
        v.DATABASE_URL,
        'DATABASE_URL',
        'DATABASE_URL is required (or set CONTROL_DATABASE_URL)',
      );
      return;
    }
    need(v.TENANT_SECRET_KEY, 'TENANT_SECRET_KEY', 'required in cloud mode');
    need(
      v.PLATFORM_JWT_SECRET && v.PLATFORM_JWT_SECRET.length >= 32,
      'PLATFORM_JWT_SECRET',
      'required in cloud mode (at least 32 characters)',
    );
    need(v.PROVISIONER, 'PROVISIONER', 'required in cloud mode: neon or local');
    if (v.PROVISIONER === 'neon') {
      need(v.NEON_API_KEY, 'NEON_API_KEY', 'required for the neon provisioner');
      need(
        v.NEON_REGION_ID,
        'NEON_REGION_ID',
        'required for the neon provisioner (e.g. aws-us-east-2)',
      );
    }
    if (v.PROVISIONER === 'local')
      need(
        v.LOCAL_PROVISIONER_ADMIN_URL,
        'LOCAL_PROVISIONER_ADMIN_URL',
        'required for the local provisioner',
      );
  });

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
  }
  return parsed.data;
}

export const isCloudMode = (env: Env): boolean => !!env.CONTROL_DATABASE_URL;
