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
let tikka: { id: string; variantId: string };
let receiptSim: SimPrinter;
let managerShift: string;
let station: string;
const lists: { id: string }[] = [];
const M: Record<string, string> = {};
const api = (tok: string) => t.as(tok);
const run = () => processPrintJobs(t.ctx, new TcpTransport());
const audit = (action: string) =>
  t.kdb.selectFrom('audit_log').selectAll().where('action', '=', action).orderBy('id').execute();
let keySeq = 0;
const key = () => `tax-key-${Date.now()}-${++keySeq}`;
/** integer half-up of paisa × bps / 10000 (the same rounding the engine uses) */
const pct = (paisa: number, bps: number): number => Math.floor((paisa * bps * 2 + 10_000) / 20_000);

async function mkItem(name: string, price: number, taxCategoryCode?: string) {
  const res = await api(owner).post('/items', {
    kind: 'STANDARD',
    name,
    stationId: station,
    ...(taxCategoryCode ? { taxCategoryCode } : {}),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  for (const l of lists)
    await api(owner).put(`/variants/${res.body.variants[0].id}/prices/${l.id}`, {
      pricePaisa: price,
    });
  return { id: res.body.id as string, variantId: res.body.variants[0].id as string };
}
async function preBill(item = tikka, qty = 1): Promise<Json> {
  const o = (await api(captain).post('/orders', { type: 'TAKEAWAY' })).body;
  await api(captain).post(`/orders/${o.id}/items`, {
    itemId: item.id,
    variantId: item.variantId,
    qty,
  });
  await api(captain).post(`/orders/${o.id}/send`, {});
  return api(cashier).post(`/orders/${o.id}/bill`);
}
const quotes = async (billId: string): Promise<Json> =>
  (await api(cashier).get(`/bills/${billId}/quotes`)).body;
const settle = (billId: string, tenders: object[]) =>
  api(cashier).post(`/bills/${billId}/settle`, { tenders }).set('Idempotency-Key', key());
const cash = (amountPaisa: number) => ({
  methodId: M.CASH,
  amountPaisa,
  tenderedPaisa: amountPaisa,
});
const card = (amountPaisa: number) => ({ methodId: M.CARD, amountPaisa, reference: 'RRN-T' });
const setSetting = (k: string, v: unknown, tok = owner) =>
  api(tok).put(`/settings/${k}`, { value: v });
const categoryId = async (code: string): Promise<string> =>
  (
    await t.kdb
      .selectFrom('tax_categories')
      .select('id')
      .where('code', '=', code)
      .executeTakeFirstOrThrow()
  ).id;
let ruleIds: { cash: string; digital: string } = { cash: '', digital: '' };

beforeAll(async () => {
  t = await startApp();
  owner = (await t.login('OWNER')).token;
  manager = (await t.login('MANAGER')).token;
  cashier = (await t.login('CASHIER')).token;
  captain = (await t.login('CAPTAIN')).token;
  for (const code of ['DINE_IN', 'TAKEAWAY', 'DELIVERY'])
    lists.push((await api(owner).post('/price-lists', { code, name: code })).body);
  station = (await api(owner).post('/stations', { code: 'BBQ', name: 'BBQ' })).body.id;
  tikka = await mkItem('Tikka', 100000);
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
  ] as const)
    M[code] = (
      await api(owner).post('/payment-methods', { code, name: code, tender_class: cls, ...extra })
    ).body.id;
  await api(cashier).post('/business-days/open', {});
  await api(cashier).post('/shifts/open', { openingFloatPaisa: 500000 });
  const sh = await api(manager).post('/shifts/open', { openingFloatPaisa: 5_000_000 });
  managerShift = sh.body.id;
}, 240_000);

afterAll(async () => {
  await receiptSim.unplug();
  await t.stop();
});

