import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from './app-harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let t: TestApp;
let owner: string;
let manager: string;
let cashier: string;
let waiter: string;
let accountant: string;
const api = (tok: string) => t.as(tok);

const person = (over: Json = {}): Json => ({
  fullName: 'Bilal Ahmed',
  joinDate: '2026-01-01',
  designation: 'Cook',
  department: 'KITCHEN',
  payType: 'MONTHLY',
  basePayPaisa: 3_500_000,
  weeklyOff: [5],
  shiftStart: '10:00',
  shiftEnd: '22:00',
  ...over,
});

beforeAll(async () => {
  t = await startApp();
  owner = (await t.login('OWNER')).token;
  manager = (await t.login('MANAGER')).token;
  cashier = (await t.login('CASHIER')).token;
  waiter = (await t.login('CAPTAIN')).token;
  accountant = (await t.login('ACCOUNTANT')).token;
});
afterAll(async () => {
  await t.stop();
});

describe('employees', () => {
  it('are created with the next staff number; the PIN hash never leaves the server', async () => {
    const a = await api(manager).post('/employees', person());
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body.code).toBe('E001');
    expect(a.body.hasPin).toBe(false);
    const b = await api(manager).post('/employees', person({ fullName: 'Sana' }));
    expect(b.body.code).toBe('E002');
    expect(JSON.stringify(a.body)).not.toMatch(/pin_hash|pinHash/);
    const list = await api(accountant).get('/employees');
    expect(list.body.items.map((e: Json) => e.code)).toEqual(['E001', 'E002']);
  });

  it('need the right permission: the accountant can look, the cashier cannot see or change', async () => {
    expect((await api(accountant).post('/employees', person())).status).toBe(403);
    expect((await api(cashier).get('/employees')).status).toBe(403);
    expect((await api(waiter).get('/employees')).status).toBe(403);
  });

  it('refuse a repeated staff number, someone leaving without a day, and a half-set shift', async () => {
    const dup = await api(manager).post('/employees', person({ code: 'E001' }));
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('EMPLOYEE_CODE_TAKEN');
    const left = await api(manager).post('/employees', person({ status: 'LEFT' }));
    expect(left.status).toBe(400);
    const shift = await api(manager).post('/employees', person({ shiftEnd: null }));
    expect(shift.status).toBe(400);
  });

  it('a pay change is audited as such, and nothing can delete a person', async () => {
    const [e] = (await api(manager).get('/employees')).body.items;
    const res = await api(manager).patch(`/employees/${e.id}`, { basePayPaisa: 4_000_000 });
    expect(res.body.basePayPaisa).toBe(4_000_000);
    const rows = await t.kdb
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'EMPLOYEE_PAY_CHANGE')
      .execute();
    expect(rows).toHaveLength(1);
    expect((await api(owner).delete(`/employees/${e.id}`)).status).toBe(404);
  });

  it('staff of another branch are not visible', async () => {
    const other = await t.login('MANAGER2');
    const list = await t.as(other.token, t.otherBranchId).get('/employees');
    expect(list.body.items).toEqual([]);
  });
});

