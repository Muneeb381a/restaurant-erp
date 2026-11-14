import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where the SQL migration folders are. From source it is apps/api; in the Vercel bundle the folders
 * are copied next to the function and `ERP_API_ROOT` points at them. Read at call time, not import time.
 */
const apiRoot = (): string => process.env.ERP_API_ROOT ?? path.resolve(here, '../..');

/**
 * `core`   = Phase 1 schema, applied everywhere.
 * `phase2` = inventory/recipes/purchasing (db/002). Separate directory AND separate
 *            tracking table, so it can be applied later without upsetting `core` ordering.
 * `control` = the control plane (cloud mode): which restaurants exist and where their databases are.
 */
export const MIGRATION_SETS = {
  get core() {
    return { dir: path.join(apiRoot(), 'migrations'), table: 'pgmigrations' };
  },
  get phase2() {
    return { dir: path.join(apiRoot(), 'migrations-phase2'), table: 'pgmigrations_phase2' };
  },
  get control() {
    return { dir: path.join(apiRoot(), 'control-migrations'), table: 'pgmigrations_control' };
  },
};

export type MigrationSet = keyof typeof MIGRATION_SETS;

/** Forward-only: there is deliberately no `down` support (CLAUDE.md definition of done). */
export async function migrateUp(
  databaseUrl: string,
  set: MigrationSet = 'core',
  /** Apply at most this many pending migrations (tests use it to simulate an older DB). */
  count: number = Infinity,
): Promise<string[]> {
  const { dir, table } = MIGRATION_SETS[set];
  const done = await runner({
    databaseUrl,
    dir,
    migrationsTable: table,
    direction: 'up',
    count,
    checkOrder: true,
    log: () => undefined,
  });
  return done.map((m) => m.name);
}
