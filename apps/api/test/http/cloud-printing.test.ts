import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disableLanPrinting } from '../../src/modules/printing/print.service';
import { startApp, type TestApp } from './app-harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/**
 * In the cloud the API cannot reach a restaurant's LAN printer (and runs no print worker): a NETWORK printer there
 * would take the job and never print it. The screen must be told there is no printer, so it opens the print modal.
 */
let t: TestApp;
let owner: string;
let cashier: string;
let dish: { id: string; variantId: string };
const api = (tok: string) => t.as(tok);
let n = 0;
const key = () => `cloud-key-${Date.now()}-${++n}`;

beforeAll(async () => {
  disableLanPrinting();
  t = await startApp();
  owner = (await t.login('OWNER')).token;
  cashier = (await t.login('CASHIER')).token;
  const list = (await api(owner).post('/price-lists', { code: 'TAKEAWAY', name: 'Takeaway' })).body
    .id;
  for (const kind of ['KOT', 'RECEIPT'])
    await api(owner).post('/printers', {
      name: `LAN ${kind}`,
      kind,
      conn_type: 'NETWORK',
      host: '192.168.1.50',
      port: 9100,
      paper_mm: 80,
    });
  const item = await api(owner).post('/items', { kind: 'STANDARD', name: 'Naan' });
  await api(owner).put(`/variants/${item.body.variants[0].id}/prices/${list}`, {
    pricePaisa: 5000,
  });
  dish = { id: item.body.id, variantId: item.body.variants[0].id };
  await api(cashier).post('/business-days/open', {});
}, 240_000);
afterAll(async () => {
  await t.stop();
});

describe('a LAN printer configured in the cloud does not count', () => {
  it('the token has no printer: the screen gets the slip to print in the browser', async () => {
    const o = (await api(cashier).post('/orders', { type: 'TAKEAWAY' })).body;
    await api(cashier).post(`/orders/${o.id}/items`, {
      itemId: dish.id,
      variantId: dish.variantId,
      qty: 1,
    });
    const tok = await api(cashier)
      .post(`/orders/${o.id}/print-token`)
      .set('Idempotency-Key', key());
    expect(tok.status).toBe(201);
    expect(tok.body.printers).toBe(0);
    expect(tok.body.browser.doc).toMatchObject({ orderNo: o.orderNo, orderType: 'TAKEAWAY' });
    // nothing was queued for a printer that can never print it
    expect(await t.kdb.selectFrom('print_jobs').select('id').execute()).toHaveLength(0);
  });

  it('Print KOT reports the station as unprinted and returns the ticket; the bill likewise', async () => {
    const o = (await api(cashier).post('/orders', { type: 'TAKEAWAY' })).body;
    await api(cashier).post(`/orders/${o.id}/items`, {
      itemId: dish.id,
      variantId: dish.variantId,
      qty: 2,
    });
    const sent = await api(cashier).post(`/orders/${o.id}/send`, {});
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(sent.body.unprinted).toEqual(['KITCHEN']);
    expect(sent.body.ticket.sections[0].lines[0]).toMatchObject({ name: 'Naan', qty: 2 });
    const bill = await api(cashier)
      .post(`/orders/${o.id}/print-bill`)
      .set('Idempotency-Key', key());
    expect(bill.body.printers).toBe(0);
    expect(bill.body.browser.doc).toMatchObject({ provisional: true });
    expect((await t.kdb.selectFrom('print_jobs').select('id').execute()) as Json[]).toHaveLength(0);
  });
});
