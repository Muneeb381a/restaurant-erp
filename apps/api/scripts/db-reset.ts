import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrateUp } from '../src/db/migrate';

// DEV ONLY: drops and recreates the database, migrates, loads db/003_seed_dev.sql.
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
if (process.env.NODE_ENV === 'production') throw new Error('db:reset refuses to run in production');

const target = new URL(url);
const dbName = target.pathname.slice(1);
if (!/^[a-z0-9_]+$/i.test(dbName)) throw new Error(`Unsafe database name: ${dbName}`);
if (!['localhost', '127.0.0.1', 'db'].includes(target.hostname)) {
  throw new Error(`db:reset only runs against a local database (got ${target.hostname})`);
}

const admin = new URL(url);
admin.pathname = '/postgres';
const adminClient = new pg.Client({ connectionString: admin.toString() });
await adminClient.connect();
await adminClient.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
await adminClient.query(`CREATE DATABASE "${dbName}"`);
await adminClient.end();

console.log('migrated:', (await migrateUp(url, 'core')).join(', '));

const here = path.dirname(fileURLToPath(import.meta.url));
const seed = await readFile(path.resolve(here, '../../../db/003_seed_dev.sql'), 'utf8');
const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query(seed);
await client.end();
console.log('dev seed loaded');
