import { loadEnv } from '../src/config/env';
import { createControlDb } from '../src/control/boot';
import { createHasher } from '../src/modules/auth/password';
import { migrateUp } from '../src/db/migrate';
import { migrateTenant, type PlatformDeps } from '../src/control/platform.service';
import { createSecretBox } from '../src/control/secret-box';
import { createLogger } from '../src/shared/logger';

// pnpm platform:migrate    after every deploy: brings the control database, then every restaurant's
// database, up to date. Forward-only. One failing restaurant does not stop the others.
const env = loadEnv();
if (!env.CONTROL_DATABASE_URL) throw new Error('CONTROL_DATABASE_URL is required');

console.log(
  'control:',
  (await migrateUp(env.CONTROL_DATABASE_URL, 'control')).join(', ') || 'up to date',
);

const control = createControlDb(env.CONTROL_DATABASE_URL, 2);
const deps = {
  control,
  box: createSecretBox(env.TENANT_SECRET_KEY!),
  hasher: createHasher(),
  logger: createLogger('silent'),
} as unknown as PlatformDeps;

let failed = 0;
try {
  const tenants = await control
    .selectFrom('tenants')
    .select(['id', 'slug', 'status'])
    .where('status', 'in', ['ACTIVE', 'SUSPENDED'])
    .orderBy('slug')
    .execute();
  for (const t of tenants) {
    try {
      const { applied } = await migrateTenant(deps, null, t.id);
      console.log(`${t.slug}:`, applied.length ? applied.join(', ') : 'up to date');
    } catch (e) {
      failed++;
      console.error(`${t.slug}: FAILED - ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(`${tenants.length - failed}/${tenants.length} restaurants up to date`);
} finally {
  await control.destroy();
}
if (failed) process.exit(1);
