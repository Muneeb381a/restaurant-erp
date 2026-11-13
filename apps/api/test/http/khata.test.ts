import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processPrintJobs, TcpTransport } from '../../src/modules/printing/print.service';
import { startApp, type TestApp } from './app-harness';
import { SimPrinter } from './sim-printer';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let t: TestApp;
let owner: string;
let manager: string;
let cashier: string;
let captain: string;
let item: { id: string; variantId: string };
let receiptSim: SimPrinter;
let shiftId: string;
const M: Record<string, string> = {};
const api = (tok: string) => t.as(tok);
const run = () => processPrintJobs(t.ctx, new TcpTransport());
const audit = (action: string) =>
  t.kdb.selectFrom('audit_log').selectAll().where('action', '=', action).orderBy('id').execute();
let keySeq = 0;
const key = () => `khata-key-${Date.now()}-${++keySeq}`;

let phoneSeq = 0;
async function newAccount(name: string, limit: number): Promise<string> {
  const res = await api(manager).post('/khata/accounts', {
    name,
    phone: `0300-1234${String(++phoneSeq).padStart(3, '0')}`,
    creditLimitPaisa: limit,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id;
}
/** A pre-billed Rs 1,000 bill (100000 paisa). */
async function bill(): Promise<Json> {
  const o = (await api(captain).post('/orders', { type: 'TAKEAWAY' })).body;
  await api(captain).post(`/orders/${o.id}/items`, { itemId: item.id, variantId: item.variantId });
  await api(captain).post(`/orders/${o.id}/send`, {});
  return (await api(cashier).post(`/orders/${o.id}/bill`)).body;
}
const settle = (billId: string, tenders: object[], tok = cashier) =>
  api(tok).post(`/bills/${billId}/settle`, { tenders }).set('Idempotency-Key', key());
const onKhata = (accountId: string, amountPaisa = 100000) => [
  { methodId: M.KHATA, amountPaisa, khataAccountId: accountId },
];
const collect = (accountId: string, body: object, tok = cashier, k = key()) =>
  api(tok).post(`/khata/accounts/${accountId}/payments`, body).set('Idempotency-Key', k);
const account = async (id: string): Promise<Json> =>
  (await api(manager).get(`/khata/accounts/${id}`)).body;
const shiftReport = async (): Promise<Json> =>
  (await api(manager).get(`/shifts/${shiftId}/report`)).body;

beforeAll(async () => {
  t = await startApp();
  owner = (await t.login('OWNER')).token;
  manager = (await t.login('MANAGER')).token;
  cashier = (await t.login('CASHIER')).token;
  captain = (await t.login('CAPTAIN')).token;

  const lists: { id: string }[] = [];
  for (const code of ['DINE_IN', 'TAKEAWAY', 'DELIVERY'])
    lists.push((await api(owner).post('/price-lists', { code, name: code })).body);
  const station = (await api(owner).post('/stations', { code: 'BBQ', name: 'BBQ' })).body.id;
  const res = await api(owner).post('/items', {
    kind: 'STANDARD',
    name: 'Tikka',
    stationId: station,
  });
  for (const l of lists)
    await api(owner).put(`/variants/${res.body.variants[0].id}/prices/${l.id}`, {
      pricePaisa: 100000,
    });
  item = { id: res.body.id, variantId: res.body.variants[0].id };
  const kot = await SimPrinter.start();
  const kp = (
    await api(owner).post('/printers', {
      name: 'kot',
      kind: 'KOT',
      conn_type: 'NETWORK',
      host: '127.0.0.1',
      port: kot.port,
    })
  ).body.id;
  await api(owner).put(`/stations/${station}/printers`, { printerIds: [kp] });
  receiptSim = await SimPrinter.start();
  await api(owner).post('/printers', {
    name: 'counter',
    kind: 'RECEIPT',
    conn_type: 'NETWORK',
    host: '127.0.0.1',
    port: receiptSim.port,
  });

  for (const [code, cls, extra] of [
    ['CASH', 'CASH_OTHER', { opens_drawer: true }],
    ['CARD', 'DIGITAL', { needs_reference: true }],
    ['KHATA', 'CASH_OTHER', {}],
  ] as const)
    M[code] = (
      await api(owner).post('/payment-methods', {
        code,
        name: code === 'KHATA' ? 'Khata' : code,
        tender_class: cls,
        ...extra,
      })
    ).body.id;
  await api(cashier).post('/business-days/open', {});
  const sh = await api(cashier).post('/shifts/open', { openingFloatPaisa: 500000 });
  shiftId = sh.body.id;
}, 240_000);

afterAll(async () => {
  await receiptSim.unplug();
  await t.stop();
});

describe('accounts', () => {
  it('a manager creates accounts and limits; cashiers can look but not create', async () => {
    expect(
      (await api(cashier).post('/khata/accounts', { name: 'Nope', creditLimitPaisa: 1 })).status,
    ).toBe(403);
    const id = await newAccount('Haji Rashid', 500000);
    await newAccount('Chaudhry Bilal', 100000);

    const all = (await api(cashier).get('/khata/accounts')).body.items as Json[];
    expect(all.map((a) => a.name)).toEqual(['Chaudhry Bilal', 'Haji Rashid']);
    expect(all[1]).toMatchObject({
      balancePaisa: 0,
      creditLimitPaisa: 500000,
      availableCreditPaisa: 500000,
      isActive: true,
    });
    expect(
      ((await api(cashier).get('/khata/accounts?search=rash')).body.items as Json[]).map(
        (a) => a.name,
      ),
    ).toEqual(['Haji Rashid']);
    expect(
      ((await api(cashier).get('/khata/accounts?search=0300-123')).body.items as Json[]).length,
    ).toBe(2);
    expect(
      ((await api(cashier).get('/khata/accounts?owing=true')).body.items as Json[]).length,
    ).toBe(0);
    expect((await api(captain).get('/khata/accounts')).status).toBe(403);

    const patched = await api(manager).patch(`/khata/accounts/${id}`, {
      creditLimitPaisa: 600000,
      phone: null,
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body).toMatchObject({ creditLimitPaisa: 600000, phone: null });
    expect((await audit('KHATA_ACCOUNT_UPDATE')).length).toBe(1);
    expect((await api(manager).patch(`/khata/accounts/${id}`, {})).status).toBe(400);
    // one customer per phone number
    const dup = await api(manager).post('/khata/accounts', {
      name: 'Same phone',
      phone: all[0].phone,
      creditLimitPaisa: 1,
    });
    expect(dup.status).toBe(409);
  });
});

describe('credit sales', () => {
  it('a bill on khata is settled, charged to the ledger, printed with the customer, and not counted as drawer cash', async () => {
    const id = await newAccount('Haji Sahib', 150000);
    const before = (await shiftReport()).expectedCashPaisa;
    const b = await bill();
    const res = await settle(b.id, onKhata(id));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.bill.status).toBe('SETTLED');
    expect(res.body.bill.khata).toMatchObject({
      customer: 'Haji Sahib',
      chargedPaisa: 100000,
      balancePaisa: 100000,
    });
    expect(res.body.bill.payments[0].methodCode).toBe('KHATA');

    const acct = await account(id);
    expect(acct).toMatchObject({ balancePaisa: 100000, availableCreditPaisa: 50000 });
    expect(acct.entries[0]).toMatchObject({
      kind: 'CHARGE',
      amountPaisa: 100000,
      billNo: b.billNo,
    });
    expect((await shiftReport()).expectedCashPaisa).toBe(before); // no cash entered the drawer
    expect((await audit('KHATA_CHARGE')).length).toBe(1);

    await run();
    expect(receiptSim.tickets().at(-1)).toContain('Khata a/c: Haji Sahib');
  });

  it('refuses a charge above the limit, tells the cashier what is left, and leaves the bill payable', async () => {
    const id = await newAccount('Limit Test', 150000);
    await settle((await bill()).id, onKhata(id)); // 100000 used
    const b = await bill();
    const res = await settle(b.id, onKhata(id));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'KHATA_LIMIT_EXCEEDED',
      balancePaisa: 100000,
      limitPaisa: 150000,
      availablePaisa: 50000,
    });
    const view = (await api(cashier).get(`/bills/${b.id}`)).body;
    expect(view.status).toBe('PRE_BILLED');
    expect(view.payments).toHaveLength(0);
    expect((await account(id)).balancePaisa).toBe(100000);

    // part on khata (the rest in cash) fits
    const split = await settle(b.id, [
      ...onKhata(id, 50000),
      { methodId: M.CASH, amountPaisa: 50000, tenderedPaisa: 50000 },
    ]);
    expect(split.status, JSON.stringify(split.body)).toBe(201);
    expect((await account(id)).balancePaisa).toBe(150000);
  });

  it('needs the account, one khata tender, no tip, an active account and khata.collect', async () => {
    const id = await newAccount('Rules', 1_000_000);
    const b = await bill();
    expect((await settle(b.id, [{ methodId: M.KHATA, amountPaisa: 100000 }])).status).toBe(400); // no account
    expect(
      (await settle(b.id, [{ methodId: M.CASH, amountPaisa: 100000, khataAccountId: id }])).status,
    ).toBe(400); // account on the wrong tender
    expect((await settle(b.id, [{ ...onKhata(id)[0], tipPaisa: 100 }])).status).toBe(400);
    expect((await settle(b.id, [...onKhata(id, 50000), ...onKhata(id, 50000)])).status).toBe(400);

    await api(manager).patch(`/khata/accounts/${id}`, { isActive: false });
    const off = await settle(b.id, onKhata(id));
    expect(off.status).toBe(409);
    expect(off.body.code).toBe('KHATA_ACCOUNT_INACTIVE');
    await api(manager).patch(`/khata/accounts/${id}`, { isActive: true });

    // a cashier whose khata.collect is revoked cannot put a sale on credit even with bill.settle
    const roleId = await t.roleId('CASHIER');
    await t.kdb
      .deleteFrom('role_permissions')
      .where('role_id', '=', roleId)
      .where('permission_code', '=', 'khata.collect')
      .execute();
    t.ctx.permissions.invalidate();
    const denied = await settle(b.id, onKhata(id));
    expect(denied.status).toBe(403);
    await t.kdb
      .insertInto('role_permissions')
      .values({ role_id: roleId, permission_code: 'khata.collect' })
      .execute();
    t.ctx.permissions.invalidate();
    expect((await settle(b.id, onKhata(id))).status).toBe(201);
  });

  it('two simultaneous credit sales cannot both fit under the limit', async () => {
    const id = await newAccount('Race', 150000);
    const [b1, b2] = [await bill(), await bill()];
    const results = await Promise.all([settle(b1.id, onKhata(id)), settle(b2.id, onKhata(id))]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await account(id)).balancePaisa).toBe(100000);
  });
});

