import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../db/types';

/** Anything that can run queries: the pool-backed Kysely or an open transaction. */
export type Queryable = Kysely<DB> | Transaction<DB>;

/** One DB transaction per command (CLAUDE.md rule 6). */
export function withTx<T>(db: Kysely<DB>, fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
  return db.transaction().execute(fn);
}