describe('tax is off until the owner sets it up', () => {
  it('bills carry no tax by default and no rate exists in the code', async () => {
    const res = await preBill();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ taxPaisa: 0, totalPaisa: 100000, taxRateBps: null });
    const q = await quotes(res.body.id);
    expect(q).toMatchObject({ taxEnabled: false });
    expect(q.CASH_OTHER.totalPaisa).toBe(100000);
    expect(q.DIGITAL.totalPaisa).toBe(100000);
    await api(manager).post(`/bills/${res.body.id}/void`, { reason: 'test setup' });
  });

  it('only a user with tax.manage can touch tax data or the switch', async () => {
    expect((await api(manager).get('/tax/rules')).status).toBe(403);
    expect((await api(manager).post('/tax/categories', { code: 'X_CAT', name: 'x' })).status).toBe(
      403,
    );
    expect((await setSetting('tax.enabled', true, manager)).status).toBe(403);
    expect((await api(owner).get('/tax/rules')).status).toBe(200);
  });

  it('refuses to switch tax on until authority, rules and their verification are in place', async () => {
    const first = await setSetting('tax.enabled', true);
    expect(first.status).toBe(409);
    expect(first.body.code).toBe('TAX_NOT_READY');
    const codes = (first.body.problems as Json[]).map((p) => p.code);
    expect(codes).toContain('AUTHORITY_NOT_SET');
    expect(codes).toContain('RULE_MISSING');

    expect(
      (
        await api(owner).patch('/branch', {
          tax_authority: 'PRA',
          ntn: '1234567-8',
          strn: '17-00-0000-001-37',
        })
      ).status,
    ).toBe(200);
    const cat = await categoryId('RESTAURANT_SERVICE');
    const mkRule = (body: object) =>
      api(owner).post('/tax/rules', {
        authority: 'PRA',
        categoryId: cat,
        effectiveFrom: '2026-01-01',
        ...body,
      });
    const c = await mkRule({
      paymentClass: 'CASH_OTHER',
      rateBps: 1600,
      sourceNote: 'owner entered',
    });
    const d = await mkRule({ paymentClass: 'DIGITAL', rateBps: 800, sourceNote: 'owner entered' });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    ruleIds = { cash: c.body.id, digital: d.body.id };

    const unverified = await setSetting('tax.enabled', true);
    expect(unverified.status).toBe(409);
    expect((unverified.body.problems as Json[]).map((p) => p.code)).toEqual([
      'RULE_UNVERIFIED',
      'RULE_UNVERIFIED',
    ]);

    for (const id of [ruleIds.cash, ruleIds.digital])
      expect(
        (await api(owner).patch(`/tax/rules/${id}`, { verifiedBy: 'A. Khan, CA' })).status,
      ).toBe(200);
    const ready = (await api(owner).get('/tax/readiness')).body;
    expect(ready).toMatchObject({ ready: true, problems: [] });
    expect((await setSetting('tax.enabled', true)).status).toBe(200);
    expect((await audit('TAX_RULE_CREATE')).length).toBe(2);
  });
});

describe('rules are protected', () => {
  it('overlapping rules are refused (also an ANY rule next to a class rule); rates are never edited', async () => {
    const cat = await categoryId('RESTAURANT_SERVICE');
    const base = { authority: 'PRA', categoryId: cat, effectiveFrom: '2026-06-01' };
    expect(
      (await api(owner).post('/tax/rules', { ...base, paymentClass: 'CASH_OTHER', rateBps: 1700 }))
        .status,
    ).toBe(409);
    expect(
      (await api(owner).post('/tax/rules', { ...base, paymentClass: 'ANY', rateBps: 1700 })).status,
    ).toBe(409);
    expect((await api(owner).patch(`/tax/rules/${ruleIds.cash}`, { rateBps: 1 })).status).toBe(400); // not even accepted
    await expect(
      t.kdb.updateTable('tax_rules').set({ rate_bps: 1 }).where('id', '=', ruleIds.cash).execute(),
    ).rejects.toBeTruthy();
    await expect(
      t.kdb.deleteFrom('tax_rules').where('id', '=', ruleIds.cash).execute(),
    ).rejects.toBeTruthy();
  });

  it('a rate change is a new rule from a new date: end the old one, add the next', async () => {
    const cat = await categoryId('RESTAURANT_SERVICE');
    const end = await api(owner).patch(`/tax/rules/${ruleIds.digital}`, {
      effectiveTo: '2026-12-31',
    });
    expect(end.status).toBe(200);
    const next = await api(owner).post('/tax/rules', {
      authority: 'PRA',
      categoryId: cat,
      paymentClass: 'DIGITAL',
      rateBps: 900,
      effectiveFrom: '2027-01-01',
      verifiedBy: 'A. Khan, CA',
    });
    expect(next.status, JSON.stringify(next.body)).toBe(201);
    // today (2026-08-01) the old digital rate still applies
    const b = await preBill();
    expect((await quotes(b.body.id)).DIGITAL.taxPaisa).toBe(8000);
    await api(manager).post(`/bills/${b.body.id}/void`, { reason: 'test setup' });
  });

  it('categories need an upper-case code', async () => {
    expect((await api(owner).post('/tax/categories', { code: 'bad code', name: 'x' })).status).toBe(
      400,
    );
    expect(
      (await api(owner).post('/tax/categories', { code: 'PACKAGED_GOODS', name: 'Packaged goods' }))
        .status,
    ).toBe(201);
    expect(
      (await api(owner).post('/tax/categories', { code: 'PACKAGED_GOODS', name: 'again' })).status,
    ).toBe(409);
  });
});

