import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, startApp, type TestApp } from './app-harness';

let t: TestApp;
let owner: string;
let manager: string;

const audit = (where: { action?: string; entityId?: string }) => {
  let q = t.kdb.selectFrom('audit_log').selectAll().orderBy('id');
  if (where.action) q = q.where('action', '=', where.action);
  if (where.entityId) q = q.where('entity_id', '=', where.entityId);
  return q.execute();
};

beforeAll(async () => {
  t = await startApp();
  owner = (await t.login('OWNER')).token;
  manager = (await t.login('MANAGER')).token;
}, 180_000);
afterAll(async () => {
  await t.stop();
});

describe('floor / kitchen / billing configuration CRUD', () => {
  it('creates, lists, reads and patches an area, auditing before/after', async () => {
    const api = t.as(owner);
    const created = await api.post('/areas', { name: 'Family Hall', sort: 2 });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    expect((await api.get('/areas')).body.items.map((a: { id: string }) => a.id)).toContain(id);
    expect((await api.get(`/areas/${id}`)).body.name).toBe('Family Hall');

    const patched = await api.patch(`/areas/${id}`, { name: 'Family Hall 2' });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ name: 'Family Hall 2', sort: 2 });

    const rows = await audit({ entityId: id });
    expect(rows.map((r) => r.action)).toEqual(['AREA_CREATE', 'AREA_UPDATE']);
    expect(rows[1]!.before).toMatchObject({ name: 'Family Hall' });
    expect(rows[1]!.after).toMatchObject({ name: 'Family Hall 2' });
    expect(rows[1]!.user_id).toBeTruthy();
    expect(rows[1]!.branch_id).toBe(t.branchId);
  });

  it('tables: unique code per branch → 409, bad foreign key → 409, unknown field → 400', async () => {
    const api = t.as(owner);
    expect((await api.post('/tables', { code: 'T1', seats: 4 })).status).toBe(201);
    const dup = await api.post('/tables', { code: 'T1' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('CONFLICT');

    const fk = await api.post('/tables', {
      code: 'T9',
      area_id: '00000000-0000-4000-8000-000000000000',
    });
    expect(fk.status).toBe(409);
    expect(fk.body.code).toBe('REFERENCE_VIOLATION');

    const extra = await api.post('/tables', { code: 'T8', branch_id: t.otherBranchId });
    expect(extra.status).toBe(400); // branch_id can never be client-supplied
    expect(extra.body.code).toBe('VALIDATION_FAILED');
  });

  it('check constraints surface as 400 (printer paper width) and empty patches are rejected', async () => {
    const api = t.as(owner);
    const bad = await api.post('/printers', {
      name: 'P',
      kind: 'KOT',
      conn_type: 'NETWORK',
      paper_mm: 70,
    });
    expect(bad.status).toBe(400);
    const ok = await api.post('/printers', {
      name: 'Kitchen 1',
      kind: 'KOT',
      conn_type: 'NETWORK',
      host: '192.168.1.50',
      port: 9100,
      paper_mm: 80,
    });
    expect(ok.status).toBe(201);
    expect((await api.patch(`/printers/${ok.body.id}`, {})).status).toBe(400);
  });

  it('payment methods, price lists and stations work end to end', async () => {
    const api = t.as(owner);
    const pm = await api.post('/payment-methods', {
      code: 'CARD',
      name: 'Card',
      tender_class: 'DIGITAL',
      needs_reference: true,
    });
    expect(pm.status).toBe(201);
    expect(pm.body.tender_class).toBe('DIGITAL');
    expect(
      (await api.post('/payment-methods', { code: 'X', name: 'X', tender_class: 'BARTER' })).status,
    ).toBe(400);
    expect((await api.post('/price-lists', { code: 'DINE_IN', name: 'Dine-in' })).status).toBe(201);
    expect((await api.post('/stations', { code: 'BBQ', name: 'BBQ' })).status).toBe(201);
  });

  it('station → printers mapping is replaced atomically and audited', async () => {
    const api = t.as(owner);
    const st = (await api.post('/stations', { code: 'TANDOOR', name: 'Tandoor' })).body
      .id as string;
    const p1 = (
      await api.post('/printers', {
        name: 'Tandoor KOT',
        kind: 'KOT',
        conn_type: 'NETWORK',
        host: '10.0.0.5',
      })
    ).body.id as string;
    const p2 = (
      await api.post('/printers', {
        name: 'Backup KOT',
        kind: 'KOT',
        conn_type: 'NETWORK',
        host: '10.0.0.6',
      })
    ).body.id as string;
    expect((await api.put(`/stations/${st}/printers`, { printerIds: [p1, p2] })).status).toBe(200);
    expect((await api.get(`/stations/${st}/printers`)).body.printerIds.sort()).toEqual(
      [p1, p2].sort(),
    );
    expect((await api.put(`/stations/${st}/printers`, { printerIds: [p2] })).status).toBe(200);
    expect((await api.get(`/stations/${st}/printers`)).body.printerIds).toEqual([p2]);
    const bad = await api.put(`/stations/${st}/printers`, {
      printerIds: ['00000000-0000-4000-8000-000000000000'],
    });
    expect(bad.status).toBe(400);
    expect((await api.get(`/stations/${st}/printers`)).body.printerIds).toEqual([p2]); // unchanged
    const rows = await audit({ action: 'STATION_PRINTERS_SET', entityId: st });
    expect(rows).toHaveLength(2);
    expect(rows[1]!.before).toEqual({ printerIds: expect.arrayContaining([p1, p2]) });
  });

  it('is branch-scoped: another branch cannot see or modify these rows', async () => {
    const mine = (await t.as(owner).post('/areas', { name: 'Scoped' })).body.id as string;
    const other = (await t.login('MANAGER2')).token;
    // manager2 belongs to branch 2 (and lacks settings.manage anyway) — reads must be scoped:
    expect(
      (await t.as(other).get('/areas')).body.items.map((a: { id: string }) => a.id),
    ).not.toContain(mine);
    expect((await t.as(other).get(`/areas/${mine}`)).status).toBe(404);
    // owner acting on the other branch cannot patch it either
    const cross = await t.as(owner, t.otherBranchId).patch(`/areas/${mine}`, { name: 'hijack' });
    expect(cross.status).toBe(404);
  });

  it('owner-level users must pick a branch when several exist', async () => {
    const res = await request(t.app).get('/api/v1/areas').set('Authorization', `Bearer ${owner}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BRANCH_REQUIRED');
    const bad = await request(t.app)
      .get('/api/v1/areas')
      .set('Authorization', `Bearer ${owner}`)
      .set('x-branch-id', 'not-a-uuid');
    expect(bad.status).toBe(400);
  });

  it('DELETE is not exposed where money points at the rows (payment methods, price lists)', async () => {
    const pm = (
      await t.as(owner).post('/payment-methods', {
        code: 'KEEPPM',
        name: 'Keep',
        tender_class: 'CASH_OTHER',
      })
    ).body.id;
    expect((await t.as(owner).delete(`/payment-methods/${pm}`)).status).toBe(404);
    const pl = (await t.as(owner).post('/price-lists', { code: 'KEEPPL', name: 'Keep' })).body.id;
    expect((await t.as(owner).delete(`/price-lists/${pl}`)).status).toBe(404);
  });

  it('an unused area can be deleted (ADR 0022); the full rules are in delete-config.test.ts', async () => {
    const id = (await t.as(owner).post('/areas', { name: 'Temporary' })).body.id;
    expect((await t.as(owner).delete(`/areas/${id}`)).status).toBe(204);
  });
});

describe('branch and settings', () => {
  it('updates branch details; tax identity needs tax.manage', async () => {
    const roleId = (await t.as(owner).post('/roles', { code: 'SETUP', name: 'Setup' })).body
      .id as string;
    expect(
      (await t.as(owner).put(`/roles/${roleId}/permissions`, { permissions: ['settings.manage'] }))
        .status,
    ).toBe(200);
    expect(
      (
        await t
          .as(owner)
          .post('/users', { username: 'setup1', fullName: 'Setup', roleId, password: PASSWORD })
      ).status,
    ).toBe(201);
    const setup = (await t.login('setup1')).token;

    const name = await t.as(setup).patch('/branch', { name: 'Desi Dera' });
    expect(name.status).toBe(200);
    expect(name.body.name).toBe('Desi Dera');
    const tax = await t.as(setup).patch('/branch', { tax_authority: 'PRA' });
    expect(tax.status).toBe(403);
    expect(tax.body.permission).toBe('tax.manage');
    const ntn = await t.as(setup).patch('/branch', { ntn: '1234567-8' });
    expect(ntn.status).toBe(403);

    const ok = await t.as(owner).patch('/branch', { tax_authority: 'PRA', ntn: '1234567-8' });
    expect(ok.status).toBe(200);
    const rows = await audit({ action: 'BRANCH_UPDATE' });
    expect(rows.at(-1)!.before).toMatchObject({ tax_authority: 'NONE' });
    expect(rows.at(-1)!.after).toMatchObject({ tax_authority: 'PRA' });
  });

  it('validates known settings, rejects unknown keys, and audits changes', async () => {
    const api = t.as(owner);
    expect((await api.put('/settings/typo.key', { value: true })).status).toBe(400);
    expect((await api.put('/settings/billing.round_to_rupee', { value: 'yes' })).status).toBe(400);
    expect((await api.put('/settings/billing.service_charge_bps', { value: 12.5 })).status).toBe(
      400,
    );
    expect((await api.put('/settings/billing.service_charge_bps', { value: 10001 })).status).toBe(
      400,
    );
    expect((await api.put('/settings/tax.mixed_tender_policy', { value: 'MAGIC' })).status).toBe(
      400,
    );

    expect((await api.put('/settings/billing.service_charge_bps', { value: 500 })).status).toBe(
      200,
    );
    expect((await api.put('/settings/billing.service_charge_bps', { value: 600 })).status).toBe(
      200,
    );
    expect((await api.get('/settings')).body['billing.service_charge_bps']).toBe(600);

    const rows = (await audit({ action: 'SETTING_SET' })).filter(
      (r) => (r.after as { key: string }).key === 'billing.service_charge_bps',
    );
    expect(rows.at(-1)!.before).toMatchObject({ value: 500 });
    expect(rows.at(-1)!.after).toMatchObject({ value: 600 });
  });

  it('a manager cannot change settings or tax settings', async () => {
    expect(
      (await t.as(manager).put('/settings/billing.round_to_rupee', { value: false })).status,
    ).toBe(403);
    expect(
      (await t.as(manager).put('/settings/tax.service_charge_taxable', { value: false })).status,
    ).toBe(403);
  });
});

describe('users', () => {
  it('creates a user without leaking or auditing credentials; normalises username', async () => {
    const res = await t.as(owner).post('/users', {
      username: '  Ali.Raza ',
      fullName: 'Ali Raza',
      roleId: await t.roleId('CAPTAIN'),
      pin: '2468',
      discountLimitBps: 500,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      username: 'ali.raza',
      role_code: 'CAPTAIN',
      has_pin: true,
      has_password: false,
      discount_limit_bps: 500,
      branch_id: t.branchId,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/hash|argon2/i);
    expect(
      (
        await request(t.app)
          .post('/api/v1/auth/login-pin')
          .send({ username: 'ali.raza', pin: '2468' })
      ).status,
    ).toBe(200);

    const dump = JSON.stringify(
      (await audit({ action: 'USER_CREATE', entityId: res.body.id })).map((r) => [
        r.before,
        r.after,
      ]),
    );
    expect(dump).not.toMatch(/argon2|2468/);
    expect(dump).toContain('has_pin');

    const list = await t.as(owner).get('/users');
    expect(JSON.stringify(list.body)).not.toMatch(/argon2/);
  });

  it('validates input: username, weak PIN/password, missing credentials, duplicate username', async () => {
    const api = t.as(owner);
    const roleId = await t.roleId('CAPTAIN');
    const base = { fullName: 'X', roleId };
    expect((await api.post('/users', { ...base, username: 'a b', pin: '1234' })).status).toBe(400);
    expect((await api.post('/users', { ...base, username: 'okname', pin: '12' })).status).toBe(400);
    expect(
      (await api.post('/users', { ...base, username: 'okname', password: 'short' })).status,
    ).toBe(400);
    expect((await api.post('/users', { ...base, username: 'okname' })).status).toBe(400);
    expect(
      (
        await api.post('/users', {
          ...base,
          username: 'okname',
          pin: '1234',
          roleId: '00000000-0000-4000-8000-000000000000',
        })
      ).status,
    ).toBe(400);
    expect((await api.post('/users', { ...base, username: 'dupname', pin: '1234' })).status).toBe(
      201,
    );
    expect((await api.post('/users', { ...base, username: 'DUPNAME', pin: '1234' })).status).toBe(
      409,
    );
  });

  it('prevents privilege escalation: you cannot assign or touch roles stronger than your own', async () => {
    const api = t.as(owner);
    const hr = (await api.post('/roles', { code: 'HR', name: 'HR' })).body.id as string;
    await api.put(`/roles/${hr}/permissions`, { permissions: ['user.manage', 'report.view'] });
    await api.post('/users', { username: 'hr1', fullName: 'HR', roleId: hr, password: PASSWORD });
    const hrTok = (await t.login('hr1')).token;

    const create = await t.as(hrTok).post('/users', {
      username: 'sneaky',
      fullName: 'S',
      roleId: await t.roleId('CASHIER'),
      pin: '1234',
    });
    expect(create.status).toBe(403);
    expect(create.body.code).toBe('PERMISSION_DENIED');
    const all = (await api.get('/users')).body.items as { id: string; username: string }[];
    const managerId = all.find((u) => u.username === 'manager')!.id;
    // HR cannot reset the credentials of, or deactivate, someone with a stronger role
    expect(
      (await t.as(hrTok).post(`/users/${managerId}/credentials`, { password: 'Hacked-pass1' }))
        .status,
    ).toBe(403);
    expect((await t.as(hrTok).patch(`/users/${managerId}`, { isActive: false })).status).toBe(403);
    // …and cannot grant itself more by editing its own role's permissions
    const grant = await t.as(hrTok).put(`/roles/${hr}/permissions`, {
      permissions: ['user.manage', 'report.view', 'bill.refund'],
    });
    expect(grant.status).toBe(403);
    // but may hand out a role it fully covers
    const cap = (await api.post('/roles', { code: 'VIEWER', name: 'Viewer' })).body.id as string;
    await api.put(`/roles/${cap}/permissions`, { permissions: ['report.view'] });
    expect(
      (
        await t
          .as(hrTok)
          .post('/users', { username: 'viewer1', fullName: 'V', roleId: cap, pin: '1234' })
      ).status,
    ).toBe(201);
  });

  it('an owner-level user can only be created by an owner-level actor', async () => {
    const res = await t.as(manager).post('/users', {
      username: 'ownerish',
      fullName: 'O',
      roleId: await t.roleId('CAPTAIN'),
      pin: '1234',
      branchId: null,
    });
    expect([403]).toContain(res.status); // manager lacks user.manage → 403 either way
    const ok = await t.as(owner).post('/users', {
      username: 'owner2',
      fullName: 'Owner 2',
      roleId: await t.roleId('OWNER'),
      password: PASSWORD,
      branchId: null,
    });
    expect(ok.status).toBe(201);
    expect(ok.body.branch_id).toBeNull();
  });

  it('protects the last active owner and self-deactivation', async () => {
    const api = t.as(owner);
    const users = (await api.get('/users')).body.items as {
      id: string;
      username: string;
      role_code: string;
    }[];
    const me = users.find((u) => u.username === 'owner')!;
    const self = await api.patch(`/users/${me.id}`, { isActive: false });
    expect(self.status).toBe(409);

    // A super-user who is not an OWNER tries to remove the only other active owner.
    const sup = (await api.post('/roles', { code: 'SUPER', name: 'Super' })).body.id as string;
    await api.put(`/roles/${sup}/permissions`, {
      permissions: (await api.get('/permissions')).body.items.map((p: { code: string }) => p.code),
    });
    await api.post('/users', {
      username: 'super1',
      fullName: 'S',
      roleId: sup,
      password: PASSWORD,
      branchId: null,
    });
    // make `owner` the only active owner
    for (const u of users.filter((x) => x.role_code === 'OWNER' && x.id !== me.id)) {
      await t.kdb.updateTable('users').set({ is_active: false }).where('id', '=', u.id).execute();
    }
    const supTok = (await t.login('super1')).token;
    const kill = await t.as(supTok).patch(`/users/${me.id}`, { isActive: false });
    expect(kill.status).toBe(409);
    expect(kill.body.code).toBe('LAST_OWNER');
    const demote = await t
      .as(supTok)
      .patch(`/users/${me.id}`, { roleId: await t.roleId('MANAGER') });
    expect(demote.body.code).toBe('LAST_OWNER');
  });

  it('deactivation and role change cut live sessions immediately', async () => {
    const api = t.as(owner);
    const u = (
      await api.post('/users', {
        username: 'temp1',
        fullName: 'T',
        roleId: await t.roleId('CASHIER'),
        password: PASSWORD,
      })
    ).body;
    const tok = (await t.login('temp1')).token;
    expect((await t.as(tok).get('/auth/me')).status).toBe(200);
    expect((await api.patch(`/users/${u.id}`, { roleId: await t.roleId('CAPTAIN') })).status).toBe(
      200,
    );
    expect((await t.as(tok).get('/auth/me')).status).toBe(401);

    const tok2 = (await t.login('temp1')).token;
    expect((await api.patch(`/users/${u.id}`, { isActive: false })).status).toBe(200);
    expect((await t.as(tok2).get('/auth/me')).status).toBe(401);
    expect(
      (
        await request(t.app)
          .post('/api/v1/auth/login')
          .send({ username: 'temp1', password: PASSWORD })
      ).status,
    ).toBe(401);

    const rows = await audit({ entityId: u.id });
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(['USER_CREATE', 'USER_UPDATE']),
    );
    const upd = rows.filter((r) => r.action === 'USER_UPDATE');
    expect(upd[0]!.before).toMatchObject({ role_code: 'CASHIER' });
    expect(upd[0]!.after).toMatchObject({ role_code: 'CAPTAIN' });
  });

  it('credential reset replaces the PIN, clears lockout, kills sessions and audits flags only', async () => {
    const api = t.as(owner);
    const u = (
      await api.post('/users', {
        username: 'temp2',
        fullName: 'T2',
        roleId: await t.roleId('CASHIER'),
        pin: '1111',
      })
    ).body;
    const old = (
      await request(t.app).post('/api/v1/auth/login-pin').send({ username: 'temp2', pin: '1111' })
    ).body.accessToken as string;
    for (let i = 0; i < 5; i++)
      await request(t.app).post('/api/v1/auth/login-pin').send({ username: 'temp2', pin: '0000' });
    expect(
      (await request(t.app).post('/api/v1/auth/login-pin').send({ username: 'temp2', pin: '1111' }))
        .status,
    ).toBe(423);

    expect((await api.post(`/users/${u.id}/credentials`, { pin: '7777' })).status).toBe(204);
    expect((await t.as(old).get('/auth/me')).status).toBe(401);
    expect(
      (await request(t.app).post('/api/v1/auth/login-pin').send({ username: 'temp2', pin: '1111' }))
        .status,
    ).toBe(401);
    expect(
      (await request(t.app).post('/api/v1/auth/login-pin').send({ username: 'temp2', pin: '7777' }))
        .status,
    ).toBe(200);

    const reset = (await audit({ action: 'USER_CREDENTIALS_RESET', entityId: u.id }))[0]!;
    expect(reset.after).toEqual({ passwordChanged: false, pinChanged: true });
    expect((await api.post(`/users/${u.id}/credentials`, {})).status).toBe(400);
  });

  it('unlock clears a lockout and is audited', async () => {
    const api = t.as(owner);
    const u = (
      await api.post('/users', {
        username: 'temp3',
        fullName: 'T3',
        roleId: await t.roleId('CASHIER'),
        pin: '1111',
      })
    ).body;
    for (let i = 0; i < 5; i++)
      await request(t.app).post('/api/v1/auth/login-pin').send({ username: 'temp3', pin: '0000' });
    expect(
      (await request(t.app).post('/api/v1/auth/login-pin').send({ username: 'temp3', pin: '1111' }))
        .status,
    ).toBe(423);
    expect((await api.post(`/users/${u.id}/unlock`)).status).toBe(204);
    expect(
      (await request(t.app).post('/api/v1/auth/login-pin').send({ username: 'temp3', pin: '1111' }))
        .status,
    ).toBe(200);
    const rows = await audit({ action: 'USER_UNLOCK', entityId: u.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.before).toMatchObject({ lockedUntil: expect.any(String) });
  });

  it('users of another branch are invisible and untouchable', async () => {
    const mgr2 = (
      await t.kdb
        .selectFrom('users')
        .select('id')
        .where('username', '=', 'manager2')
        .executeTakeFirstOrThrow()
    ).id;
    const listed = (await t.as(owner).get('/users')).body.items as { id: string }[];
    expect(listed.map((u) => u.id)).not.toContain(mgr2);
    expect((await t.as(owner).patch(`/users/${mgr2}`, { fullName: 'x' })).status).toBe(404);
    // …but the owner can work in that branch explicitly
    expect(
      (await t.as(owner, t.otherBranchId).patch(`/users/${mgr2}`, { fullName: 'Manager Two' }))
        .status,
    ).toBe(200);
  });
});

describe('roles', () => {
  it('OWNER is protected; unknown permissions are rejected; changes are audited with before/after', async () => {
    const api = t.as(owner);
    expect(
      (await api.put(`/roles/${await t.roleId('OWNER')}/permissions`, { permissions: [] })).body
        .code,
    ).toBe('ROLE_PROTECTED');

    const storeId = await t.roleId('STORE');
    const unknown = await api.put(`/roles/${storeId}/permissions`, {
      permissions: ['stock.manage', 'does.not.exist'],
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.unknown).toEqual(['does.not.exist']);

    expect(
      (
        await api.put(`/roles/${storeId}/permissions`, {
          permissions: ['stock.manage', 'report.view', 'report.view'],
        })
      ).body.permissions,
    ).toEqual(['report.view', 'stock.manage']);
    const rows = await audit({ action: 'ROLE_PERMISSIONS_SET', entityId: storeId });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.before).toMatchObject({
      code: 'STORE',
      permissions: ['report.view', 'stock.manage'],
    });
    expect(rows[0]!.after).toMatchObject({
      code: 'STORE',
      permissions: ['report.view', 'stock.manage'],
    });
  });

  it('role codes are validated and unique', async () => {
    const api = t.as(owner);
    expect((await api.post('/roles', { code: 'lower case', name: 'x' })).status).toBe(400);
    expect((await api.post('/roles', { code: 'BARISTA', name: 'Barista' })).status).toBe(201);
    expect((await api.post('/roles', { code: 'barista', name: 'Again' })).status).toBe(409);
  });
});

describe('audit log viewer', () => {
  it('paginates newest-first with a keyset cursor and supports filters', async () => {
    const api = t.as(owner);
    for (const n of ['p1', 'p2', 'p3']) await api.post('/areas', { name: `Page ${n}` });
    const page1 = await api.get('/audit-log?limit=2&entity=area');
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.nextBefore).not.toBeNull();
    const ids1 = page1.body.items.map((r: { id: number }) => r.id);
    expect(ids1[0]).toBeGreaterThan(ids1[1]);

    const page2 = await api.get(`/audit-log?limit=2&entity=area&before=${page1.body.nextBefore}`);
    const ids2 = page2.body.items.map((r: { id: number }) => r.id);
    expect(Math.max(...ids2)).toBeLessThan(ids1[1]);
    expect(page2.body.items.every((r: { entity: string }) => r.entity === 'area')).toBe(true);

    const filtered = await api.get('/audit-log?action=ROLE_CREATE');
    expect(filtered.body.items.every((r: { action: string }) => r.action === 'ROLE_CREATE')).toBe(
      true,
    );
    expect((await api.get('/audit-log?limit=0')).status).toBe(400);
  });

  it('branch users only see their own branch; the viewer is read-only', async () => {
    const mgr2 = (await t.login('MANAGER2')).token;
    // manager2 has no audit access scoped to branch 1 data
    const res = await t.as(mgr2).get('/audit-log?limit=200');
    expect(res.status).toBe(200);
    expect(
      res.body.items.every((r: { branch_id: string | null }) => r.branch_id === t.otherBranchId),
    ).toBe(true);

    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const agent = request(t.app);
      const r = await agent[method]('/api/v1/audit-log').set('Authorization', `Bearer ${owner}`);
      expect(r.status).toBe(404);
    }
  });

  it('rows themselves are append-only at the database level', async () => {
    const row = await t.kdb.selectFrom('audit_log').select('id').limit(1).executeTakeFirstOrThrow();
    await expect(
      t.kdb.updateTable('audit_log').set({ action: 'X' }).where('id', '=', row.id).execute(),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      t.kdb.deleteFrom('audit_log').where('id', '=', row.id).execute(),
    ).rejects.toMatchObject({ code: '23001' });
  });
});
