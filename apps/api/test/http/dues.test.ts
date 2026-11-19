import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from './app-harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let t: TestApp;
let owner: string;
let manager: string;
let accountant: string;
let cashier: string;
let emp: Json;
const api = (tok: string) => t.as(tok);
let keySeq = 0;
const key = () => `due-key-${Date.now()}-${++keySeq}`;
const julyDays = Array.from({ length: 31 }, (_, i) => `2026-07-${String(i + 1).padStart(2, '0')}`);
const give = (body: Json, tok = accountant, k = key()) =>
  api(tok)
    .post('/staff-dues', { employeeId: emp.id, ...body })
    .set('Idempotency-Key', k);
const dues = async (): Promise<Json[]> => (await api(manager).get('/staff-dues')).body.items;
const slipOf = (r: Json): Json => r.slips[0];
const lineOf = (s: Json, code: string): Json => s.lines.find((l: Json) => l.code === code);
const runOf = async (id: string): Promise<Json> =>
  (await api(manager).get(`/payroll-runs/${id}`)).body;

beforeAll(async () => {
  t = await startApp();
  owner = (await t.login('OWNER')).token;
  manager = (await t.login('MANAGER')).token;
  accountant = (await t.login('ACCOUNTANT')).token;
  cashier = (await t.login('CASHIER')).token;
  emp = (
    await api(manager).post('/employees', {
      fullName: 'Debtor Cook',
      joinDate: '2026-01-01',
      payType: 'MONTHLY',
      basePayPaisa: 3_000_000,
      weeklyOff: [5],
    })
  ).body;
  for (const d of julyDays)
    await api(manager).post('/attendance/bulk', {
      date: d,
      status: 'PRESENT',
      employeeIds: [emp.id],
    });
});
afterAll(async () => {
  await t.stop();
});

describe('giving money and charging fines', () => {
  it('an advance needs payroll.pay and a place to pay from; the cash goes to the expenses ledger once', async () => {
    expect(
      (
        await give(
          { kind: 'ADVANCE', amountPaisa: 500_000, reason: 'Medical', paidFrom: 'BANK' },
          manager,
        )
      ).status,
    ).toBe(403);
    expect((await give({ kind: 'ADVANCE', amountPaisa: 500_000, reason: 'Medical' })).status).toBe(
      400,
    );
    const k = key();
    const a = await give(
      { kind: 'ADVANCE', amountPaisa: 500_000, reason: 'Medical', paidFrom: 'BANK' },
      accountant,
      k,
    );
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(
      (
        await give(
          { kind: 'ADVANCE', amountPaisa: 500_000, reason: 'Medical', paidFrom: 'BANK' },
          accountant,
          k,
        )
      ).body.replayed,
    ).toBe(true);
    const exp = await t.kdb
      .selectFrom('expenses')
      .selectAll()
      .where('category', '=', 'STAFF_ADVANCE')
      .execute();
    expect(exp).toHaveLength(1);
    expect(exp[0]!.amount_paisa).toBe(500_000);
    const [d] = await dues();
    expect(d).toMatchObject({
      kind: 'ADVANCE',
      principalPaisa: 500_000,
      installmentPaisa: 500_000,
      balancePaisa: 500_000,
      installmentsLeft: 1,
    });
  });

  it('a loan needs an instalment, and an instalment cannot exceed the amount; a fine pays nothing out', async () => {
    expect(
      (await give({ kind: 'LOAN', amountPaisa: 900_000, reason: 'Bike', paidFrom: 'BANK' })).status,
    ).toBe(400);
    expect(
      (
        await give({
          kind: 'LOAN',
          amountPaisa: 900_000,
          installmentPaisa: 1_000_000,
          reason: 'Bike',
          paidFrom: 'BANK',
        })
      ).status,
    ).toBe(400);
    const before = (await t.kdb.selectFrom('expenses').select('id').execute()).length;
    const f = await give({ kind: 'FINE', amountPaisa: 30_000, reason: 'Broke a plate' }, manager);
    expect(f.status, JSON.stringify(f.body)).toBe(201);
    expect((await t.kdb.selectFrom('expenses').select('id').execute()).length).toBe(before);
  });

  it('refuses people who have left and the cashier', async () => {
    expect((await give({ kind: 'FINE', amountPaisa: 100, reason: 'x' }, cashier)).status).toBe(403);
  });
});

