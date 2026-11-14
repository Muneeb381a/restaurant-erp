import { paisaFromDb } from '@erp/domain';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { DB } from '../db/types';

const PG_INT8 = 20;

/**
 * Money columns are BIGINT paisa. node-postgres returns them as strings by default;
 * parse to a safe-integer number (throws if out of range). NUMERIC (qty) stays a string
 * on purpose — quantities are handled with integer math in packages/domain.
 * See docs/adr/0001-money-type.md.
 */
export function createPool(connectionString: string, max = 10): pg.Pool {
  // idle connections are given back quickly: a serverless database (Neon) suspends when none are open
  const pool = new pg.Pool({ connectionString, max, idleTimeoutMillis: 10_000 });
  // an idle client dropped by the server must not crash the process
  pool.on('error', () => undefined);
  return pool;
}

export function createDb(pool: pg.Pool): Kysely<DB> {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

// Global parser registration (idempotent) — applies to every pg client in this process.
pg.types.setTypeParser(PG_INT8, (value: string) => paisaFromDb(value));

// `date` columns (business_date, effective_from/to) stay 'YYYY-MM-DD' strings: a JS Date at local
// midnight would shift the day when the server timezone differs from the restaurant's.
const PG_DATE = 1082;
pg.types.setTypeParser(PG_DATE, (value: string) => value);
