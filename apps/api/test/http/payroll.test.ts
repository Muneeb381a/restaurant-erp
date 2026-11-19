import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from './app-harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let t: TestApp;
let owner: string;
let manager: string;
let accountant: string;
let cashier: string;
let monthly: Json;
let daily: Json;
let run: Json;
const api = (tok: string) => t.as(tok);
const julyDays = Array.from({ length: 31 }, (_, i) => `2026-07-${String(i + 1).padStart(2, '0')}`);
let keySeq = 0;
const key = () => `payroll-key-${Date.now()}-${++keySeq}`;
const slipOf = (r: Json, code: string): Json => r.slips.find((s: Json) => s.code === code);
const lineOf = (s: Json, code: string): Json => s.lines.find((l: Json) => l.code === code);
const get = async (id: string): Promise<Json> =>
  (await api(manager).get(`/payroll-runs/${id}`)).body;

beforeAll(async () => {
  t = await startApp();
  owner = (await t.login('OWNER')).token;
  manager = (await t.login('MANAGER')).token;
  accountant = (await t.login('ACCOUNTANT')).token;
  cashier = (await t.login('CASHIER')).token;
  monthly = (
    await api(manager).post('/employees', {
      fullName: 'Monthly Cook',
      joinDate: '2026-01-01',
      payType: 'MONTHLY',
      basePayPaisa: 3_000_000,
      weeklyOff: [5],
    })
  ).body;
  daily = (
    await api(manager).post('/employees', {
      fullName: 'Daily Helper',
      joinDate: '2026-01-01',
      payType: 'DAILY',
      basePayPaisa: 150_000,
      payFrequency: 'MONTHLY',
      weeklyOff: [],
    })
  ).body;
});
afterAll(async () => {
  await t.stop();
});

