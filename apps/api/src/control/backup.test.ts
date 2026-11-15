import { describe, expect, it } from 'vitest';
import {
  backupFolderName,
  directUrl,
  dumpArgs,
  expiredFolders,
  findPgTool,
  redact,
  restoreArgs,
} from './backup';

describe('backup folders', () => {
  it('are named by UTC time so they sort', () => {
    expect(backupFolderName(new Date('2026-11-15T02:30:45Z'))).toBe('2026-11-15_0230');
  });

  it('only old backup folders are expired, and the newest few are always kept', () => {
    const names = [
      '2026-10-01_0200',
      '2026-10-02_0200',
      '2026-11-10_0200',
      '2026-11-14_0200',
      '2026-11-15_0200',
      'notes.txt',
      'other-folder',
    ];
    const now = new Date('2026-11-15T12:00:00Z');
    expect(expiredFolders(names, now, 14)).toEqual(['2026-10-02_0200', '2026-10-01_0200']);
    // a stopped schedule: everything is old, yet the newest three stay
    expect(expiredFolders(names, new Date('2027-06-01T00:00:00Z'), 14)).toEqual([
      '2026-10-02_0200',
      '2026-10-01_0200',
    ]);
    expect(expiredFolders(names, new Date('2027-06-01T00:00:00Z'), 14, 1)).toEqual([
      '2026-11-14_0200',
      '2026-11-10_0200',
      '2026-10-02_0200',
      '2026-10-01_0200',
    ]);
    expect(expiredFolders(['x', 'y'], now, 1)).toEqual([]);
  });
});

describe('connection and tool helpers', () => {
  it('dumps go straight to the database, not through the pooler', () => {
    expect(
      directUrl('postgresql://u:p@ep-a-b-1-pooler.ap-southeast-1.aws.neon.tech/db?sslmode=require'),
    ).toBe('postgresql://u:p@ep-a-b-1.ap-southeast-1.aws.neon.tech/db?sslmode=require');
    expect(directUrl('postgres://u:p@localhost:5432/db')).toBe('postgres://u:p@localhost:5432/db');
  });

  it('asks pg_dump for a compressed dump that restores anywhere', () => {
    const a = dumpArgs('postgres://u:p@h/db', 'x.dump');
    expect(a).toContain('--format=custom');
    expect(a).toContain('--no-owner');
    expect(a).toContain('--no-privileges');
    expect(a).toContain('--file=x.dump');
  });

  it('takes passwords and URLs out of tool output', () => {
    const url = 'postgres://app:s3cr%40t@h/db';
    const out = redact(
      `pg_dump: error: connection to server failed: postgres://app:s3cr%40t@h/db (s3cr@t)`,
      url,
    );
    expect(out).not.toContain('s3cr');
    expect(out).toContain('postgres://***');
  });

  it('finds the PostgreSQL tools: PG_BIN first, then a Windows install, else the PATH', () => {
    const only = (p: string) => (q: string) => q === p;
    expect(
      findPgTool('pg_dump', { PG_BIN: 'D:\\pg\\bin' }, 'win32', only('D:\\pg\\bin\\pg_dump.exe')),
    ).toBe('D:\\pg\\bin\\pg_dump.exe');
    expect(
      findPgTool(
        'pg_restore',
        {},
        'win32',
        only('C:\\Program Files\\PostgreSQL\\17\\bin\\pg_restore.exe'),
      ),
    ).toBe('C:\\Program Files\\PostgreSQL\\17\\bin\\pg_restore.exe');
    expect(findPgTool('pg_dump', {}, 'linux', () => false)).toBe('pg_dump');
  });
});

describe('restore', () => {
  it('replaces the database in one transaction and stops at the first error', () => {
    const a = restoreArgs('postgres://u:p@h/db', 'x.dump');
    expect(a).toEqual(
      expect.arrayContaining(['--clean', '--if-exists', '--single-transaction', '--exit-on-error']),
    );
    expect(a[a.length - 1]).toBe('x.dump');
  });
});
