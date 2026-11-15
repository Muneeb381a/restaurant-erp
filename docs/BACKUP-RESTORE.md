# Backups and restore

Money records are the one thing that cannot be recreated. Neon keeps point-in-time history **per
project**, and in the shared-server setup ([ADR 0021](adr/0021-shared-server-database-per-restaurant.md))
all restaurants live in one project, so Neon's own restore brings back **all of them to one moment**. That is
not enough to give one restaurant back its data. These commands take a separate dump of every restaurant
and of the control database.

## What you need once

- PostgreSQL client tools **17 or newer** (`pg_dump`, `pg_restore`). On Windows the installer from
  postgresql.org is enough (tick "Command Line Tools"); the scripts find
  `C:\Program Files\PostgreSQL\{18,17,16}\bin` by themselves. Elsewhere put the folder in `PG_BIN`.
- The same environment as `platform:migrate`: `CONTROL_DATABASE_URL` and `TENANT_SECRET_KEY` (in
  `.env.cloud`).
- A folder for the dumps. Default `backups/` in the repo (ignored by git). Use `--dir D:\erp-backups` or
  `BACKUP_DIR` for another place.

## Take a backup

```
pnpm platform:backup                    # control database + every restaurant
pnpm platform:backup --only karachi-grill
pnpm platform:backup --dir D:\erp-backups --keep 30
```

One folder per run, `backups/2026-11-15_0230/` (UTC), with one `.dump` per database and a `manifest.json`
(size and SHA-256 of each file). Every dump is opened again with `pg_restore --list`, so a broken file is
caught now. If any item fails the folder is renamed `..._FAILED`, the command exits with an error, and the
older good backups are kept.

- Folders older than `--keep` days (default 14) are removed; the newest three good ones always stay.
- Restaurants that are switched off or archived are included. A restaurant whose database was never created
  (setup failed) has nothing to save and is skipped.

### Make it automatic

Run it every night. On Windows (Task Scheduler), from the repo folder:

```
schtasks /Create /SC DAILY /ST 03:00 /TN "ERP backup" /TR "cmd /c cd /d D:\restaurant-erp && pnpm platform:backup --dir D:\erp-backups >> D:\erp-backups\backup.log 2>&1"
```

Check `backup.log` (or the `_FAILED` folders) now and then. A backup nobody looks at is a hope, not a
backup.

### Where to keep the files

- **Not only on the same computer.** Copy the folder to a second place (an external disk, a private cloud
  drive). The dumps contain every sale and customer: keep them private and on an encrypted disk
  (BitLocker). The scripts do not encrypt files themselves.
- **`TENANT_SECRET_KEY` is part of the backup.** The control dump holds each restaurant's connection string
  encrypted with it. Without the key those strings cannot be read. Keep the key in a password manager,
  separate from the dumps.

## Restore one restaurant

When: a restaurant lost data, or a bad change must be undone. This **replaces** its current data with the
file, so everything entered after the backup is gone.

1. Platform → the restaurant → **Switch off** (give a reason). Nobody can write now. The command refuses to
   run on a restaurant that is still on.
2. Look at what the command would do:
   ```
   pnpm platform:restore karachi-grill backups/2026-11-15_0230/restaurant-karachi-grill.dump
   ```
3. Do it:
   ```
   pnpm platform:restore karachi-grill backups/2026-11-15_0230/restaurant-karachi-grill.dump --yes
   ```
   It runs in one transaction: if the file is bad or anything fails, nothing is changed.
4. Open the restaurant's database (or ask the owner to look at one screen after switching on), then
   Platform → **Switch on**.

Practice this once with a test restaurant before you ever need it.

## Restore the control database

Rare (it only holds the list of restaurants, the platform admins and the activity log). If it is lost:

1. Create a new empty database (a new Neon project or a new database in the same project).
2. `pg_restore --no-owner --dbname "<its direct url>" backups/<run>/control.dump`
3. Put its pooled URL in `CONTROL_DATABASE_URL` (Vercel and `.env.cloud`) and redeploy.

## What is NOT covered

- Changes made after the last backup (run it more often if that is too much: it takes seconds for small
  restaurants).
- Neon's own history is a second safety net, not a replacement for these files.
- Printing queues and other temporary data come back as they were at the backup, which is fine.
