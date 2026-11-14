import { loadEnv } from '../src/config/env';
import { createControlDb } from '../src/control/boot';
import { generateTempPassword } from '../src/control/bootstrap';
import { createAdmin } from '../src/control/platform.service';
import { createHasher } from '../src/modules/auth/password';

// pnpm platform:admin create <username> "<Full Name>"   makes the first (or another) platform admin
// pnpm platform:admin reset  <username>                 gives an existing admin a new password
// The password is printed once. It is generated here, never a default, and it is not logged anywhere else.
const [command, username, ...rest] = process.argv.slice(2);
const env = loadEnv();
if (!env.CONTROL_DATABASE_URL) throw new Error('CONTROL_DATABASE_URL is required');
if (!command || !username || !/^[a-z0-9._-]{3,40}$/.test(username))
  throw new Error(
    'Usage: platform:admin create|reset <username (3-40: a-z 0-9 . _ -)> ["Full Name"]',
  );

const control = createControlDb(env.CONTROL_DATABASE_URL, 1);
const hasher = createHasher();
const password = process.env.PLATFORM_ADMIN_PASSWORD ?? generateTempPassword(18);
try {
  if (command === 'create') {
    await createAdmin(control, hasher, {
      username,
      fullName: rest.join(' ') || username,
      password,
    });
  } else if (command === 'reset') {
    const done = await control
      .updateTable('platform_admins')
      .set({
        password_hash: await hasher.hash(password),
        failed_attempts: 0,
        last_failed_at: null,
        locked_until: null,
      })
      .where('username', '=', username)
      .returning('id')
      .executeTakeFirst();
    if (!done) throw new Error(`No platform admin called ${username}`);
    await control
      .updateTable('platform_sessions')
      .set({ revoked_at: new Date() })
      .where('admin_id', '=', done.id)
      .where('revoked_at', 'is', null)
      .execute();
  } else {
    throw new Error(`Unknown command ${command}`);
  }
  console.log(`\n  platform admin: ${username}\n  password:       ${password}\n`);
  console.log('Save it now: it cannot be shown again.');
} finally {
  await control.destroy();
}
