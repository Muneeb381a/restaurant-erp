import { migrateUp, type MigrationSet } from '../src/db/migrate';

// pnpm db:migrate [core|phase2|all]  (default: all = core, then phase2)
const which = (process.argv[2] ?? 'all') as MigrationSet | 'all';
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

const sets: MigrationSet[] = which === 'all' ? ['core', 'phase2'] : [which];
for (const set of sets) {
  const applied = await migrateUp(url, set);
  console.log(applied.length ? `applied (${set}): ${applied.join(', ')}` : `up to date (${set})`);
}
