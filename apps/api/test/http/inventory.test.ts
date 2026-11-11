import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from './app-harness';
import { SimPrinter } from './sim-printer';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let t: TestApp;
let owner: string;
let manager: string;
let cashier: string;
let captain: string;
let store: string;
let accountant: string;
let tikka: { id: string; variantId: string };
let chops: { id: string; variantId: string };
const lists: { id: string }[] = [];
let station = '';
const M: Record<string, string> = {};
const ING: Record<string, string> = {};
const api = (tok: string) => t.as(tok);
const audit = (action: string) =>
  t.kdb.selectFrom('audit_log').selectAll().where('action', '=', action).orderBy('id').execute();
let keySeq = 0;
const key = () => `inv-key-${Date.now()}-${++keySeq}`;
const onHand = async (id: string): Promise<number> =>
  Number(
    (await api(owner).get('/inventory/ingredients')).body.items.find((i: Json) => i.id === id)
      .onHand,
  );
const ingredient = async (id: string): Promise<Json> =>
  (await api(owner).get('/inventory/ingredients')).body.items.find((i: Json) => i.id === id);

async function mkItem(name: string, price: number, kind: 'STANDARD' | 'WEIGHT' = 'STANDARD') {
  const res = await api(owner).post('/items', { kind, name, stationId: station });
  for (const l of lists)
    await api(owner).put(`/variants/${res.body.variants[0].id}/prices/${l.id}`, {
      pricePaisa: price,
    });
  return { id: res.body.id as string, variantId: res.body.variants[0].id as string };
}
async function sellAndSettle(
  item: { id: string; variantId: string },
  extra: Json = {},
  qty = 1,
): Promise<Json> {
  const o = (await api(captain).post('/orders', { type: 'TAKEAWAY' })).body;
  const add = await api(captain).post(`/orders/${o.id}/items`, {
    itemId: item.id,
    variantId: item.variantId,
    qty,
    ...extra,
  });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  await api(captain).post(`/orders/${o.id}/send`, {});
  const bill = (await api(cashier).post(`/orders/${o.id}/bill`)).body;
  const res = await api(cashier)
    .post(`/bills/${bill.id}/settle`, {
      tenders: [{ methodId: M.CASH, amountPaisa: bill.totalPaisa, tenderedPaisa: bill.totalPaisa }],
    })
    .set('Idempotency-Key', key());
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { order: o, bill: res.body.bill };
}
const purchase = (body: object, tok = store, k = key()) =>
  api(tok).post('/purchases', body).set('Idempotency-Key', k);

beforeAll(async () => {
  t = await startApp();
  owner = (await t.login('OWNER')).token;
  manager = (await t.login('MANAGER')).token;
  cashier = (await t.login('CASHIER')).token;
  captain = (await t.login('CAPTAIN')).token;
  store = (await t.login('STORE')).token;
  accountant = (await t.login('ACCOUNTANT')).token;
  for (const code of ['DINE_IN', 'TAKEAWAY', 'DELIVERY'])
    lists.push((await api(owner).post('/price-lists', { code, name: code })).body);
  station = (await api(owner).post('/stations', { code: 'BBQ', name: 'BBQ' })).body.id;
  tikka = await mkItem('Tikka', 100000);
  chops = await mkItem('Mutton Chops', 480000, 'WEIGHT');
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
  M.CASH = (
    await api(owner).post('/payment-methods', {
      code: 'CASH',
      name: 'Cash',
      tender_class: 'CASH_OTHER',
      opens_drawer: true,
    })
  ).body.id;
  await api(cashier).post('/business-days/open', {});
  await api(cashier).post('/shifts/open', { openingFloatPaisa: 500000 });
  await api(manager).post('/shifts/open', { openingFloatPaisa: 5_000_000 });
}, 240_000);

afterAll(async () => {
  await t.stop();
});

