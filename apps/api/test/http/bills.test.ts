import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { processPrintJobs, TcpTransport } from '../../src/modules/printing/print.service';
import { startApp, PIN, type TestApp } from './app-harness';
import { SimPrinter } from './sim-printer';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let t: TestApp;
let owner: string;
let manager: string;
let cashier: string;
let captain: string;
let receiptSim: SimPrinter;
let item: { id: string; variantId: string };
let oddItem: { id: string; variantId: string };
const M: Record<string, string> = {};
const api = (tok: string) => t.as(tok);
const audit = (action: string) =>
  t.kdb.selectFrom('audit_log').selectAll().where('action', '=', action).orderBy('id').execute();

let keySeq = 0;
const key = () => `test-key-${Date.now()}-${++keySeq}`;

/** Sent order with `qty` × a Rs 1,000 item → subtotal qty*100000 paisa. */
async function sentOrder(qty = 1, which: { id: string; variantId: string } = item): Promise<Json> {
  const o = (await api(captain).post('/orders', { type: 'TAKEAWAY' })).body;
  const a = await api(captain).post(`/orders/${o.id}/items`, {
    itemId: which.id,
    variantId: which.variantId,
    qty,
  });
  expect(a.status, JSON.stringify(a.body)).toBe(201);
  const s = await api(captain).post(`/orders/${o.id}/send`, {});
  expect(s.status, JSON.stringify(s.body)).toBe(201);
  return o;
}
async function preBill(qty = 1): Promise<Json> {
  const o = await sentOrder(qty);
  const res = await api(cashier).post(`/orders/${o.id}/bill`);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}
const settle = (billId: string, tenders: object[], k = key(), tok = cashier) =>
  api(tok).post(`/bills/${billId}/settle`, { tenders }).set('Idempotency-Key', k);
const cash = (amountPaisa: number, tenderedPaisa = amountPaisa) => ({
  methodId: M.CASH,
  amountPaisa,
  tenderedPaisa,
});
const setSetting = async (k: string, value: unknown) =>
  expect((await api(owner).put(`/settings/${k}`, { value })).status).toBe(200);

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
  const odd = await api(owner).post('/items', {
    kind: 'STANDARD',
    name: 'Odd',
    stationId: station,
  });
  for (const l of lists)
    await api(owner).put(`/variants/${odd.body.variants[0].id}/prices/${l.id}`, {
      pricePaisa: 33333,
    });
  oddItem = { id: odd.body.id, variantId: odd.body.variants[0].id };

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
  const rp = await api(owner).post('/printers', {
    name: 'counter',
    kind: 'RECEIPT',
    conn_type: 'NETWORK',
    host: '127.0.0.1',
    port: receiptSim.port,
    paper_mm: 80,
  });
  expect(rp.status, JSON.stringify(rp.body)).toBe(201);

  const mk = async (code: string, tender_class: string, extra: object = {}) => {
    const r = await api(owner).post('/payment-methods', {
      code,
      name: code[0] + code.slice(1).toLowerCase(),
      tender_class,
      ...extra,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    M[code] = r.body.id;
  };
  await mk('CASH', 'CASH_OTHER', { opens_drawer: true });
  await mk('CARD', 'DIGITAL', { needs_reference: true });
  await mk('KHATA', 'CASH_OTHER');

  await api(cashier).post('/business-days/open', {});
  const sh = await api(cashier).post('/shifts/open', { openingFloatPaisa: 500000 });
  expect(sh.status, JSON.stringify(sh.body)).toBe(201);
}, 240_000);

afterAll(async () => {
  await receiptSim.unplug();
  await t.stop();
});

afterEach(async () => {
  // never let one test's billing settings leak into the next
  await t.kdb
    .deleteFrom('settings')
    .where('key', 'in', ['billing.round_to_rupee', 'billing.service_charge_bps'])
    .execute();
});