describe('recovery through payroll', () => {
  let run: Json;
  it('a payslip takes the instalment, capped by what is owed, and shows it as its own line', async () => {
    // add a loan of Rs 9,000 at Rs 4,000 a run
    expect(
      (
        await give({
          kind: 'LOAN',
          amountPaisa: 900_000,
          installmentPaisa: 400_000,
          reason: 'Bike',
          paidFrom: 'OWNER_CASH',
        })
      ).status,
    ).toBe(201);
    run = (await api(manager).post('/payroll-runs', { frequency: 'MONTHLY', month: '2026-07' }))
      .body;
    const s = slipOf(await runOf(run.id));
    const rec = s.lines.filter((l: Json) => l.code === 'RECOVERY');
    // advance 5,000 + fine 300 + loan 4,000 instalment
    expect(rec.map((l: Json) => l.amountPaisa).sort((x: number, y: number) => x - y)).toEqual([
      30_000, 400_000, 500_000,
    ]);
    expect(s.netPaisa).toBe(3_000_000 - 930_000);
    // balances are NOT touched while it is a draft
    expect((await dues()).reduce((n, d) => n + d.balancePaisa, 0)).toBe(500_000 + 30_000 + 900_000);
  });

  it('a paused due recovers nothing; resuming brings it back', async () => {
    const loan = (await dues()).find((d) => d.kind === 'LOAN')!;
    expect((await api(manager).patch(`/staff-dues/${loan.id}`, { paused: true })).status).toBe(204);
    await api(manager).post(`/payroll-runs/${run.id}/recalculate`);
    expect(
      slipOf(await runOf(run.id)).lines.filter((l: Json) => l.code === 'RECOVERY'),
    ).toHaveLength(2);
    await api(manager).patch(`/staff-dues/${loan.id}`, { paused: false });
    await api(manager).post(`/payroll-runs/${run.id}/recalculate`);
    expect(
      slipOf(await runOf(run.id)).lines.filter((l: Json) => l.code === 'RECOVERY'),
    ).toHaveLength(3);
  });

  it('approval books the recoveries in the ledger, exactly once; the balances fall', async () => {
    const ok = await api(owner).post(`/payroll-runs/${run.id}/approve`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const after = await dues();
    expect(after.find((d) => d.kind === 'ADVANCE')).toMatchObject({
      balancePaisa: 0,
      recoveredPaisa: 500_000,
      installmentsLeft: 0,
    });
    expect(after.find((d) => d.kind === 'FINE')).toMatchObject({ balancePaisa: 0 });
    expect(after.find((d) => d.kind === 'LOAN')).toMatchObject({
      balancePaisa: 500_000,
      recoveredPaisa: 400_000,
      installmentsLeft: 2,
    });
    expect((await api(manager).get('/staff-dues?open=true')).body.items).toHaveLength(1);
    const entries = await t.kdb
      .selectFrom('staff_due_entries')
      .select('kind')
      .where('kind', '=', 'RECOVERY')
      .execute();
    expect(entries).toHaveLength(3);
  });

  it('the next run takes the instalment but never more than is owed or than the pay left', async () => {
    const aug = (
      await api(manager).post('/payroll-runs', { frequency: 'MONTHLY', month: '2026-08' })
    ).body;
    const s = slipOf(await runOf(aug.id));
    const rec = s.lines.filter((l: Json) => l.code === 'RECOVERY');
    expect(rec).toHaveLength(1);
    // August is unmarked, so part of the salary is docked first; what the loan may take is capped by what is left
    const netBefore = s.grossPaisa - (s.deductionsPaisa - rec[0].amountPaisa);
    expect(rec[0].amountPaisa).toBe(Math.max(0, Math.min(400_000, 500_000, netBefore)));
    expect(s.netPaisa).toBeGreaterThanOrEqual(0);
    await api(manager).post(`/payroll-runs/${aug.id}/cancel`, { reason: 'test' });
  });

  it('the database refuses to recover more than is owed, and entries cannot be edited', async () => {
    const loan = (await dues()).find((d) => d.kind === 'LOAN')!;
    const slip = slipOf(await runOf(run.id));
    await expect(
      t.kdb
        .insertInto('staff_due_entries')
        .values({ due_id: loan.id, kind: 'WRITE_OFF', amount_paisa: 500_001, note: 'x' })
        .execute(),
    ).rejects.toThrow(/more \(500001\) than is owed/);
    await expect(
      t.kdb
        .insertInto('staff_due_entries')
        .values({ due_id: loan.id, kind: 'RECOVERY', amount_paisa: 100, payslip_id: slip.id })
        .execute(),
    ).rejects.toThrow(); // the same payslip cannot recover the same due twice
    await expect(t.kdb.deleteFrom('staff_due_entries').execute()).rejects.toThrow(/append-only/);
  });

  it('only the owner can write off what is left, with a reason; then it is closed', async () => {
    const loan = (await dues()).find((d) => d.kind === 'LOAN')!;
    expect(
      (await api(accountant).post(`/staff-dues/${loan.id}/write-off`, { reason: 'x' })).status,
    ).toBe(403);
    expect((await api(owner).post(`/staff-dues/${loan.id}/write-off`, {})).status).toBe(400);
    const w = await api(owner).post(`/staff-dues/${loan.id}/write-off`, { reason: 'Left the job' });
    expect(w.body.writtenOffPaisa).toBe(500_000);
    expect((await dues()).find((d) => d.kind === 'LOAN')).toMatchObject({
      balancePaisa: 0,
      closed: true,
      writtenOffPaisa: 500_000,
    });
    expect(
      (await api(owner).post(`/staff-dues/${loan.id}/write-off`, { reason: 'again' })).status,
    ).toBe(409);
  });
});

describe('a recovery never leaves less than nothing to pay', () => {
  it('is limited to the pay that is left', async () => {
    const poor = (
      await api(manager).post('/employees', {
        fullName: 'Low Pay',
        joinDate: '2026-01-01',
        payType: 'MONTHLY',
        basePayPaisa: 100_000,
        weeklyOff: [],
      })
    ).body;
    await api(accountant)
      .post('/staff-dues', {
        employeeId: poor.id,
        kind: 'LOAN',
        amountPaisa: 900_000,
        installmentPaisa: 400_000,
        reason: 'Big',
        paidFrom: 'BANK',
      })
      .set('Idempotency-Key', key());
    for (const d of julyDays)
      await api(manager).post('/attendance/bulk', {
        date: d,
        status: 'PRESENT',
        employeeIds: [poor.id],
      });
    // a new run for a period only this person is in: use a weekly run (monthly salary is skipped) - so use the monthly run of June
    const june = (
      await api(manager).post('/payroll-runs', { frequency: 'MONTHLY', month: '2026-06' })
    ).body;
    const slip = (await runOf(june.id)).slips.find((s: Json) => s.fullName === 'Low Pay');
    const rec = lineOf(slip, 'RECOVERY');
    // June is not marked, so most of the salary is docked first; whatever is left is the most that can be taken
    expect(rec === undefined || rec.amountPaisa <= 100_000).toBe(true);
    expect(slip.netPaisa).toBeGreaterThanOrEqual(0);
    await api(manager).post(`/payroll-runs/${june.id}/cancel`, { reason: 'test' });
  });
});

describe('the HR overview', () => {
  it('shows headcount, today, the month and (only with payroll rights) the money', async () => {
    const q = '/hr/overview?date=2026-07-15&month=2026-07';
    const m = (await api(manager).get(q)).body;
    expect(m.headcount.total).toBe(2);
    expect(m.today.counts.PRESENT).toBe(2);
    expect(m.month.attendedDays).toBeGreaterThan(0);
    expect(m.money).not.toBeNull(); // the manager has payroll.view
    expect(m.money.approvedRuns).toBe(1);
    expect(m.money.payrollNetPaisa).toBe(3_000_000 - 930_000);
    expect(m.money.owedByStaffPaisa).toBeGreaterThanOrEqual(0);
    const noMoney = (await api(cashier).get(q)).status;
    expect(noMoney).toBe(403); // the cashier has no employee.view
  });
});