describe('ingredients', () => {
  it('stores the unit chain (kg -> g), yield and opening stock; only stock keepers write', async () => {
    const mk = (body: object, tok = store) => api(tok).post('/inventory/ingredients', body);
    const gosht = await mk({
      name: 'Mutton',
      baseUom: 'g',
      purchaseUom: 'kg',
      purchaseToBase: 1000,
      yieldBps: 10000,
      reorderLevel: 5000,
      openingQty: 4,
      openingCostPaisaPerPurchase: 160000,
    });
    expect(gosht.status, JSON.stringify(gosht.body)).toBe(201);
    ING.mutton = gosht.body.id;
    expect(gosht.body).toMatchObject({ baseUom: 'g', purchaseToBase: '1000.0000', onHand: '4000' });
    expect(Number(gosht.body.avgCostPerBase)).toBe(160); // Rs 1,600/kg = 160 paisa per gram
    expect(gosht.body.needsReorder).toBe(true); // 4 kg < 5 kg level

    ING.masala = (
      await mk({ name: 'Masala', baseUom: 'g', purchaseUom: 'kg', purchaseToBase: 1000 })
    ).body.id;
    ING.boiled = (
      await mk({
        name: 'Boiled mutton',
        baseUom: 'g',
        purchaseUom: 'kg',
        purchaseToBase: 1000,
        isPrep: true,
      })
    ).body.id;
    expect(
      (await mk({ name: 'Mutton', baseUom: 'g', purchaseUom: 'kg', purchaseToBase: 1000 })).status,
    ).toBe(409); // unique per branch
    expect(
      (await mk({ name: 'Bad', baseUom: 'oz', purchaseUom: 'kg', purchaseToBase: 1000 })).status,
    ).toBe(400);
    expect(
      (await mk({ name: 'Zero', baseUom: 'g', purchaseUom: 'kg', purchaseToBase: 0 })).status,
    ).toBe(400);
    expect((await mk({ name: 'Nope' }, cashier)).status).toBe(403);
  });

  it('is listed with stock value; low-stock filter; cashiers may look, captains may not', async () => {
    const all = (await api(cashier).get('/inventory/ingredients')).body.items as Json[];
    expect(all.map((i) => i.name)).toEqual(['Boiled mutton', 'Masala', 'Mutton']);
    const mutton = all.find((i) => i.name === 'Mutton')!;
    expect(mutton.stockValuePaisa).toBe(640000); // 4000 g × 160
    expect(
      ((await api(cashier).get('/inventory/ingredients?low=true')).body.items as Json[]).map(
        (i) => i.name,
      ),
    ).toEqual(['Mutton']);
    expect((await api(captain).get('/inventory/ingredients')).status).toBe(403);
    const patched = await api(store).patch(`/inventory/ingredients/${ING.mutton}`, {
      reorderLevel: 1,
    });
    expect(patched.status).toBe(200);
    expect(patched.body.needsReorder).toBe(false);
    expect((await api(store).patch(`/inventory/ingredients/${ING.mutton}`, {})).status).toBe(400);
  });
});

