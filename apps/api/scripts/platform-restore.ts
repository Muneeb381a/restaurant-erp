import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadEnv } from '../src/config/env';
import { directUrl, findPgTool, redact, restoreArgs } from '../src/control/backup';
import { createControlDb } from '../src/control/boot';
import { createSecretBox } from '../src/control/secret-box';

/**
 * pnpm platform:restore <restaurant-code> <file.dump> --yes
 *
 * Puts a backup of ONE restaurant back into its own database. It REPLACES what is there now: every
 * table in the dump is dropped and rebuilt from the file, in one transaction (all or nothing).
 *
 * Safety: the restaurant must be switched off first (Platform -> the restaurant -> Switch off), so
 * nobody is writing while it is replaced. Switch it back on after you have looked at the result.
 * It never touches the control database; that one is restored by hand (docs/BACKUP-RESTORE.md).
 */
const [code, file] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const yes = process.argv.includes('--yes');
if (!code || !file)
  throw new Error('Usage: pnpm platform:restore <restaurant-code> <file.dump> --yes');
const dump = path.resolve(file);
if (!existsSync(dump)) throw new Error(`No such file: ${dump}`);

const env = loadEnv();
if (!env.CONTROL_DATABASE_URL) throw new Error('CONTROL_DATABASE_URL is required');
const box = createSecretBox(env.TENANT_SECRET_KEY!);

const control = createControlDb(env.CONTROL_DATABASE_URL, 1);
let url: string;
try {
  const t = await control
    .selectFrom('tenants')
    .select(['slug', 'name', 'status', 'db_direct_url_enc'])
    .where('slug', '=', code)
    .executeTakeFirst();
  if (!t?.db_direct_url_enc) throw new Error(`No restaurant "${code}" with a database`);
  if (t.status !== 'SUSPENDED')
    throw new Error(
      `"${code}" is ${t.status}. Switch it off first (Platform -> the restaurant -> Switch off), ` +
        'so nobody is writing while its database is replaced.',
    );
  console.log(`Restaurant: ${t.name} (${t.slug}), switched off`);
  url = directUrl(box.decrypt(t.db_direct_url_enc));
} finally {
  await control.destroy();
}

if (!yes) {
  console.log(`\nThis would REPLACE the database of "${code}" with the contents of`);
  console.log(`  ${dump}`);
  console.log('Run it again with --yes to do it.');
  process.exit(2);
}

const pgRestore = findPgTool('pg_restore', process.env, process.platform);
const child = spawn(pgRestore, restoreArgs(url, dump), { stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (d) => (out += String(d)));
child.stderr.on('data', (d) => (out += String(d)));
const code2: number = await new Promise((resolve) => {
  child.on('error', (e) => {
    out += `${pgRestore}: ${e.message}. Install PostgreSQL client tools 17+ or set PG_BIN.`;
    resolve(127);
  });
  child.on('close', (c) => resolve(c ?? 1));
});
if (code2 !== 0) {
  console.error(redact(out, url).trim().split('\n').slice(-6).join('\n'));
  console.error('\nRestore FAILED. Nothing was changed (it runs in one transaction).');
  process.exit(1);
}
console.log(`Restored "${code}" from ${path.basename(dump)}.`);
console.log(
  'Check it, then switch the restaurant back on (Platform -> the restaurant -> Switch on).',
);