describe('pre-bill', () => {
  it('prices the bill from the order, freezes the order, numbers bills sequentially', async () => {
    const o = await sentOrder(3);
    const res = await api(cashier).post(`/orders/${o.id}/bill`);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'PRE_BILLED',
      subtotalPaisa: 300000,
      discountPaisa: 0,
      serviceChargePaisa: 0,
      taxPaisa: 0,
      roundOffPaisa: 0,
      totalPaisa: 300000,
    });
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.lines[0]).toMatchObject({ qty: 3, netPaisa: 300000 });

    // the order is frozen: no more items, and a second live bill is refused
    const add = await api(captain).post(`/orders/${o.id}/items`, {
      itemId: item.id,
      variantId: item.variantId,
    });
    expect(add.status).toBe(409);
    expect((await api(cashier).post(`/orders/${o.id}/bill`)).status).toBe(409);

    const next = await preBill();
    expect(next.billNo).toBe(res.body.billNo + 1);
    const byOrder = await api(cashier).get(`/orders/${o.id}/bill`);
    expect(byOrder.body.id).toBe(res.body.id);
  });

  it('refuses unsent or empty orders', async () => {
    const o = (await api(captain).post('/orders', { type: 'TAKEAWAY' })).body;
    expect((await api(cashier).post(`/orders/${o.id}/bill`)).body.code).toBe('EMPTY_ORDER');
    await api(captain).post(`/orders/${o.id}/items`, {
      itemId: item.id,
      variantId: item.variantId,
    });
    const res = await api(cashier).post(`/orders/${o.id}/bill`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('UNSENT_ITEMS');
  });

  it('applies the service charge and round-to-rupee settings', async () => {
    await setSetting('billing.service_charge_bps', 500);
    await setSetting('billing.round_to_rupee', true);
    const o = await sentOrder(1, oddItem); // 333.33 + 5% = 16.67 service → 350.00
    const res = await api(cashier).post(`/orders/${o.id}/bill`);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.subtotalPaisa).toBe(33333);
    expect(res.body.serviceChargePaisa).toBe(1667);
    expect(res.body.totalPaisa % 100).toBe(0);
    expect(res.body.totalPaisa).toBe(
      res.body.subtotalPaisa + res.body.serviceChargePaisa + res.body.roundOffPaisa,
    );
    await setSetting('billing.service_charge_bps', 0);
    await setSetting('billing.round_to_rupee', false);
  });

  it('captain can pre-bill but cannot settle', async () => {
    const o = await sentOrder();
    const bill = (await api(captain).post(`/orders/${o.id}/bill`)).body;
    expect((await settle(bill.id, [cash(100000)], key(), captain)).status).toBe(403);
  });
});

