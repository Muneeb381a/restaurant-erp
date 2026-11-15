import { existsSync } from 'node:fs';
import path from 'node:path';

/** Pure helpers for `pnpm platform:backup` (the script itself only does I/O). */

/** A backup run is one folder named like 2026-11-15_0230 (UTC), so folders sort by time. */
export function backupFolderName(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

const FOLDER = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})$/;

/**
 * Which backup folders are older than `keepDays`. Only folders that match the name above are ever
 * returned, so anything else in the directory is left alone. At least `minKeep` of the newest are
 * always kept, even when they are all old (a stopped schedule must not delete the last good backup).
 */
export function expiredFolders(
  names: string[],
  now: Date,
  keepDays: number,
  minKeep = 3,
): string[] {
  const dated = names
    .map((name) => {
      const m = FOLDER.exec(name);
      if (!m) return null;
      const at = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!);
      return { name, at };
    })
    .filter((x): x is { name: string; at: number } => x !== null)
    .sort((a, b) => b.at - a.at);
  const cutoff = now.getTime() - keepDays * 86_400_000;
  return dated
    .slice(minKeep)
    .filter((x) => x.at < cutoff)
    .map((x) => x.name);
}

/** Maintenance work (dumps) must not go through Neon's connection pooler. */
export function directUrl(url: string): string {
  const u = new URL(url);
  u.hostname = u.hostname.replace('-pooler.', '.');
  return u.toString();
}

/**
 * Arguments for pg_dump. Custom format is compressed and lets pg_restore pick parts or list the
 * contents; owners and grants are left out so a dump restores into any database.
 */
export function dumpArgs(url: string, file: string): string[] {
  return ['--format=custom', '--no-owner', '--no-privileges', `--file=${file}`, `--dbname=${url}`];
}

/**
 * Arguments for pg_restore into an EXISTING database: everything in the dump is dropped and rebuilt,
 * in one transaction, so a bad file changes nothing.
 */
export function restoreArgs(url: string, file: string): string[] {
  return [
    '--clean',
    '--if-exists',
    '--no-owner',
    '--no-privileges',
    '--single-transaction',
    '--exit-on-error',
    `--dbname=${url}`,
    file,
  ];
}

/** Takes the secret out of a tool's output before it is printed or stored. */
export function redact(text: string, url: string): string {
  let out = text;
  try {
    const u = new URL(url);
    for (const secret of [u.password, decodeURIComponent(u.password)])
      if (secret) out = out.split(secret).join('***');
  } catch {
    // not a URL: nothing to take out
  }
  return out.replace(/postgres(ql)?:\/\/[^\s'"]+/g, 'postgres://***');
}

/**
 * Finds pg_dump / pg_restore: an explicit PG_BIN folder, a Windows install, else the PATH.
 * `exists` is injected so the search is testable.
 */
export function findPgTool(
  tool: 'pg_dump' | 'pg_restore',
  env: NodeJS.ProcessEnv,
  platform: string,
  exists: (p: string) => boolean = existsSync,
): string {
  const exe = platform === 'win32' ? `${tool}.exe` : tool;
  const dirs: string[] = [];
  if (env.PG_BIN) dirs.push(env.PG_BIN);
  if (platform === 'win32')
    for (const v of [18, 17, 16]) dirs.push(`C:\\Program Files\\PostgreSQL\\${v}\\bin`);
  for (const d of dirs) {
    const p = platform === 'win32' ? `${d}\\${exe}` : path.join(d, exe);
    if (exists(p)) return p;
  }
  return exe; // rely on the PATH
}