describe('tax at settlement', () => {
  it('the class of the tenders decides the rate: cash 16 %, all-digital 8 %, mixed = cash rate', async () => {
    const pre = await preBill();
    expect(pre.body).toMatchObject({ taxPaisa: 16000, totalPaisa: 116000, taxRateBps: 1600 });
    const q = await quotes(pre.body.id);
    expect(q).toMatchObject({ taxEnabled: true });
    expect(q.CASH_OTHER).toMatchObject({ taxPaisa: 16000, totalPaisa: 116000 });
    expect(q.DIGITAL).toMatchObject({ taxPaisa: 8000, totalPaisa: 108000 });

    // paying the cash total by card is refused: the card class re-prices to 108000
    const wrong = await settle(pre.body.id, [card(116000)]);
    expect(wrong.status).toBe(400);
    expect((await api(cashier).get(`/bills/${pre.body.id}`)).body.status).toBe('PRE_BILLED');

    const ok = await settle(pre.body.id, [card(108000)]);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.bill).toMatchObject({
      status: 'SETTLED',
      taxPaymentClass: 'DIGITAL',
      taxPaisa: 8000,
      totalPaisa: 108000,
      taxRateBps: 800,
    });
    expect(ok.body.bill.lines[0]).toMatchObject({ taxPaisa: 8000, taxRateBps: 800 });

    const mixed = await preBill();
    const m = await settle(mixed.body.id, [cash(16000), card(100000)]);
    expect(m.status, JSON.stringify(m.body)).toBe(201);
    expect(m.body.bill).toMatchObject({
      taxPaymentClass: 'CASH_OTHER',
      taxPaisa: 16000,
      totalPaisa: 116000,
    });
  });

  it('discount and service charge shrink or grow the taxable base; the line taxes sum to the bill tax', async () => {
    await setSetting('billing.service_charge_bps', 500);
    try {
      const pre = (await preBill(tikka, 3)).body; // 300000
      const disc = await api(manager).post(`/bills/${pre.id}/discount`, {
        percentBps: 1000,
        reason: 'Regular guest',
      });
      expect(disc.status, JSON.stringify(disc.body)).toBe(200);
      const b = disc.body;
      expect(b.discountPaisa).toBe(30000);
      // taxable = subtotal − discount + service (service is taxable by default); tax = 16 % of it
      expect(b.taxPaisa).toBe(pct(b.taxablePaisa, 1600));
      expect(b.lines.reduce((n: number, l: Json) => n + l.taxPaisa, 0)).toBe(b.taxPaisa);
      expect(b.totalPaisa).toBe(b.taxablePaisa + b.taxPaisa + b.roundOffPaisa);
      expect((await settle(b.id, [cash(b.totalPaisa)])).status).toBe(201);
    } finally {
      await t.kdb.deleteFrom('settings').where('key', '=', 'billing.service_charge_bps').execute();
    }
  });

  it('service charge can be excluded from the base (tax.service_charge_taxable = false)', async () => {
    await setSetting('billing.service_charge_bps', 1000);
    await setSetting('tax.service_charge_taxable', false);
    try {
      const pre = (await preBill()).body;
      expect(pre.serviceChargePaisa).toBe(10000);
      expect(pre.taxPaisa).toBe(16000); // 16 % of the food only
    } finally {
      await t.kdb
        .deleteFrom('settings')
        .where('key', 'in', ['billing.service_charge_bps', 'tax.service_charge_taxable'])
        .execute();
      await t.kdb
        .insertInto('settings')
        .values({
          branch_id: t.branchId,
          key: 'tax.service_charge_taxable',
          value: JSON.stringify(true),
        })
        .execute();
    }
  });

  it('an item whose category has no rule is a hard error, never a guessed rate', async () => {
    const water = await mkItem('Water', 5000, 'PACKAGED_GOODS');
    const res = await preBill(water);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TAX_RULE_MISSING');
  });

  it('receipt shows the tax rate and the registration numbers; the Z-report shows tax by rate', async () => {
    await run();
    const before = receiptSim.jobs.length;
    const pre = (await preBill()).body;
    expect((await settle(pre.id, [cash(116000)])).status).toBe(201);
    await run();
    expect(receiptSim.jobs.length).toBe(before + 1);
    const text = receiptSim.tickets().at(-1)!;
    expect(text).toContain('Sales tax 16%');
    expect(text).toContain('NTN: 1234567-8');
    expect(text).toContain('STRN: 17-00-0000-001-37');

    const day = (await api(manager).get('/business-days/current')).body.day;
    const rep = (await api(owner).get(`/business-days/${day.id}/report`)).body;
    expect(rep.tax.collectedPaisa).toBeGreaterThan(0);
    expect(rep.tax.byRate.map((r: Json) => r.rateBps)).toEqual(expect.arrayContaining([800, 1600]));
    expect(rep.tax.netPaisa).toBe(rep.tax.collectedPaisa - rep.tax.reversedPaisa);
    expect(rep.sales.taxPaisa).toBe(rep.tax.collectedPaisa);
  });
});