describe('discounts', () => {
  it('requires a reason; within the limit is audited, above it needs a manager PIN', async () => {
    const cashierRow = await t.kdb
      .selectFrom('users')
      .select('id')
      .where('username', '=', 'cashier')
      .executeTakeFirstOrThrow();
    expect(
      (await api(owner).patch(`/users/${cashierRow.id}`, { discountLimitBps: 1000 })).status,
    ).toBe(200);

    const bill = await preBill(); // 100000
    const noReason = await api(cashier).post(`/bills/${bill.id}/discount`, { percentBps: 500 });
    expect(noReason.status).toBe(400);

    const ok = await api(cashier).post(`/bills/${bill.id}/discount`, {
      percentBps: 500,
      reason: 'Regular guest',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({
      discountPaisa: 5000,
      totalPaisa: 95000,
      discountReason: 'Regular guest',
    });
    expect(ok.body.discountApprovedBy).toBeNull();

    const over = await api(cashier).post(`/bills/${bill.id}/discount`, {
      percentBps: 2000,
      reason: 'Birthday',
    });
    expect(over.status).toBe(403);
    expect(over.body.code).toBe('DISCOUNT_APPROVAL_REQUIRED');

    const wrong = await api(cashier).post(`/bills/${bill.id}/discount`, {
      percentBps: 2000,
      reason: 'Birthday',
      approver: { username: 'manager', pin: '9999' },
    });
    expect(wrong.status).toBe(403);
    expect(wrong.body.code).toBe('APPROVER_INVALID');

    const notManager = await api(cashier).post(`/bills/${bill.id}/discount`, {
      percentBps: 2000,
      reason: 'Birthday',
      approver: { username: 'captain', pin: PIN },
    });
    expect(notManager.body.code).toBe('APPROVER_INVALID');

    const approved = await api(cashier).post(`/bills/${bill.id}/discount`, {
      percentBps: 2000,
      reason: 'Birthday',
      approver: { username: 'manager', pin: PIN },
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({ discountPaisa: 20000, totalPaisa: 80000 });
    expect(approved.body.discountApprovedBy).toBeTruthy();
    expect((await audit('BILL_DISCOUNT')).length).toBeGreaterThanOrEqual(2);

    // 0 removes it
    const removed = await api(cashier).post(`/bills/${bill.id}/discount`, { percentBps: 0 });
    expect(removed.body).toMatchObject({
      discountPaisa: 0,
      totalPaisa: 100000,
      discountReason: null,
    });
  });

  it('rejects ambiguous input, and a settled bill cannot be discounted', async () => {
    const bill = await preBill();
    expect(
      (
        await api(manager).post(`/bills/${bill.id}/discount`, {
          percentBps: 100,
          amountPaisa: 5,
          reason: 'x y z',
        })
      ).status,
    ).toBe(400);
    expect((await settle(bill.id, [cash(100000)])).status).toBe(201);
    const late = await api(manager).post(`/bills/${bill.id}/discount`, {
      percentBps: 100,
      reason: 'too late',
    });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('BILL_NOT_PAYABLE');
  });
});

describe('settle', () => {
  it('cash with change: one payment row, drawer-kick receipt, order settled, audited', async () => {
    await processPrintJobs(t.ctx, new TcpTransport()); // drain earlier tests' receipts
    const bill = await preBill(); // 100000
    const res = await settle(bill.id, [cash(100000, 150000)]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.changeDuePaisa).toBe(50000);
    expect(res.body.receipts).toBe(1);
    expect(res.body.bill).toMatchObject({
      status: 'SETTLED',
      taxPaymentClass: 'CASH_OTHER',
      printCount: 1,
    });
    const order = await api(cashier).get(`/orders/${bill.orderId}`);
    expect(order.body.status).toBe('SETTLED');
    expect((await audit('BILL_SETTLE')).length).toBeGreaterThan(0);

    const before = receiptSim.jobs.length;
    await processPrintJobs(t.ctx, new TcpTransport());
    expect(receiptSim.jobs.length).toBe(before + 1);
    const text = receiptSim.tickets().at(-1)!;
    expect(text).toContain(`Bill #${bill.billNo}`);
    expect(text).toContain('TOTAL');
    expect(text).toContain('Change');
  });

  it('split cash + card; card needs a reference; exact amounts only for non-cash', async () => {
    const bill = await preBill(); // 100000
    const noRef = await settle(bill.id, [cash(40000), { methodId: M.CARD, amountPaisa: 60000 }]);
    expect(noRef.status).toBe(400);
    const ok = await settle(bill.id, [
      cash(40000),
      { methodId: M.CARD, amountPaisa: 60000, reference: 'RRN123' },
    ]);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.bill.payments).toHaveLength(2);
    expect(ok.body.bill.taxPaymentClass).toBe('CASH_OTHER'); // any non-digital tender → highest-rate class
  });

  it('all-card bill is DIGITAL class', async () => {
    const bill = await preBill();
    const res = await settle(bill.id, [
      { methodId: M.CARD, amountPaisa: 100000, reference: 'RRN9' },
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.bill.taxPaymentClass).toBe('DIGITAL');
  });

  it('rejects under- and over-payment and leaves the bill payable', async () => {
    const bill = await preBill();
    expect((await settle(bill.id, [cash(90000)])).status).toBe(400);
    expect((await settle(bill.id, [cash(110000)])).status).toBe(400);
    expect((await settle(bill.id, [cash(100000, 90000)])).status).toBe(400); // tendered < amount
    expect((await settle(bill.id, [])).status).toBe(400);
    const view = await api(cashier).get(`/bills/${bill.id}`);
    expect(view.body.status).toBe('PRE_BILLED');
    expect(view.body.payments).toHaveLength(0);
  });

  it('a khata tender needs the customer’s account (see khata.test.ts), unknown methods are refused', async () => {
    const bill = await preBill();
    expect((await settle(bill.id, [{ methodId: M.KHATA, amountPaisa: 100000 }])).status).toBe(400);
    expect(
      (
        await settle(bill.id, [
          { methodId: '00000000-0000-4000-8000-000000000000', amountPaisa: 100000 },
        ])
      ).status,
    ).toBe(400);
  });

  it('is idempotent: same key replays, a different key on a paid bill is refused', async () => {
    const bill = await preBill();
    const k = key();
    const first = await settle(bill.id, [cash(100000, 200000)], k);
    const again = await settle(bill.id, [cash(100000, 200000)], k);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(again.body.changeDuePaisa).toBe(100000);
    const other = await settle(bill.id, [cash(100000)], key());
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('BILL_ALREADY_SETTLED');
    const rows = await t.kdb
      .selectFrom('payments')
      .select('id')
      .where('bill_id', '=', bill.id)
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('a parallel double-click pays exactly once', async () => {
    const bill = await preBill();
    const k = key();
    const results = await Promise.all([1, 2, 3, 4].map(() => settle(bill.id, [cash(100000)], k)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    const rows = await t.kdb
      .selectFrom('payments')
      .select('id')
      .where('bill_id', '=', bill.id)
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('needs an Idempotency-Key header', async () => {
    const bill = await preBill();
    const res = await api(cashier).post(`/bills/${bill.id}/settle`, { tenders: [cash(100000)] });
    expect(res.status).toBe(400);
  });

  it('needs the cashier’s own open shift', async () => {
    const bill = await preBill();
    // manager has no open shift
    const res = await settle(bill.id, [cash(100000)], key(), manager);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SHIFT_NOT_OPEN');
  });

  it('settled bills are immutable at the database too', async () => {
    const bill = await preBill();
    await settle(bill.id, [cash(100000)]);
    await expect(
      t.kdb.updateTable('bills').set({ total_paisa: 1 }).where('id', '=', bill.id).execute(),
    ).rejects.toBeTruthy();
  });
});

describe('database guards', () => {
  it('refuses to settle a bill whose payments do not add up, and a second live bill per order', async () => {
    const bill = await preBill();
    await expect(
      t.kdb
        .updateTable('bills')
        .set({ status: 'SETTLED', tax_payment_class: 'CASH_OTHER', settled_at: new Date() })
        .where('id', '=', bill.id)
        .execute(),
    ).rejects.toBeTruthy();
    await expect(
      t.kdb
        .insertInto('bills')
        .values({
          branch_id: t.branchId,
          business_day_id: (
            await t.kdb
              .selectFrom('bills')
              .select('business_day_id')
              .where('id', '=', bill.id)
              .executeTakeFirstOrThrow()
          ).business_day_id,
          order_id: bill.orderId,
          bill_no: 999999,
          status: 'PRE_BILLED',
          subtotal_paisa: 0,
          discount_paisa: 0,
          service_charge_paisa: 0,
          taxable_paisa: 0,
          tax_paisa: 0,
          round_off_paisa: 0,
          total_paisa: 0,
          created_by: (await t.kdb.selectFrom('users').select('id').executeTakeFirstOrThrow()).id,
        })
        .execute(),
    ).rejects.toMatchObject({ code: '23505' });
  });
});

describe('void', () => {
  it('voids an unpaid bill, reopens the order, audits, and lets a new bill be made', async () => {
    const bill = await preBill();
    expect(
      (await api(cashier).post(`/bills/${bill.id}/void`, { reason: 'Guest added a dish' })).status,
    ).toBe(403); // cashier lacks bill.void
    const res = await api(manager).post(`/bills/${bill.id}/void`, { reason: 'Guest added a dish' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('VOID');
    expect((await audit('BILL_VOID')).length).toBeGreaterThan(0);

    const add = await api(captain).post(`/orders/${bill.orderId}/items`, {
      itemId: item.id,
      variantId: item.variantId,
    });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    await api(captain).post(`/orders/${bill.orderId}/send`, {});
    const again = await api(cashier).post(`/orders/${bill.orderId}/bill`);
    expect(again.status).toBe(201);
    expect(again.body.subtotalPaisa).toBe(200000);
  });

  it('refuses to void a settled bill and requires a reason', async () => {
    const bill = await preBill();
    expect((await api(manager).post(`/bills/${bill.id}/void`, {})).status).toBe(400);
    await settle(bill.id, [cash(100000)]);
    const res = await api(manager).post(`/bills/${bill.id}/void`, { reason: 'mistake' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BILL_NOT_PAYABLE');
  });
});

describe('Urdu receipts', () => {
  it('with receipt.language = ur the receipt is a bitmap (no text), still opens the drawer for cash', async () => {
    await setSetting('receipt.language', 'ur');
    try {
      await processPrintJobs(t.ctx, new TcpTransport());
      const before = receiptSim.jobs.length;
      const bill = await preBill();
      await settle(bill.id, [cash(100000, 150000)]);
      await processPrintJobs(t.ctx, new TcpTransport());
      expect(receiptSim.jobs.length).toBe(before + 1);
      const bytes = receiptSim.jobs.at(-1)!;
      expect(bytes.includes(Buffer.from([0x1d, 0x76, 0x30, 0x00]))).toBe(true); // GS v 0 raster
      expect(bytes.includes(Buffer.from([0x1b, 0x70]))).toBe(true); // drawer kick
      expect(bytes.toString('latin1')).not.toContain('TOTAL');
      expect(bytes.length).toBeGreaterThan(5000);
    } finally {
      await t.kdb.deleteFrom('settings').where('key', '=', 'receipt.language').execute();
    }
  });

  it('only en and ur are accepted', async () => {
    expect((await api(owner).put('/settings/receipt.language', { value: 'fr' })).status).toBe(400);
  });
});

describe('reprint', () => {
  it('prints a DUPLICATE copy with a reason, counts it, audits it', async () => {
    const bill = await preBill();
    await settle(bill.id, [cash(100000)]);
    await processPrintJobs(t.ctx, new TcpTransport());

    expect((await api(cashier).post(`/bills/${bill.id}/reprint`, {})).status).toBe(400);
    const res = await api(cashier).post(`/bills/${bill.id}/reprint`, {
      reason: 'Customer lost it',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.duplicate).toBe(1);
    await processPrintJobs(t.ctx, new TcpTransport());
    const copy = receiptSim.tickets().at(-1)!;
    expect(copy).toContain('DUPLICATE #1');
    expect(copy).not.toMatch(/DRAWER|KICK/i);
    const view = await api(cashier).get(`/bills/${bill.id}`);
    expect(view.body.printCount).toBe(2);
    expect((await audit('BILL_REPRINT')).length).toBeGreaterThan(0);
  });

  it('refuses an unsettled bill', async () => {
    const bill = await preBill();
    expect(
      (await api(cashier).post(`/bills/${bill.id}/reprint`, { reason: 'just testing' })).status,
    ).toBe(409);
  });
});

describe('scoping', () => {
  it('another branch cannot see or pay a bill', async () => {
    const bill = await preBill();
    const other = (await t.login('MANAGER2')).token;
    const as2 = t.as(other, t.otherBranchId);
    expect((await as2.get(`/bills/${bill.id}`)).status).toBe(404);
    expect((await as2.post(`/bills/${bill.id}/void`, { reason: 'sneaky' })).status).toBe(404);
  });
});
