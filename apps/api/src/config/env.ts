import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(18080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().url(),
  /** HS256 signing secret for access tokens. Generate with `openssl rand -base64 48`. */
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
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
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
  }
  return parsed.data;
}