describe('collecting payments', () => {
  it('cash received goes into the drawer; the balance falls; replays are safe', async () => {
    const id = await newAccount('Payer', 1_000_000);
    await settle((await bill()).id, onKhata(id)); // owes 100000
    const before = await shiftReport();

    const k = key();
    const res = await collect(id, { methodId: M.CASH, amountPaisa: 40000 }, cashier, k);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.balancePaisa).toBe(60000);
    const again = await collect(id, { methodId: M.CASH, amountPaisa: 40000 }, cashier, k);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect((await account(id)).balancePaisa).toBe(60000);

    const after = await shiftReport();
    expect(after.expectedCashPaisa).toBe(before.expectedCashPaisa + 40000);
    expect(after.cash.khataCashPaisa).toBe(before.cash.khataCashPaisa + 40000);

    // a card payment is recorded but is not drawer cash
    const card = await collect(id, { methodId: M.CARD, amountPaisa: 10000, reference: 'RRN-77' });
    expect(card.status, JSON.stringify(card.body)).toBe(201);
    const afterCard = await shiftReport();
    expect(afterCard.expectedCashPaisa).toBe(after.expectedCashPaisa);
    expect(afterCard.khataCollectedPaisa).toBe(after.khataCollectedPaisa + 10000);
    expect((await audit('KHATA_PAYMENT')).length).toBeGreaterThanOrEqual(2);
  });

  it('refuses overpayment, bad methods, a missing shift or key, and an unknown account', async () => {
    const id = await newAccount('Strict', 1_000_000);
    await settle((await bill()).id, onKhata(id, 100000));
    const over = await collect(id, { methodId: M.CASH, amountPaisa: 100001 });
    expect(over.status).toBe(409);
    expect(over.body).toMatchObject({ code: 'KHATA_OVERPAYMENT', balancePaisa: 100000 });
    expect((await collect(id, { methodId: M.KHATA, amountPaisa: 100 })).status).toBe(400);
    expect((await collect(id, { methodId: M.CARD, amountPaisa: 100 })).status).toBe(400); // reference missing
    expect((await collect(id, { methodId: M.CASH, amountPaisa: 100 }, manager)).body.code).toBe(
      'SHIFT_NOT_OPEN',
    );
    expect(
      (
        await api(cashier).post(`/khata/accounts/${id}/payments`, {
          methodId: M.CASH,
          amountPaisa: 100,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await collect('00000000-0000-4000-8000-000000000000', {
          methodId: M.CASH,
          amountPaisa: 100,
        })
      ).status,
    ).toBe(404);
    expect((await account(id)).balancePaisa).toBe(100000);
  });

  it('paying the full balance clears it, and the account can then be used again', async () => {
    const id = await newAccount('Cleared', 100000);
    await settle((await bill()).id, onKhata(id)); // at the limit
    expect((await settle((await bill()).id, onKhata(id))).status).toBe(409);
    expect((await collect(id, { methodId: M.CASH, amountPaisa: 100000 })).body.balancePaisa).toBe(
      0,
    );
    expect((await settle((await bill()).id, onKhata(id))).status).toBe(201);
  });
});

describe('adjustments and reports', () => {
  it('a manager corrects a balance with a reason; cashiers cannot; it is audited', async () => {
    const id = await newAccount('Adjusted', 1_000_000);
    expect(
      (
        await api(cashier).post(`/khata/accounts/${id}/adjustments`, {
          direction: 'UP',
          amountPaisa: 100,
          reason: 'x y z',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api(manager).post(`/khata/accounts/${id}/adjustments`, {
          direction: 'UP',
          amountPaisa: 100,
        })
      ).status,
    ).toBe(400);
    const up = await api(manager).post(`/khata/accounts/${id}/adjustments`, {
      direction: 'UP',
      amountPaisa: 250000,
      reason: 'Opening balance from the paper register',
    });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect(up.body.balancePaisa).toBe(250000);
    const down = await api(manager).post(`/khata/accounts/${id}/adjustments`, {
      direction: 'DOWN',
      amountPaisa: 50000,
      reason: 'Goodwill write-off',
    });
    expect(down.body.balancePaisa).toBe(200000);
    const acct = await account(id);
    expect(acct.entries.map((e: Json) => [e.kind, e.deltaPaisa])).toEqual([
      ['ADJUST_DOWN', -50000],
      ['ADJUST_UP', 250000],
    ]);
    const log = (await audit('KHATA_ADJUST')).at(-1)!;
    expect(log.reason).toBe('Goodwill write-off');
  });

  it('a write-off cannot take the balance below zero', async () => {
    const id = await newAccount('No negative', 1_000_000);
    await api(manager).post(`/khata/accounts/${id}/adjustments`, {
      direction: 'UP',
      amountPaisa: 30000,
      reason: 'Opening balance',
    });
    const over = await api(manager).post(`/khata/accounts/${id}/adjustments`, {
      direction: 'DOWN',
      amountPaisa: 30001,
      reason: 'Too much',
    });
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('KHATA_OVERPAYMENT');
    expect((await account(id)).balancePaisa).toBe(30000);
  });

  it('the day report shows khata charged and collected', async () => {
    const day = (await api(manager).get('/business-days/current')).body.day;
    const rep = (await api(owner).get(`/business-days/${day.id}/report`)).body;
    expect(rep.khata.chargedPaisa).toBeGreaterThan(0);
    expect(rep.khata.collectedPaisa).toBeGreaterThan(0);
    expect(rep.byMethod.map((m: Json) => m.code)).toContain('KHATA');
  });
});

describe('who owes what, and since when', () => {
  const daysAgo = (n: number): Date => new Date(Date.now() - n * 86_400_000);
  const put = async (
    accountId: string,
    kind: 'ADJUST_UP' | 'ADJUST_DOWN',
    paisa: number,
    at: Date,
  ) => {
    const by = await t.kdb.selectFrom('users').select('id').limit(1).executeTakeFirstOrThrow();
    await t.kdb
      .insertInto('khata_entries')
      .values({
        account_id: accountId,
        kind,
        amount_paisa: paisa,
        note: 'test entry',
        created_by: by.id,
        created_at: at,
      })
      .execute();
  };

  it('the same phone number is refused however it is typed, naming who has it', async () => {
    const id = await newAccount('Phone owner', 1000);
    const phone = (await account(id)).phone as string; // 0300-1234NNN
    const digits = phone.replace(/\D/g, '');
    for (const typed of [
      digits,
      `+92${digits.slice(1)}`,
      `${digits.slice(0, 4)} ${digits.slice(4)}`,
    ]) {
      const res = await api(manager).post('/khata/accounts', {
        name: 'Copy',
        phone: typed,
        creditLimitPaisa: 1,
      });
      expect(res.status, typed).toBe(409);
      expect(res.body.code).toBe('KHATA_PHONE_EXISTS');
      expect(res.body.title).toContain('Phone owner');
    }
    // changing someone else's number to it is refused too; keeping your own is fine
    const other = await newAccount('Someone else', 1000);
    expect((await api(manager).patch(`/khata/accounts/${other}`, { phone })).status).toBe(409);
    expect((await api(manager).patch(`/khata/accounts/${id}`, { phone })).status).toBe(200);
  });

  it('shows what the customer owed after each entry, and how old the debt is (oldest credit is paid first)', async () => {
    const id = await newAccount('Aged', 10_000_000);
    await put(id, 'ADJUST_UP', 100_000, daysAgo(40)); // Rs 1,000, 40 days ago
    await put(id, 'ADJUST_UP', 50_000, daysAgo(5)); //   Rs   500,  5 days ago
    await put(id, 'ADJUST_DOWN', 100_000, daysAgo(4)); // pays the old Rs 1,000
    const a = await account(id);
    expect(a.balancePaisa).toBe(50_000);
    expect(a.entries.map((e: Json) => e.balanceAfterPaisa)).toEqual([50_000, 150_000, 100_000]);
    // only the Rs 500 from 5 days ago is still owed
    const since = new Date(a.owingSince).getTime();
    expect(Math.round((Date.now() - since) / 86_400_000)).toBe(5);

    // a part-payment of the newer credit leaves the same date; clearing it leaves none
    await put(id, 'ADJUST_DOWN', 20_000, daysAgo(1));
    expect(
      Math.round((Date.now() - new Date((await account(id)).owingSince).getTime()) / 86_400_000),
    ).toBe(5);
    await put(id, 'ADJUST_DOWN', 30_000, daysAgo(0));
    const cleared = await account(id);
    expect(cleared.balancePaisa).toBe(0);
    expect(cleared.owingSince).toBeNull();
  });

  it('lists the biggest debts first on request and totals every account', async () => {
    const small = await newAccount('Sort small', 5_000_000);
    const big = await newAccount('Sort big', 5_000_000);
    await put(small, 'ADJUST_UP', 10_000, daysAgo(1));
    await put(big, 'ADJUST_UP', 900_000, daysAgo(1));
    const items = (await api(cashier).get('/khata/accounts?sort=owed')).body.items as Json[];
    const order = items.map((x) => x.id);
    expect(order.indexOf(big)).toBeLessThan(order.indexOf(small));
    expect(items[0].balancePaisa).toBeGreaterThanOrEqual(items[1].balancePaisa);

    const sum = (await api(cashier).get('/khata/summary')).body;
    const owing = items.filter((x) => x.balancePaisa > 0);
    expect(sum.accountsOwing).toBe(owing.length);
    expect(sum.owedPaisa).toBe(owing.reduce((n, x) => n + x.balancePaisa, 0));
    expect(sum.accounts).toBe(items.length);
    expect((await api(captain).get('/khata/summary')).status).toBe(403);
  });
});