describe('creating a draft run', () => {
  it('lists everybody paid monthly, and refuses a second run for the same period', async () => {
    const r = await api(manager).post('/payroll-runs', { frequency: 'MONTHLY', month: '2026-07' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    run = r.body;
    const d = await get(run.id);
    expect(d.status).toBe('DRAFT');
    expect(d.slips.map((s: Json) => s.code)).toEqual(['E001', 'E002']);
    expect(
      (await api(manager).post('/payroll-runs', { frequency: 'MONTHLY', month: '2026-07' })).body
        .code,
    ).toBe('PAYROLL_RUN_EXISTS');
  });

  it('days nobody marked are docked in the draft and block approval', async () => {
    const d = await get(run.id);
    expect(slipOf(d, 'E001').tally.unmarkedHalf).toBeGreaterThan(0);
    expect(slipOf(d, 'E001').warnings).toContain('UNMARKED_DAYS');
    const res = await api(owner).post(`/payroll-runs/${run.id}/approve`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PAYROLL_NOT_READY');
    expect(res.body.problems.some((p: Json) => p.issue === 'UNMARKED_DAYS')).toBe(true);
  });

  it('the permissions are split: the cashier sees nothing, the manager prepares but cannot approve', async () => {
    expect((await api(cashier).get('/payroll-runs')).status).toBe(403);
    expect((await api(accountant).get('/payroll-runs')).status).toBe(200);
    expect((await api(manager).post(`/payroll-runs/${run.id}/approve`)).status).toBe(403);
  });
});

describe('working out the pay', () => {
  beforeAll(async () => {
    for (const d of julyDays)
      await api(manager).post('/attendance/bulk', {
        date: d,
        status: 'PRESENT',
        employeeIds: [monthly.id, daily.id],
      });
    // two absences for the monthly cook
    for (const d of ['2026-07-06', '2026-07-07'])
      await api(manager).put(`/attendance/${monthly.id}/${d}`, { status: 'ABSENT' });
  });

  it('salary minus absence at salary / 30 per day; daily wages = paid days x rate', async () => {
    await api(manager).post(`/payroll-runs/${run.id}/recalculate`);
    const d = await get(run.id);
    const m = slipOf(d, 'E001');
    expect(lineOf(m, 'BASIC').amountPaisa).toBe(3_000_000);
    expect(lineOf(m, 'ABSENCE').amountPaisa).toBe(200_000);
    expect(m.netPaisa).toBe(2_800_000);
    const w = slipOf(d, 'E002');
    expect(lineOf(w, 'BASIC').amountPaisa).toBe(31 * 150_000);
    expect(w.netPaisa).toBe(4_650_000);
    expect(m.warnings).toEqual([]);
  });

  it('overtime is not paid unless the owner switched it on', async () => {
    const d = await get(run.id);
    expect(lineOf(slipOf(d, 'E001'), 'OVERTIME')).toBeUndefined();
  });

  it('a recurring allowance and a manual bonus change the net; manual lines can be removed, others cannot', async () => {
    const item = await api(manager).post(`/employees/${monthly.id}/pay-items`, {
      kind: 'ALLOWANCE',
      name: 'Transport',
      amountPaisa: 50_000,
    });
    expect(item.status, JSON.stringify(item.body)).toBe(201);
    await api(manager).post(`/payroll-runs/${run.id}/recalculate`);
    let d = await get(run.id);
    expect(slipOf(d, 'E001').netPaisa).toBe(2_850_000);

    const bonus = await api(manager).post(`/payslips/${slipOf(d, 'E001').id}/lines`, {
      kind: 'EARNING',
      label: 'Eid bonus',
      amountPaisa: 100_000,
    });
    expect(bonus.status).toBe(201);
    d = await get(run.id);
    expect(slipOf(d, 'E001').netPaisa).toBe(2_950_000);
    // a recalculation keeps the manual line
    await api(manager).post(`/payroll-runs/${run.id}/recalculate`);
    d = await get(run.id);
    expect(slipOf(d, 'E001').netPaisa).toBe(2_950_000);
    // only manual lines can be removed
    const basic = lineOf(slipOf(d, 'E001'), 'BASIC');
    expect((await api(manager).delete(`/payslip-lines/${basic.id}`)).status).toBe(400);
    const extra = await api(manager).post(`/payslips/${slipOf(d, 'E001').id}/lines`, {
      kind: 'DEDUCTION',
      label: 'Mistake',
      amountPaisa: 1,
    });
    expect((await api(manager).delete(`/payslip-lines/${extra.body.id}`)).status).toBe(204);
    expect((await get(run.id)).slips[0].netPaisa).toBe(2_950_000);
  });
});

describe('approval locks everything', () => {
  it('the owner approves; then nothing in the run, its attendance or its holidays can change', async () => {
    const ok = await api(owner).post(`/payroll-runs/${run.id}/approve`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ people: 2, netPaisa: 2_950_000 + 4_650_000 });

    const att = await api(manager).put(`/attendance/${monthly.id}/2026-07-10`, {
      status: 'ABSENT',
    });
    expect(att.status).toBe(409);
    expect(att.body.code).toBe('PAYROLL_PERIOD_LOCKED');
    expect(
      (await api(manager).post('/holidays', { date: '2026-07-14', name: 'Late holiday' })).body
        .code,
    ).toBe('PAYROLL_PERIOD_LOCKED');
    // a day outside the run is still free
    expect(
      (await api(manager).put(`/attendance/${monthly.id}/2026-08-01`, { status: 'PRESENT' }))
        .status,
    ).toBe(200);

    const d = await get(run.id);
    const slip = slipOf(d, 'E001');
    expect(
      (
        await api(manager).post(`/payslips/${slip.id}/lines`, {
          kind: 'EARNING',
          label: 'late',
          amountPaisa: 5,
        })
      ).body.code,
    ).toBe('PAYROLL_NOT_EDITABLE');
    expect((await api(manager).post(`/payroll-runs/${run.id}/recalculate`)).body.code).toBe(
      'PAYROLL_NOT_EDITABLE',
    );
    expect(
      (await api(manager).post(`/payroll-runs/${run.id}/cancel`, { reason: 'x' })).body.code,
    ).toBe('PAYROLL_NOT_EDITABLE');
  });

  it('the database itself refuses edits to an approved run, its payslips and its lines', async () => {
    const d = await get(run.id);
    const slip = slipOf(d, 'E001');
    await expect(
      t.kdb.updateTable('payslips').set({ net_paisa: 1 }).where('id', '=', slip.id).execute(),
    ).rejects.toThrow(/cannot change/);
    await expect(
      t.kdb.deleteFrom('payslip_lines').where('payslip_id', '=', slip.id).execute(),
    ).rejects.toThrow(/cannot change/);
    await expect(
      t.kdb.deleteFrom('payroll_runs').where('id', '=', run.id).execute(),
    ).rejects.toThrow(/never deleted/);
    await expect(
      t.kdb.updateTable('payroll_runs').set({ note: 'edit' }).where('id', '=', run.id).execute(),
    ).rejects.toThrow(/can no longer change/);
  });

  it('a pay run cannot be approved before its period has ended', async () => {
    const aug = await api(manager).post('/payroll-runs', {
      frequency: 'MONTHLY',
      month: '2026-08',
    });
    expect(aug.status).toBe(201);
    const res = await api(owner).post(`/payroll-runs/${aug.body.id}/approve`);
    expect(res.body.code).toBe('PAYROLL_NOT_READY');
    expect(res.body.problems.some((p: Json) => p.issue === 'PERIOD_NOT_FINISHED')).toBe(true);
    // a draft can be cancelled with a reason, and the period is free again
    expect((await api(manager).post(`/payroll-runs/${aug.body.id}/cancel`, {})).status).toBe(400);
    expect(
      (await api(manager).post(`/payroll-runs/${aug.body.id}/cancel`, { reason: 'too early' }))
        .status,
    ).toBe(204);
    expect(
      (await api(manager).post('/payroll-runs', { frequency: 'MONTHLY', month: '2026-08' })).status,
    ).toBe(201);
  });
});

describe('paying salary', () => {
  let slip: Json;
  beforeAll(async () => {
    slip = slipOf(await get(run.id), 'E001');
  });

  it('is split by permission, and needs an Idempotency-Key', async () => {
    expect(
      (
        await api(manager)
          .post(`/payslips/${slip.id}/pay`, { paidFrom: 'BANK' })
          .set('Idempotency-Key', key())
      ).status,
    ).toBe(403);
    expect(
      (await api(accountant).post(`/payslips/${slip.id}/pay`, { paidFrom: 'BANK' })).status,
    ).toBe(400);
  });

  it('a part payment goes into the SALARY expenses once, even if the request is repeated', async () => {
    const k = key();
    const first = await api(accountant)
      .post(`/payslips/${slip.id}/pay`, { amountPaisa: 1_000_000, paidFrom: 'BANK' })
      .set('Idempotency-Key', k);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.remainingPaisa).toBe(1_950_000);
    const again = await api(accountant)
      .post(`/payslips/${slip.id}/pay`, { amountPaisa: 1_000_000, paidFrom: 'BANK' })
      .set('Idempotency-Key', k);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    const exp = await t.kdb
      .selectFrom('expenses')
      .selectAll()
      .where('category', '=', 'SALARY')
      .execute();
    expect(exp).toHaveLength(1);
    expect(exp[0]!.amount_paisa).toBe(1_000_000);
    expect(exp[0]!.note).toContain('E001');
  });

  it('refuses more than is still owed, then pays the rest, then nothing is left', async () => {
    const over = await api(accountant)
      .post(`/payslips/${slip.id}/pay`, { amountPaisa: 2_000_000, paidFrom: 'BANK' })
      .set('Idempotency-Key', key());
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('PAYROLL_OVERPAYMENT');
    const rest = await api(accountant)
      .post(`/payslips/${slip.id}/pay`, { paidFrom: 'OWNER_CASH' })
      .set('Idempotency-Key', key());
    expect(rest.status, JSON.stringify(rest.body)).toBe(201);
    expect(rest.body.remainingPaisa).toBe(0);
    expect(
      (
        await api(accountant)
          .post(`/payslips/${slip.id}/pay`, { paidFrom: 'BANK' })
          .set('Idempotency-Key', key())
      ).body.code,
    ).toBe('PAYROLL_OVERPAYMENT');
    const d = await get(run.id);
    expect(slipOf(d, 'E001').paidPaisa).toBe(2_950_000);
    const list = (await api(accountant).get('/payroll-runs')).body.items.find(
      (r: Json) => r.id === run.id,
    );
    expect(list).toMatchObject({ status: 'APPROVED', netPaisa: 7_600_000, paidPaisa: 2_950_000 });
  });

  it('payments cannot be edited or removed, and the database refuses an overpayment', async () => {
    await expect(t.kdb.deleteFrom('payroll_payments').execute()).rejects.toThrow(/append-only/);
    const other = slipOf(await get(run.id), 'E002');
    const exp = await t.kdb
      .insertInto('expenses')
      .values({
        branch_id: t.branchId,
        category: 'SALARY',
        amount_paisa: other.netPaisa + 1,
        paid_from: 'BANK',
        created_by: (
          await t.kdb.selectFrom('users').select('id').limit(1).executeTakeFirstOrThrow()
        ).id,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await expect(
      t.kdb
        .insertInto('payroll_payments')
        .values({
          branch_id: t.branchId,
          payslip_id: other.id,
          amount_paisa: other.netPaisa + 1,
          paid_from: 'BANK',
          expense_id: exp.id,
          paid_by: (await t.kdb.selectFrom('users').select('id').limit(1).executeTakeFirstOrThrow())
            .id,
          idempotency_key: key(),
        })
        .execute(),
    ).rejects.toThrow(/exceed the net pay/);
  });

  it('the audit log has the whole story', async () => {
    const actions = (await t.kdb.selectFrom('audit_log').select('action').execute()).map(
      (r) => r.action,
    );
    for (const a of [
      'PAYROLL_RUN_CREATE',
      'PAYROLL_RUN_APPROVE',
      'PAYROLL_PAY',
      'PAYROLL_LINE_ADD',
      'PAY_ITEM_ADD',
    ])
      expect(actions).toContain(a);
  });
});