describe('purchases', () => {
  let supplier = '';
  it('post stock in base units, keep a weighted-average cost, and record what is owed', async () => {
    supplier = (await api(store).post('/suppliers', { name: 'Butcher Ali', phone: '0300-111' }))
      .body.id;
    const before = await onHand(ING.mutton!); // 4000
    const res = await purchase({
      supplierId: supplier,
      invoiceRef: 'INV-1',
      lines: [
        { ingredientId: ING.mutton, qty: 4, unitCostPaisa: 200000 },
        { ingredientId: ING.masala, qty: 1.5, unitCostPaisa: 80000 },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ totalPaisa: 920000, paidPaisa: 0, owedPaisa: 920000 }); // 4×2000 + 1.5×800 = 8000 + 1200 (Rs)
    expect(await onHand(ING.mutton!)).toBe(before + 4000);
    // 4 kg at Rs 1,600 + 4 kg at Rs 2,000 -> Rs 1,800/kg = 180 paisa per gram
    expect(Number((await ingredient(ING.mutton!)).avgCostPerBase)).toBe(180);
    expect(Number((await ingredient(ING.masala!)).avgCostPerBase)).toBe(80);

    const sup = ((await api(store).get('/suppliers')).body.items as Json[]).find(
      (s) => s.id === supplier,
    )!;
    expect(sup).toMatchObject({ purchasedPaisa: 920000, paidPaisa: 0, owedPaisa: 920000 });
    expect((await audit('PURCHASE_POST')).length).toBe(1);
  });

  it('is idempotent, refuses a duplicate supplier invoice and bad lines', async () => {
    const k = key();
    const body = {
      supplierId: supplier,
      invoiceRef: 'INV-2',
      lines: [{ ingredientId: ING.masala, qty: 1, unitCostPaisa: 80000 }],
    };
    const first = await purchase(body, store, k);
    expect(first.status).toBe(201);
    const again = await purchase(body, store, k);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect((await purchase(body)).status).toBe(409); // same invoice, new key
    expect((await purchase({ lines: [] })).status).toBe(400);
    expect(
      (
        await purchase({
          lines: [
            { ingredientId: ING.masala, qty: 1, unitCostPaisa: 1 },
            { ingredientId: ING.masala, qty: 1, unitCostPaisa: 1 },
          ],
        })
      ).status,
    ).toBe(400);
    expect(
      (await purchase({ lines: [{ ingredientId: ING.masala, qty: 1.2345, unitCostPaisa: 1 }] }))
        .status,
    ).toBe(400);
    expect(
      (
        await purchase(
          {
            supplierId: supplier,
            lines: [{ ingredientId: ING.masala, qty: 1, unitCostPaisa: 1 }],
            payment: { amountPaisa: 5, source: 'BANK' },
          },
          cashier,
        )
      ).status,
    ).toBe(403);
  });

  it('paying needs expense.manage; cash from the drawer also leaves the till; no overpaying a supplier', async () => {
    // the store keeper may buy but not pay
    const noPay = await purchase(
      {
        supplierId: supplier,
        lines: [{ ingredientId: ING.masala, qty: 1, unitCostPaisa: 100 }],
        payment: { amountPaisa: 100, source: 'BANK' },
      },
      store,
    );
    expect(noPay.status).toBe(403);

    const drawerBefore = (
      await api(manager).get(
        `/shifts/${(await api(manager).get('/shifts/current')).body.shift.id}/report`,
      )
    ).body.expectedCashPaisa;
    const paid = await purchase(
      {
        supplierId: supplier,
        invoiceRef: 'INV-3',
        lines: [{ ingredientId: ING.masala, qty: 1, unitCostPaisa: 50000 }],
        payment: { amountPaisa: 50000, source: 'DRAWER_CASH' },
      },
      manager,
    );
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body).toMatchObject({ paidPaisa: 50000, owedPaisa: 0 });
    const drawerAfter = (
      await api(manager).get(
        `/shifts/${(await api(manager).get('/shifts/current')).body.shift.id}/report`,
      )
    ).body.expectedCashPaisa;
    expect(drawerAfter).toBe(drawerBefore - 50000);

    const later = await api(accountant)
      .post(`/suppliers/${supplier}/payments`, { amountPaisa: 400000, source: 'BANK' })
      .set('Idempotency-Key', key());
    expect(later.status, JSON.stringify(later.body)).toBe(201);
    const over = await api(accountant)
      .post(`/suppliers/${supplier}/payments`, { amountPaisa: 99_000_000, source: 'BANK' })
      .set('Idempotency-Key', key());
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('SUPPLIER_OVERPAYMENT');
    expect(
      (
        await api(cashier)
          .post(`/suppliers/${supplier}/payments`, { amountPaisa: 1, source: 'BANK' })
          .set('Idempotency-Key', key())
      ).status,
    ).toBe(403);
    const huge = await api(manager)
      .post(`/suppliers/${supplier}/payments`, { amountPaisa: 100_000, source: 'DRAWER_CASH' })
      .set('Idempotency-Key', key());
    expect([201, 400]).toContain(huge.status);
  });
});

