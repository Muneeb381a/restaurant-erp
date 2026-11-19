import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from './app-harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let t: TestApp;
let manager: string;
let cashier: string;
let accountant: string;
let emp: Json;
const types: Record<string, Json> = {};
const api = (tok: string) => t.as(tok);

const ask = (over: Json = {}, tok = manager) =>
  api(tok).post('/leave-requests', {
    employeeId: emp.id,
    leaveTypeId: types.ANNUAL.id,
    from: '2026-09-07', // a Monday
    to: '2026-09-09',
    ...over,
  });
const balance = async (code: string, year = 2026): Promise<Json> => {
  const r = (await api(manager).get(`/leave-balances?year=${year}&employeeId=${emp.id}`)).body;
  return r.employees[0].balances[types[code].id];
};
const dayStatus = async (date: string): Promise<string | undefined> =>
  (
    await t.kdb
      .selectFrom('attendance')
      .select('status')
      .where('employee_id', '=', emp.id)
      .where('work_date', '=', date)
      .executeTakeFirst()
  )?.status;

beforeAll(async () => {
  t = await startApp();
  manager = (await t.login('MANAGER')).token;
  cashier = (await t.login('CASHIER')).token;
  accountant = (await t.login('ACCOUNTANT')).token;
  emp = (
    await api(manager).post('/employees', {
      fullName: 'Leave Person',
      joinDate: '2026-01-01',
      weeklyOff: [5],
    })
  ).body;
  for (const ty of (await api(manager).get('/leave-types')).body.items) types[ty.code] = ty;
});
afterAll(async () => {
  await t.stop();
});

describe('leave types', () => {
  it('start with four kinds and NO allowance filled in (that is a legal question)', () => {
    expect(Object.keys(types).sort()).toEqual(['ANNUAL', 'CASUAL', 'SICK', 'UNPAID']);
    expect(types.ANNUAL.allowanceHalfDays).toBeNull();
    expect(types.ANNUAL.paid).toBe(true);
    expect(types.UNPAID.paid).toBe(false);
  });
  it('the owner can set an allowance and add a kind; permissions are checked', async () => {
    const up = await api(manager).patch(`/leave-types/${types.CASUAL.id}`, {
      allowanceHalfDays: 20,
    });
    expect(up.body.allowanceHalfDays).toBe(20);
    types.CASUAL = up.body;
    const mk = await api(manager).post('/leave-types', {
      code: 'HAJJ',
      name: 'Hajj leave',
      paid: false,
      allowanceHalfDays: null,
      allowNegative: false,
      isActive: true,
    });
    expect(mk.status, JSON.stringify(mk.body)).toBe(201);
    expect((await api(manager).post('/leave-types', { code: 'HAJJ', name: 'again' })).status).toBe(
      409,
    );
    expect((await api(accountant).get('/leave-types')).status).toBe(200);
    expect(
      (await api(accountant).patch(`/leave-types/${types.CASUAL.id}`, { paid: false })).status,
    ).toBe(403);
    expect((await api(cashier).get('/leave-types')).status).toBe(403);
  });
});

