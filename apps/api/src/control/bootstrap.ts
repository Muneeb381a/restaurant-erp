import { randomInt } from 'node:crypto';
import pg from 'pg';
import type { PasswordHasher } from '../modules/auth/password';

/** 14 characters with nothing easy to mix up (no 0/O, 1/l/I): read aloud or typed from a message. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
export function generateTempPassword(length = 14): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export interface BootstrapInput {
  restaurantName: string;
  ownerName: string;
  ownerUsername: string;
  ownerPassword: string;
  phone?: string | null;
}

/**
 * Puts a new restaurant's database into a usable state: one branch, price lists, payment methods,
 * the settings the till reads, placeholder tax rules (UNVERIFIED, exactly like every other install:
 * tax stays off until an accountant fills them in) and the owner's login. No menu, tables, stock or
 * demo data: the owner sets those up from the Setup checklist.
 *
 * Safe to call twice: when the database already has a branch it changes nothing and says so.
 */
export async function bootstrapRestaurant(
  directUrl: string,
  input: BootstrapInput,
  hasher: PasswordHasher,
): Promise<{ created: boolean }> {
  const passwordHash = await hasher.hash(input.ownerPassword);
  const client = new pg.Client({ connectionString: directUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT 1 FROM branches LIMIT 1');
    if (existing.rowCount) {
      await client.query('ROLLBACK');
      return { created: false };
    }
    const branch = await client.query<{ id: string }>(
      `INSERT INTO branches(code, name, phone, tax_authority) VALUES ('MAIN', $1, $2, 'NONE') RETURNING id`,
      [input.restaurantName, input.phone ?? null],
    );
    const b = branch.rows[0]!.id;
    await client.query(
      `INSERT INTO price_lists(branch_id, code, name) VALUES
         ($1,'DINE_IN','Dine-in'),($1,'TAKEAWAY','Takeaway'),($1,'DELIVERY','Delivery')`,
      [b],
    );
    await client.query(
      `INSERT INTO payment_methods(branch_id, code, name, tender_class, opens_drawer, needs_reference) VALUES
         ($1,'CASH','Cash','CASH_OTHER',true,false),
         ($1,'CARD','Debit/Credit Card','DIGITAL',false,true),
         ($1,'JAZZCASH','JazzCash','DIGITAL',false,true),
         ($1,'EASYPAISA','Easypaisa','DIGITAL',false,true),
         ($1,'RAAST_QR','Raast / Bank QR','DIGITAL',false,true),
         ($1,'KHATA','Customer Khata (credit)','CASH_OTHER',false,false)`,
      [b],
    );
    await client.query(
      `INSERT INTO settings(branch_id, key, value) VALUES
         ($1,'tax.service_charge_taxable','true'),
         ($1,'tax.mixed_tender_policy','"HIGHEST_RATE_IF_ANY_NON_DIGITAL"'),
         ($1,'billing.round_to_rupee','true'),
         ($1,'billing.service_charge_bps','0'),
         ($1,'kot.print_on_send','true')`,
      [b],
    );
    // PLACEHOLDER rates: verified_by stays NULL on purpose (CLAUDE.md rule 3). Same rows as db/003_seed_dev.sql.
    await client.query(
      `INSERT INTO tax_rules(authority, tax_category_id, payment_class, rate_bps, effective_from, source_note)
       SELECT v.authority, tc.id, v.payment_class, v.rate_bps, v.effective_from::date, v.note
         FROM tax_categories tc,
              (VALUES
                ('PRA','CASH_OTHER',1600,'2026-07-01','Punjab Finance Act 2026 — restaurants, non-digital (VERIFY)'),
                ('PRA','DIGITAL',800,'2026-07-01','Punjab Finance Act 2026 — card/wallet/QR, no input adjustment (VERIFY)'),
                ('SRB','CASH_OTHER',1500,'2025-07-01','Sindh standard rate (VERIFY)'),
                ('SRB','DIGITAL',800,'2025-07-01','Sindh reduced digital rate (VERIFY)')
              ) AS v(authority, payment_class, rate_bps, effective_from, note)
        WHERE tc.code = 'RESTAURANT_SERVICE'`,
    );
    const owner = await client.query<{ id: string }>(`SELECT id FROM roles WHERE code = 'OWNER'`);
    if (!owner.rows[0]) throw new Error('The OWNER role is missing: were the migrations applied?');
    await client.query(
      `INSERT INTO users(branch_id, role_id, username, full_name, password_hash, must_change_password)
       VALUES (NULL, $1, $2, $3, $4, true)`,
      [owner.rows[0].id, input.ownerUsername, input.ownerName, passwordHash],
    );
    await client.query('COMMIT');
    return { created: true };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await client.end();
  }
}

/** Gives the owner a new temporary password (the old one stops working, other sessions are signed out). */
export async function resetOwnerPassword(
  directUrl: string,
  ownerUsername: string,
  newPassword: string,
  hasher: PasswordHasher,
): Promise<boolean> {
  const hash = await hasher.hash(newPassword);
  const client = new pg.Client({ connectionString: directUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query<{ id: string }>(
      `UPDATE users SET password_hash = $2, is_active = true, must_change_password = true
        WHERE username = $1 AND role_id = (SELECT id FROM roles WHERE code = 'OWNER')
        RETURNING id`,
      [ownerUsername, hash],
    );
    if (!user.rowCount) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(
      `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
      [user.rows[0]!.id],
    );
    // a locked-out owner must be able to use the new password straight away
    await client.query(
      `UPDATE users SET failed_attempts = 0, last_failed_at = NULL, locked_until = NULL WHERE id = $1`,
      [user.rows[0]!.id],
    );
    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await client.end();
  }
}
