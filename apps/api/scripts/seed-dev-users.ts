import pg from 'pg';
import { createHasher } from '../src/modules/auth/password';

/**
 * DEV ONLY. Creates one login per seeded role for the demo branch so the UI/API can be tried
 * immediately. The credentials are public (they are in docs/demo/M1.md) — never run this in
 * production; db-reset already refuses to.
 */
export const DEV_PASSWORD = 'Dev#Passw0rd';
export const DEV_PIN = '1234';

export async function seedDevUsers(databaseUrl: string): Promise<string[]> {
  const hasher = createHasher();
  const [passwordHash, pinHash] = await Promise.all([
    hasher.hash(DEV_PASSWORD),
    hasher.hash(DEV_PIN),
  ]);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const branch = await client.query<{ id: string }>(
      `SELECT id FROM branches WHERE code = 'MAIN'`,
    );
    if (!branch.rows[0])
      throw new Error('Demo branch MAIN not found — load db/003_seed_dev.sql first');
    const roles = await client.query<{ id: string; code: string }>(`SELECT id, code FROM roles`);
    const created: string[] = [];
    for (const role of roles.rows) {
      const username = role.code.toLowerCase();
      await client.query(
        `INSERT INTO users(branch_id, role_id, username, full_name, password_hash, pin_hash, discount_limit_bps)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          role.code === 'OWNER' ? null : branch.rows[0].id, // owner is owner-level (all branches)
          role.id,
          username,
          `Dev ${role.code}`,
          passwordHash,
          pinHash,
          role.code === 'MANAGER' ? 2000 : role.code === 'CASHIER' ? 1000 : 0,
        ],
      );
      created.push(username);
    }
    return created;
  } finally {
    await client.end();
  }
}
