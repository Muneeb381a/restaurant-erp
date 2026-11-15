import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { loadEnv } from '../src/config/env';
import {
  backupFolderName,
  directUrl,
  dumpArgs,
  expiredFolders,
  findPgTool,
  redact,
} from '../src/control/backup';
import { createControlDb } from '../src/control/boot';
import { createSecretBox } from '../src/control/secret-box';

/**
 * pnpm platform:backup [--dir <folder>] [--keep <days>] [--only <code>] [--no-control]
 *
 * One pg_dump per restaurant database plus the control database, into <dir>/<YYYY-MM-DD_HHMM>/.
 * Every dump is opened again with pg_restore --list, so a broken file is caught now, not on the day
 * it is needed. Folders older than --keep days are removed (the newest three are always kept).
 * Needs the PostgreSQL client tools (pg_dump, pg_restore), version 17 or newer. See docs/BACKUP-RESTORE.md.
 */
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = path.resolve(flag('--dir') ?? process.env.BACKUP_DIR ?? 'backups');
const keepDays = Number(flag('--keep') ?? process.env.BACKUP_KEEP_DAYS ?? 14);
const only = flag('--only');
const withControl = !args.includes('--no-control') && !only;
if (!Number.isFinite(keepDays) || keepDays < 1) throw new Error('--keep must be a number of days');

const env = loadEnv();
if (!env.CONTROL_DATABASE_URL) throw new Error('CONTROL_DATABASE_URL is required');
const box = createSecretBox(env.TENANT_SECRET_KEY!);
const pgDump = findPgTool('pg_dump', process.env, process.platform);
const pgRestore = findPgTool('pg_restore', process.env, process.platform);

function run(
  cmd: string,
  cmdArgs: string[],
  secretUrl: string,
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (out += String(d)));
    child.on('error', (e) =>
      resolve({
        code: 127,
        out: `${cmd}: ${e.message}. Install PostgreSQL client tools 17+ or set PG_BIN.`,
      }),
    );
    child.on('close', (code) => resolve({ code: code ?? 1, out: redact(out, secretUrl) }));
  });
}

const sha256 = (file: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });

interface Item {
  name: string;
  url: string;
}

const control = createControlDb(env.CONTROL_DATABASE_URL, 1);
const items: Item[] = [];
try {
  const tenants = await control
    .selectFrom('tenants')
    .select(['slug', 'status', 'db_direct_url_enc'])
    .where('db_direct_url_enc', 'is not', null) // a restaurant whose database was never made has nothing to save
    .where('status', 'in', ['ACTIVE', 'SUSPENDED', 'ARCHIVED'])
    .$if(!!only, (q) => q.where('slug', '=', only!))
    .orderBy('slug')
    .execute();
  if (only && tenants.length === 0)
    throw new Error(`No restaurant with code "${only}" has a database`);
  for (const t of tenants)
    items.push({ name: `restaurant-${t.slug}`, url: directUrl(box.decrypt(t.db_direct_url_enc!)) });
} finally {
  await control.destroy();
}
if (withControl) items.unshift({ name: 'control', url: directUrl(env.CONTROL_DATABASE_URL) });

const stamp = backupFolderName(new Date());
const folder = path.join(dir, stamp);
mkdirSync(folder, { recursive: true });

const manifest: {
  name: string;
  file: string;
  bytes: number;
  sha256: string;
  ok: boolean;
  error?: string;
}[] = [];
let failed = 0;
for (const it of items) {
  const file = path.join(folder, `${it.name}.dump`);
  const t0 = Date.now();
  const dump = await run(pgDump, dumpArgs(it.url, file), it.url);
  let ok = dump.code === 0;
  let error = ok ? undefined : dump.out.trim().split('\n').slice(-3).join(' | ');
  if (ok) {
    // the file must open as a PostgreSQL archive and list its tables
    const list = await run(pgRestore, ['--list', file], it.url);
    if (list.code !== 0 || !list.out.includes('TABLE')) {
      ok = false;
      error = `the dump does not open as an archive: ${list.out.trim().split('\n').slice(-2).join(' | ')}`;
    }
  }
  const bytes = ok ? statSync(file).size : 0;
  manifest.push({
    name: it.name,
    file: path.basename(file),
    bytes,
    sha256: ok ? await sha256(file) : '',
    ok,
    ...(error ? { error } : {}),
  });
  if (!ok) failed++;
  console.log(
    `${ok ? 'OK  ' : 'FAIL'} ${it.name.padEnd(32)} ${ok ? `${(bytes / 1024).toFixed(0)} KB  ${((Date.now() - t0) / 1000).toFixed(1)} s` : error}`,
  );
}
writeFileSync(
  path.join(folder, 'manifest.json'),
  JSON.stringify({ createdAt: new Date().toISOString(), items: manifest }, null, 2),
);

// a run with a failure is renamed so it is never taken for a good backup; the clean-up below only
// touches folders named like a good run, so it never deletes a failed one (or a good one it needs)
const finalFolder = failed ? `${folder}_FAILED` : folder;
if (failed) renameSync(folder, finalFolder);

// remove old backup folders, never anything that is not named like one
for (const old of expiredFolders(readdirSync(dir), new Date(), keepDays)) {
  rmSync(path.join(dir, old), { recursive: true, force: true });
  console.log(`removed old backup ${old}`);
}
console.log(`\n${manifest.length - failed}/${manifest.length} saved in ${finalFolder}`);
if (failed) {
  console.error(`${failed} backup(s) FAILED. Do not rely on this run.`);
  process.exit(1);
}