describe('credit notes reverse tax at the original rate', () => {
  it('returning one of two taxed items gives back its price AND its tax', async () => {
    const pre = (await preBill(tikka, 2)).body; // 200000 + 32000
    expect(pre.totalPaisa).toBe(232000);
    expect((await settle(pre.id, [cash(232000)])).status).toBe(201);
    const line = (await api(manager).get(`/bills/${pre.id}/refundable`)).body.lines[0];

    const dry = await api(manager).post(`/bills/${pre.id}/credit-notes?dryRun=true`, {
      lines: [{ billLineId: line.id, qty: 1 }],
      reason: 'preview',
      methodId: M.CASH,
    });
    expect(dry.body).toMatchObject({ totalPaisa: 116000, taxPaisa: 16000 });

    const res = await api(manager)
      .post(`/bills/${pre.id}/credit-notes`, { all: true, reason: 'Guests left', methodId: M.CASH })
      .set('Idempotency-Key', key());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ totalPaisa: 232000, taxPaisa: 32000 });
    const row = await t.kdb
      .selectFrom('credit_notes')
      .selectAll()
      .where('id', '=', res.body.id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ net_paisa: 200000, tax_paisa: 32000, total_paisa: 232000 });
    const lines = await t.kdb
      .selectFrom('credit_note_lines')
      .selectAll()
      .where('credit_note_id', '=', res.body.id)
      .execute();
    expect(lines.map((l) => [l.net_paisa, l.tax_paisa])).toEqual([[200000, 32000]]);

    await run();
    expect(receiptSim.tickets().at(-1)).toContain('incl. tax reversed');
    const day = (await api(manager).get('/business-days/current')).body.day;
    expect(
      (await api(owner).get(`/business-days/${day.id}/report`)).body.tax.reversedPaisa,
    ).toBeGreaterThanOrEqual(32000);
  });

  it('a partial return is exact: two returns of one item each sum to the whole', async () => {
    const pre = (await preBill(tikka, 2)).body;
    await settle(pre.id, [cash(232000)]);
    const line = (await api(manager).get(`/bills/${pre.id}/refundable`)).body.lines[0];
    const one = await api(manager)
      .post(`/bills/${pre.id}/credit-notes`, {
        lines: [{ billLineId: line.id, qty: 1 }],
        reason: 'One back',
        methodId: M.CASH,
      })
      .set('Idempotency-Key', key());
    const two = await api(manager)
      .post(`/bills/${pre.id}/credit-notes`, { all: true, reason: 'The other', methodId: M.CASH })
      .set('Idempotency-Key', key());
    expect(one.body.taxPaisa + two.body.taxPaisa).toBe(32000);
    expect(one.body.totalPaisa + two.body.totalPaisa).toBe(232000);
  });
});

describe('switching tax off again', () => {
  it('new bills carry no tax; a bill priced while tax was on is repriced at settlement', async () => {
    const pre = (await preBill()).body; // priced with tax
    expect(pre.taxPaisa).toBe(16000);
    expect((await setSetting('tax.enabled', false)).status).toBe(200);
    const q = await quotes(pre.id);
    expect(q.taxEnabled).toBe(false);
    expect(q.CASH_OTHER.totalPaisa).toBe(100000);
    const ok = await settle(pre.id, [cash(100000)]);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.bill).toMatchObject({ taxPaisa: 0, totalPaisa: 100000, taxRateBps: null });
    expect(ok.body.bill.lines[0].taxPaisa).toBe(0);
    expect(managerShift).toBeTruthy();
  });
});