describe('attendance', () => {
  let emp: Json;
  beforeAll(async () => {
    emp = (await api(manager).get('/employees')).body.items[0];
  });

  it('the day sheet lists who was employed that day, with what the calendar says', async () => {
    const fri = await api(manager).get('/attendance?date=2026-08-07'); // a Friday: weekly off
    expect(fri.body.items).toHaveLength(2);
    expect(fri.body.items[0].calendar).toBe('WEEKLY_OFF');
    expect(fri.body.items[0].record).toBeNull();
    const before = await api(manager).get('/attendance?date=2025-12-31'); // before anyone joined
    expect(before.body.items).toEqual([]);
  });

  it('late and overtime come from the usual hours, using the branch clock', async () => {
    const res = await api(manager).put(`/attendance/${emp.id}/2026-08-03`, {
      status: 'PRESENT',
      clockIn: '10:25',
      clockOut: '23:05',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.lateMinutes).toBe(25); // past the 10-minute grace: the whole 25 count
    expect(res.body.overtimeMinutes).toBe(65); // past the 30-minute threshold: all 65 count
    expect(res.body.workedMinutes).toBe(12 * 60 + 40);
    const ok = await api(manager).put(`/attendance/${emp.id}/2026-08-04`, {
      status: 'PRESENT',
      clockIn: '10:08',
      clockOut: '22:20',
    });
    expect(ok.body.lateMinutes).toBe(0);
    expect(ok.body.overtimeMinutes).toBe(0);
  });

  it('a correction replaces the day and is audited with what it was', async () => {
    await api(manager).put(`/attendance/${emp.id}/2026-08-05`, { status: 'ABSENT' });
    const fix = await api(manager).put(`/attendance/${emp.id}/2026-08-05`, {
      status: 'HALF_DAY',
      note: 'came at noon',
    });
    expect(fix.body.status).toBe('HALF_DAY');
    const rows = await t.kdb
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'ATTENDANCE_CHANGE')
      .execute();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const one = await t.kdb
      .selectFrom('attendance')
      .select('id')
      .where('employee_id', '=', emp.id)
      .where('work_date', '=', '2026-08-05')
      .execute();
    expect(one).toHaveLength(1);
  });

  it('refuses clock times on an absent day, a day before they joined, and leaving before arriving', async () => {
    expect(
      (
        await api(manager).put(`/attendance/${emp.id}/2026-08-06`, {
          status: 'ABSENT',
          clockIn: '10:00',
        })
      ).status,
    ).toBe(400);
    const early = await api(manager).put(`/attendance/${emp.id}/2025-12-01`, { status: 'PRESENT' });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('NOT_EMPLOYED_ON_DATE');
    expect(
      (
        await api(manager).put(`/attendance/${emp.id}/2026-08-06`, {
          status: 'PRESENT',
          clockIn: '12:00',
          clockOut: '11:00',
        })
      ).status,
    ).toBe(400);
  });

  it('a night shift ends the next morning and is measured against its own end', async () => {
    const n = (
      await api(manager).post(
        '/employees',
        person({ fullName: 'Night cook', shiftStart: '20:00', shiftEnd: '04:00', weeklyOff: [] }),
      )
    ).body;
    const res = await api(manager).put(`/attendance/${n.id}/2026-08-10`, {
      status: 'PRESENT',
      clockIn: '20:00',
      clockOut: '04:50',
      clockOutNextDay: true,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.workedMinutes).toBe(8 * 60 + 50);
    expect(res.body.overtimeMinutes).toBe(50);
  });

  it('"everyone is here" marks only people who have nothing marked yet', async () => {
    const all = (await api(manager).get('/employees')).body.items.map((e: Json) => e.id);
    const first = await api(manager).post('/attendance/bulk', {
      date: '2026-08-11',
      status: 'PRESENT',
      employeeIds: all,
    });
    expect(first.body.marked).toBe(all.length);
    const again = await api(manager).post('/attendance/bulk', {
      date: '2026-08-11',
      status: 'ABSENT',
      employeeIds: all,
    });
    expect(again.body.marked).toBe(0);
  });

  it('only people with attendance.mark can mark', async () => {
    expect(
      (await api(accountant).put(`/attendance/${emp.id}/2026-08-12`, { status: 'PRESENT' })).status,
    ).toBe(403);
    expect((await api(accountant).get('/attendance?date=2026-08-12')).status).toBe(200);
  });
});

describe('holidays and the month', () => {
  it('a holiday is a non-working day for everybody, and shows in the month', async () => {
    const h = await api(manager).post('/holidays', {
      date: '2026-08-14',
      name: 'Independence Day',
    });
    expect(h.status).toBe(201);
    expect(
      (await api(manager).post('/holidays', { date: '2026-08-14', name: 'again' })).body.code,
    ).toBe('HOLIDAY_EXISTS');
    const sheet = await api(manager).get('/attendance?date=2026-08-14');
    expect(sheet.body.items.every((i: Json) => i.calendar === 'HOLIDAY')).toBe(true);

    const m = await api(manager).get('/attendance/month?month=2026-08');
    expect(m.body.days).toHaveLength(31);
    expect(m.body.holidays).toEqual(['2026-08-14']);
    const bilal = m.body.employees.find((e: Json) => e.code === 'E001');
    expect(bilal.summary).toMatchObject({
      present: 3,
      halfDays: 1,
      lateCount: 1,
      lateMinutes: 25,
      overtimeMinutes: 65,
    });
    expect(bilal.summary.holidays).toBe(1);
    expect(bilal.days.find((d: Json) => d.date === '2026-08-03').status).toBe('PRESENT');
    expect(bilal.days.find((d: Json) => d.date === '2026-08-07').status).toBe('WEEKLY_OFF');

    expect((await api(manager).delete(`/holidays/${h.body.id}`)).status).toBe(204);
  });
});

describe('the clock-in / clock-out screen', () => {
  let emp: Json;
  beforeAll(async () => {
    emp = (
      await api(manager).post(
        '/employees',
        person({ fullName: 'Kiosk Person', shiftStart: null, shiftEnd: null, weeklyOff: [] }),
      )
    ).body;
    expect((await api(manager).put(`/employees/${emp.id}/pin`, { pin: '2468' })).status).toBe(204);
  });

  it('lists only people with a PIN, to the cashier who runs the screen', async () => {
    const list = await api(cashier).get('/attendance-clock');
    expect(list.body.items.map((i: Json) => i.fullName)).toEqual(['Kiosk Person']);
    expect(list.body.items[0].state).toBe('OUT');
    expect((await api(waiter).get('/attendance-clock')).status).toBe(403);
  });

  it('a wrong PIN is a 400 (never 401), counts, and five of them lock the person for five minutes', async () => {
    for (let i = 0; i < 5; i++) {
      const bad = await api(cashier).post('/attendance-clock', { employeeId: emp.id, pin: '0000' });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('PIN_WRONG');
    }
    const locked = await api(cashier).post('/attendance-clock', {
      employeeId: emp.id,
      pin: '2468',
    });
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('PIN_LOCKED');
    t.clock.advance(5 * 60_000 + 1000);
    const ok = await api(cashier).post('/attendance-clock', { employeeId: emp.id, pin: '2468' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.action).toBe('IN');
  });

  it('the next correct PIN clocks them out, with the hours worked; a third time is refused', async () => {
    t.clock.advance(4 * 3_600_000);
    cashier = (await t.login('CASHIER')).token; // the access token lasts 15 minutes of the test clock
    manager = (await t.login('MANAGER')).token;
    const out = await api(cashier).post('/attendance-clock', { employeeId: emp.id, pin: '2468' });
    expect(out.body.action, JSON.stringify(out.body)).toBe('OUT');
    expect(out.body.workedMinutes).toBe(240);
    const third = await api(cashier).post('/attendance-clock', { employeeId: emp.id, pin: '2468' });
    // already out today and nothing open: not a new shift
    expect(third.status).toBe(409);
    expect(third.body.code).toBe('ALREADY_CLOCKED_OUT');
    const rows = await t.kdb
      .selectFrom('audit_log')
      .select('action')
      .where('action', 'in', ['ATTENDANCE_CLOCK_IN', 'ATTENDANCE_CLOCK_OUT'])
      .execute();
    expect(rows.map((r) => r.action).sort()).toEqual([
      'ATTENDANCE_CLOCK_IN',
      'ATTENDANCE_CLOCK_OUT',
    ]);
  });

  it('the PIN itself is never in the audit log, and clearing it removes the person from the screen', async () => {
    const all = JSON.stringify(await t.kdb.selectFrom('audit_log').selectAll().execute());
    expect(all).not.toContain('2468');
    await api(manager).delete(`/employees/${emp.id}/pin`);
    expect((await api(cashier).get('/attendance-clock')).body.items).toEqual([]);
  });
});
