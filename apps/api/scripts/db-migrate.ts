import { migrateUp, type MigrationSet } from '../src/db/migrate';

const set = (process.argv[2] ?? 'core') as MigrationSet;
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

const applied = await migrateUp(url, set);
console.log(applied.length ? `applied (${set}): ${applied.join(', ')}` : `up to date (${set})`);
