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
export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: 10 });
  return pool;
}

export function createDb(pool: pg.Pool): Kysely<DB> {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

// Global parser registration (idempotent) — applies to every pg client in this process.
pg.types.setTypeParser(PG_INT8, (value: string) => paisaFromDb(value));
