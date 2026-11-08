import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, '../..');

/**
 * `core`   = Phase 1 schema, applied everywhere.
 * `phase2` = inventory/recipes/purchasing (db/002). Separate directory AND separate
 *            tracking table, so it can be applied later without upsetting `core` ordering.
 */
export const MIGRATION_SETS = {
  core: { dir: path.join(apiRoot, 'migrations'), table: 'pgmigrations' },
  phase2: { dir: path.join(apiRoot, 'migrations-phase2'), table: 'pgmigrations_phase2' },
} as const;

export type MigrationSet = keyof typeof MIGRATION_SETS;

/** Forward-only: there is deliberately no `down` support (CLAUDE.md definition of done). */
export async function migrateUp(databaseUrl: string, set: MigrationSet = 'core'): Promise<string[]> {
  const { dir, table } = MIGRATION_SETS[set];
  const done = await runner({
    databaseUrl,
    dir,
    migrationsTable: table,
    direction: 'up',
    count: Infinity,
    checkOrder: true,
    log: () => undefined,
  });
  return done.map((m) => m.name);
}