describe('requests', () => {
  it('count only working days: a Friday off and a holiday inside the range are not used', async () => {
    await api(manager).post('/holidays', { date: '2026-09-15', name: 'Test holiday' }); // a Tuesday
    // Mon 14 .. Mon 21: Mon, (Tue 15 holiday), Wed, Thu, (Fri 18 off), Sat, Sun, Mon = 6 days
    const r = await ask({ from: '2026-09-14', to: '2026-09-21', leaveTypeId: types.UNPAID.id });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.halfDays).toBe(12);
    expect(r.body.status).toBe('PENDING');
    await api(manager).post(`/leave-requests/${r.body.id}/cancel`, { note: 'test cleanup' });
  });

  it('refuse leave that is all days off, crosses a year, or is for someone not employed', async () => {
    expect((await ask({ from: '2026-09-11', to: '2026-09-11' })).status).toBe(400); // a Friday
    expect((await ask({ from: '2026-12-30', to: '2027-01-02' })).status).toBe(400);
    const early = await ask({ from: '2025-12-01', to: '2025-12-02' });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('NOT_EMPLOYED_ON_DATE');
  });

  it('approving writes LEAVE into attendance; that day can no longer be marked or clocked', async () => {
    const r = await ask({ from: '2026-09-07', to: '2026-09-09', approve: true });
    expect(r.body.status).toBe('APPROVED');
    expect(await dayStatus('2026-09-08')).toBe('LEAVE');
    const locked = await api(manager).put(`/attendance/${emp.id}/2026-09-08`, {
      status: 'PRESENT',
    });
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe('LEAVE_ATTENDANCE_LOCKED');
    const month = (await api(manager).get('/attendance/month?month=2026-09')).body;
    expect(month.employees.find((e: Json) => e.id === emp.id).summary.leave).toBe(3);
    const rows = await t.kdb
      .selectFrom('audit_log')
      .select('action')
      .where('action', 'in', ['LEAVE_REQUEST', 'LEAVE_APPROVE'])
      .execute();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    types.leaveId = { id: r.body.id };
  });

  it('refuse overlapping leave', async () => {
    const dup = await ask({ from: '2026-09-09', to: '2026-09-10' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('LEAVE_OVERLAP');
  });

  it('cancelling needs a reason and takes the days out of attendance again', async () => {
    const id = types.leaveId.id;
    expect((await api(manager).post(`/leave-requests/${id}/cancel`, {})).status).toBe(400);
    const c = await api(manager).post(`/leave-requests/${id}/cancel`, { note: 'plans changed' });
    expect(c.body.status).toBe('CANCELLED');
    expect(await dayStatus('2026-09-08')).toBeUndefined();
    expect(
      (await api(manager).post(`/leave-requests/${id}/cancel`, { note: 'again' })).status,
    ).toBe(409);
    expect(
      (await api(manager).put(`/attendance/${emp.id}/2026-09-08`, { status: 'PRESENT' })).status,
    ).toBe(200);
  });

  it('an approval cannot overwrite a day they were present', async () => {
    const r = await ask({ from: '2026-09-08', to: '2026-09-08' }); // marked PRESENT above
    expect(r.status).toBe(201);
    const ok = await api(manager).post(`/leave-requests/${r.body.id}/approve`, {});
    expect(ok.status).toBe(409);
    expect(ok.body.code).toBe('LEAVE_OVERLAPS_ATTENDANCE');
    // rejection needs a reason, and a decided request cannot be decided again
    expect((await api(manager).post(`/leave-requests/${r.body.id}/reject`, {})).status).toBe(400);
    const rej = await api(manager).post(`/leave-requests/${r.body.id}/reject`, {
      note: 'busy day',
    });
    expect(rej.body.status).toBe('REJECTED');
    expect((await api(manager).post(`/leave-requests/${r.body.id}/approve`, {})).status).toBe(409);
  });

  it('a half day is written as a half day, and counts one unit', async () => {
    const r = await ask({
      from: '2026-09-22',
      to: '2026-09-22',
      half: true,
      approve: true,
      leaveTypeId: types.SICK.id,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.halfDays).toBe(1);
    expect(await dayStatus('2026-09-22')).toBe('HALF_DAY');
    expect((await balance('SICK')).used).toBe(1);
  });

  it('only people with leave.manage can enter or decide leave', async () => {
    expect((await ask({}, accountant)).status).toBe(403);
    expect((await ask({}, cashier)).status).toBe(403);
    expect((await api(accountant).get('/leave-requests')).status).toBe(200);
  });
});

describe('balances', () => {
  it('a limited kind refuses more than is left, counting what is still waiting', async () => {
    // CASUAL has 20 half-days = 10 days. Take 4 days approved, 4 days waiting: 2 days left.
    expect(
      (
        await ask({
          leaveTypeId: types.CASUAL.id,
          from: '2026-10-05',
          to: '2026-10-08',
          approve: true,
        })
      ).status,
    ).toBe(201);
    expect(
      (await ask({ leaveTypeId: types.CASUAL.id, from: '2026-10-12', to: '2026-10-15' })).status,
    ).toBe(201);
    const b = await balance('CASUAL', 2026);
    expect(b).toMatchObject({
      allowance: 20,
      used: 8,
      pending: 8,
      remaining: 12,
      remainingAfterPending: 4,
    });
    const over = await ask({ leaveTypeId: types.CASUAL.id, from: '2026-10-19', to: '2026-10-22' }); // 8 > 4
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('LEAVE_BALANCE_EXCEEDED');
    expect(
      (await ask({ leaveTypeId: types.CASUAL.id, from: '2026-10-19', to: '2026-10-20' })).status,
    ).toBe(201); // 4 == 4
  });

  it('an unlimited kind never refuses', async () => {
    const r = await ask({ leaveTypeId: types.ANNUAL.id, from: '2026-11-02', to: '2026-11-28' });
    expect(r.status).toBe(201);
    expect((await balance('ANNUAL', 2026)).remaining).toBeNull();
  });

  it('an adjustment (opening balance) adds to what is left; it is append-only and needs a reason', async () => {
    const before = (await balance('CASUAL', 2027)).remaining;
    expect(before).toBe(20);
    const adj = await api(manager).post('/leave-adjustments', {
      employeeId: emp.id,
      leaveTypeId: types.CASUAL.id,
      year: 2027,
      halfDays: 6,
      reason: 'carried from last year',
    });
    expect(adj.status, JSON.stringify(adj.body)).toBe(201);
    expect((await balance('CASUAL', 2027)).remaining).toBe(26);
    expect(
      (
        await api(manager).post('/leave-adjustments', {
          employeeId: emp.id,
          leaveTypeId: types.CASUAL.id,
          year: 2027,
          halfDays: 2,
        })
      ).status,
    ).toBe(400);
    await expect(t.kdb.deleteFrom('leave_adjustments').execute()).rejects.toThrow(/append-only/);
  });
});