describe('recipes and food cost at the till', () => {
  it('sets a recipe, shows its cost and margin', async () => {
    const set = await api(store).put(`/variants/${tikka.variantId}/recipe`, {
      lines: [
        { ingredientId: ING.mutton, qty: 250 },
        { ingredientId: ING.masala, qty: 10 },
      ],
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    // 250 g × 180 + 10 g × 71.43 (masala averaged over three purchases) = 45000 + 714
    expect(set.body.costPaisa).toBe(45714);
    expect(
      (
        await api(store).put(`/variants/${tikka.variantId}/recipe`, {
          lines: [{ ingredientId: ING.mutton, qty: 0 }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api(store).put(`/variants/${tikka.variantId}/recipe`, {
          lines: [
            { ingredientId: ING.mutton, qty: 1 },
            { ingredientId: ING.mutton, qty: 2 },
          ],
        })
      ).status,
    ).toBe(400);

    expect(
      (
        await api(store).put(`/variants/${chops.variantId}/recipe`, {
          lines: [{ ingredientId: ING.mutton, qty: 1000 }],
        })
      ).status,
    ).toBe(200); // per kg sold
    const margins = (await api(store).get('/inventory/margins')).body.items as Json[];
    const m = margins.find((x) => x.item === 'Tikka')!;
    expect(m).toMatchObject({ costPaisa: 45714, pricePaisa: 100000, foodCostBps: 4571 });
    expect(
      (await api(cashier).put(`/variants/${tikka.variantId}/recipe`, { lines: [] })).status,
    ).toBe(403);
    expect((await audit('RECIPE_SET')).length).toBeGreaterThanOrEqual(2);
  });

  it('settling a bill takes the ingredients out of stock once, with a cost snapshot; weights scale', async () => {
    const mutton0 = await onHand(ING.mutton!);
    const masala0 = await onHand(ING.masala!);
    const { order, bill } = await sellAndSettle(tikka, {}, 2);
    expect(await onHand(ING.mutton!)).toBe(mutton0 - 500);
    expect(await onHand(ING.masala!)).toBe(masala0 - 20);
    const line = await t.kdb
      .selectFrom('order_items')
      .select('cost_paisa_snapshot')
      .where('order_id', '=', order.id)
      .executeTakeFirstOrThrow();
    expect(line.cost_paisa_snapshot).toBe(91429); // 500 g × 180 + 20 g × 71.428571, rounded once per ingredient
    const sales = await t.kdb
      .selectFrom('stock_movements')
      .selectAll()
      .where('kind', '=', 'SALE')
      .where('ref_type', '=', 'ORDER_ITEM')
      .execute();
    expect(sales.length).toBeGreaterThanOrEqual(2);
    expect(sales.every((m) => Number(m.qty_base) < 0 && m.unit_cost_per_base !== null)).toBe(true);

    // the same settle key again does not deduct twice
    const dup = await api(cashier)
      .post(`/bills/${bill.id}/settle`, {
        tenders: [{ methodId: M.CASH, amountPaisa: bill.totalPaisa }],
      })
      .set('Idempotency-Key', key());
    expect(dup.status).toBe(409);
    expect(await onHand(ING.mutton!)).toBe(mutton0 - 500);

    // 750 g of chops: the recipe is per 1000 g
    const before = await onHand(ING.mutton!);
    await sellAndSettle(chops, { weightG: 750 });
    expect(await onHand(ING.mutton!)).toBe(before - 750);
  });

  it('selling below zero stock is allowed and shows up as negative stock', async () => {
    const level = await onHand(ING.mutton!);
    await sellAndSettle(tikka, {}, Math.ceil(level / 250) + 2);
    expect(await onHand(ING.mutton!)).toBeLessThan(0);
  });

  it('items without a recipe change nothing and break nothing', async () => {
    const plain = await mkItem('Cola', 10000);
    const before = (await t.kdb.selectFrom('stock_movements').select('id').execute()).length;
    const { order } = await sellAndSettle(plain);
    expect((await t.kdb.selectFrom('stock_movements').select('id').execute()).length).toBe(before);
    expect(
      (
        await t.kdb
          .selectFrom('order_items')
          .select('cost_paisa_snapshot')
          .where('order_id', '=', order.id)
          .executeTakeFirstOrThrow()
      ).cost_paisa_snapshot,
    ).toBeNull();
  });
});

describe('wastage, staff meals and prep batches', () => {
  it('wastage needs a reason, removes stock at cost and is audited; replays are safe', async () => {
    await purchase({ lines: [{ ingredientId: ING.mutton, qty: 20, unitCostPaisa: 180000 }] });
    const before = await onHand(ING.mutton!);
    const bad = await api(store)
      .post('/inventory/wastage', { ingredientId: ING.mutton, qty: 500 })
      .set('Idempotency-Key', key());
    expect(bad.status).toBe(400);
    const k = key();
    const ok = await api(store)
      .post('/inventory/wastage', {
        ingredientId: ING.mutton,
        qty: 500,
        reasonCode: 'SPOILAGE',
        note: 'Fridge failed',
      })
      .set('Idempotency-Key', k);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.valuePaisa).toBeGreaterThan(0);
    expect(
      (
        await api(store)
          .post('/inventory/wastage', {
            ingredientId: ING.mutton,
            qty: 500,
            reasonCode: 'SPOILAGE',
          })
          .set('Idempotency-Key', k)
      ).status,
    ).toBe(200);
    expect(await onHand(ING.mutton!)).toBe(before - 500);
    const meal = await api(store)
      .post('/inventory/wastage', { ingredientId: ING.masala, qty: 20, kind: 'STAFF_MEAL' })
      .set('Idempotency-Key', key());
    expect(meal.status).toBe(201);
    expect((await audit('STOCK_WASTAGE')).length).toBe(1);
    expect(
      (
        await api(cashier)
          .post('/inventory/wastage', { ingredientId: ING.mutton, qty: 1, reasonCode: 'X' })
          .set('Idempotency-Key', key())
      ).status,
    ).toBe(403);
  });

  it('a prep batch turns raw ingredients into a prepared one and carries the cost', async () => {
    expect(
      (
        await api(store)
          .post('/inventory/prep-batches', { ingredientId: ING.boiled, batches: 1 })
          .set('Idempotency-Key', key())
      ).status,
    ).toBe(409); // no recipe yet
    expect(
      (
        await api(store).put(`/inventory/ingredients/${ING.masala}/recipe`, {
          outputQty: 1,
          lines: [],
        })
      ).status,
    ).toBe(400); // not a prep item
    const r = await api(store).put(`/inventory/ingredients/${ING.boiled}/recipe`, {
      outputQty: 8000,
      lines: [
        { ingredientId: ING.mutton, qty: 10000 },
        { ingredientId: ING.masala, qty: 200 },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(
      (
        await api(store).put(`/inventory/ingredients/${ING.boiled}/recipe`, {
          outputQty: 1,
          lines: [{ ingredientId: ING.boiled, qty: 1 }],
        })
      ).status,
    ).toBe(400); // not from itself

    const mutton0 = await onHand(ING.mutton!);
    const k = key();
    const batch = await api(store)
      .post('/inventory/prep-batches', { ingredientId: ING.boiled, batches: 1 })
      .set('Idempotency-Key', k);
    expect(batch.status, JSON.stringify(batch.body)).toBe(201);
    expect(batch.body.made).toBe('8000');
    expect(await onHand(ING.mutton!)).toBe(mutton0 - 10000);
    expect(await onHand(ING.boiled!)).toBe(8000);
    expect(
      (
        await api(store)
          .post('/inventory/prep-batches', { ingredientId: ING.boiled, batches: 1 })
          .set('Idempotency-Key', k)
      ).status,
    ).toBe(200); // replay
    expect(await onHand(ING.boiled!)).toBe(8000);
    // the prepared item carries the cost of what went into it (per gram, on the 8000 g it made)
    const cost = Number((await ingredient(ING.boiled!)).avgCostPerBase);
    expect(cost).toBeGreaterThan(200);
    expect(cost).toBeLessThan(300);
  });
});

describe('stocktake', () => {
  it('counts become adjustments; uncounted lines are left alone; a posted count is history', async () => {
    const st = await api(store).post('/stocktakes');
    expect(st.status, JSON.stringify(st.body)).toBe(201);
    expect((await api(store).post('/stocktakes')).status).toBe(409); // one open count at a time
    const id = st.body.id as string;
    const mutton = st.body.lines.find((l: Json) => l.name === 'Mutton');
    const system = Number(mutton.systemQty);
    expect(mutton.countedQty).toBeNull();

    const counted = await api(store).put(`/stocktakes/${id}/lines`, {
      ingredientId: ING.mutton,
      countedQty: system - 300,
    });
    expect(counted.body.lines.find((l: Json) => l.name === 'Mutton').varianceQty).toBe('-300');
    await api(store).put(`/stocktakes/${id}/lines`, {
      ingredientId: ING.masala,
      countedQty: Number(st.body.lines.find((l: Json) => l.name === 'Masala').systemQty),
    }); // no difference

    const before = await onHand(ING.mutton!);
    const boiled = await onHand(ING.boiled!);
    const posted = await api(store).post(`/stocktakes/${id}/post`);
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expect(posted.body.adjusted).toBe(1);
    expect(posted.body.varianceValuePaisa).toBeLessThan(0);
    expect(await onHand(ING.mutton!)).toBe(before - 300);
    expect(await onHand(ING.boiled!)).toBe(boiled); // not counted: untouched

    expect((await api(store).post(`/stocktakes/${id}/post`)).status).toBe(409);
    expect(
      (await api(store).put(`/stocktakes/${id}/lines`, { ingredientId: ING.mutton, countedQty: 1 }))
        .status,
    ).toBe(409);
    await expect(
      t.kdb
        .updateTable('stocktake_lines')
        .set({ counted_qty: '1' })
        .where('stocktake_id', '=', id)
        .execute(),
    ).rejects.toBeTruthy();
    expect((await api(store).post('/stocktakes')).status).toBe(201); // a new one can start
    expect((await audit('STOCKTAKE_POST')).length).toBe(1);
    expect((await api(captain).post('/stocktakes')).status).toBe(403);
  });
});

describe('food cost report', () => {
  it('shows revenue, cost, margin and food cost % per item, and wastage', async () => {
    const day = (await api(manager).get('/business-days/current')).body.day;
    const rep = (
      await api(owner).get(`/inventory/food-cost?from=${day.businessDate}&to=${day.businessDate}`)
    ).body;
    const tk = rep.items.find((i: Json) => i.name === 'Tikka');
    expect(tk.revenuePaisa).toBeGreaterThan(0);
    expect(tk.costPaisa).toBeGreaterThan(0);
    expect(tk.foodCostBps).toBeGreaterThan(0);
    expect(rep.totals.marginPaisa).toBe(rep.totals.revenuePaisa - rep.totals.costPaisa);
    expect(rep.wastagePaisa).toBeGreaterThan(0);
    expect(rep.items.find((i: Json) => i.name === 'Cola').uncostedLines).toBeGreaterThan(0); // no recipe: flagged
    expect(
      (
        await api(cashier).get(
          `/inventory/food-cost?from=${day.businessDate}&to=${day.businessDate}`,
        )
      ).status,
    ).toBe(403);
    expect((await api(owner).get('/inventory/food-cost?from=bad&to=bad')).status).toBe(400);
  });
});

describe('expenses', () => {
  it('drawer expenses leave the till; others do not; reasons and keys are required', async () => {
    const shift = (await api(manager).get('/shifts/current')).body.shift.id;
    const exp = async (): Promise<number> =>
      (await api(manager).get(`/shifts/${shift}/report`)).body.expectedCashPaisa;
    const before = await exp();
    const k = key();
    const e = await api(manager)
      .post('/expenses', {
        category: 'gas',
        amountPaisa: 120000,
        paidFrom: 'DRAWER_CASH',
        note: 'Cylinder',
      })
      .set('Idempotency-Key', k);
    expect(e.status, JSON.stringify(e.body)).toBe(201);
    expect(await exp()).toBe(before - 120000);
    expect(
      (
        await api(manager)
          .post('/expenses', { category: 'gas', amountPaisa: 120000, paidFrom: 'DRAWER_CASH' })
          .set('Idempotency-Key', k)
      ).status,
    ).toBe(200); // replay
    expect(await exp()).toBe(before - 120000);

    expect(
      (
        await api(owner)
          .post('/expenses', { category: 'RENT', amountPaisa: 5_000_000, paidFrom: 'BANK' })
          .set('Idempotency-Key', key())
      ).status,
    ).toBe(201);
    expect(
      (
        await api(manager)
          .post('/expenses', { category: 'GAS', amountPaisa: 99_000_000, paidFrom: 'DRAWER_CASH' })
          .set('Idempotency-Key', key())
      ).body.reason,
    ).toBe('DRAWER_INSUFFICIENT_CASH');
    expect(
      (
        await api(owner)
          .post('/expenses', { category: 'RENT', amountPaisa: 1, paidFrom: 'DRAWER_CASH' })
          .set('Idempotency-Key', key())
      ).body.code,
    ).toBe('SHIFT_NOT_OPEN'); // the owner has no drawer open
    expect(
      (
        await api(manager).post('/expenses', {
          category: 'GAS',
          amountPaisa: 100,
          paidFrom: 'BANK',
        })
      ).status,
    ).toBe(400); // no key
    expect(
      (
        await api(cashier)
          .post('/expenses', { category: 'GAS', amountPaisa: 100, paidFrom: 'BANK' })
          .set('Idempotency-Key', key())
      ).status,
    ).toBe(403);

    const day = (await api(manager).get('/business-days/current')).body.day;
    const list = (
      await api(accountant).get(`/expenses?from=${day.businessDate}&to=${day.businessDate}`)
    ).body;
    expect(list.totalPaisa).toBe(5_120_000);
    expect(list.byCategory[0]).toEqual({ category: 'RENT', totalPaisa: 5_000_000 });
  });
});

describe('database guards', () => {
  it('the stock ledger is append-only and sign-checked; purchases and expenses are immutable', async () => {
    await expect(
      t.kdb.updateTable('stock_movements').set({ note: 'x' }).execute(),
    ).rejects.toBeTruthy();
    await expect(t.kdb.deleteFrom('stock_movements').execute()).rejects.toBeTruthy();
    const base = { branch_id: t.branchId, ingredient_id: ING.mutton!, created_by: null };
    await expect(
      t.kdb
        .insertInto('stock_movements')
        .values({ ...base, kind: 'SALE', qty_base: '5' })
        .execute(),
    ).rejects.toBeTruthy(); // a sale cannot add stock
    await expect(
      t.kdb
        .insertInto('stock_movements')
        .values({ ...base, kind: 'PURCHASE', qty_base: '-5' })
        .execute(),
    ).rejects.toBeTruthy();
    await expect(
      t.kdb
        .insertInto('stock_movements')
        .values({ ...base, branch_id: t.otherBranchId, kind: 'PURCHASE', qty_base: '5' })
        .execute(),
    ).rejects.toBeTruthy(); // other branch
    await expect(
      t.kdb.updateTable('purchases').set({ total_paisa: 1 }).execute(),
    ).rejects.toBeTruthy();
    await expect(t.kdb.deleteFrom('purchase_lines').execute()).rejects.toBeTruthy();
    await expect(
      t.kdb.updateTable('expenses').set({ amount_paisa: 1 }).execute(),
    ).rejects.toBeTruthy();
  });
});
