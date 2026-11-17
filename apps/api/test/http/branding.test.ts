import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from './app-harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let t: TestApp;
let owner: string;
let cashier: string;
let captain: string;
let branchId = '';
const api = (tok: string) => t.as(tok);

/** The first bytes of a real PNG / JPEG: the server only looks at the signature. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('logo-bytes'),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('photo-bytes')]);

/** Packed 1-bit rows: black on the left half of every row. */
const rasterOf = (widthBytes: number, height: number): { height: number; data: string } => ({
  height,
  data: Buffer.alloc(widthBytes * height, 0xf0).toString('base64'),
});
const logoBody = (over: Json = {}): Json => ({
  image: PNG.toString('base64'),
  raster58: rasterOf(48, 40),
  raster80: rasterOf(72, 60),
  ...over,
});

/** Sends a picture as the raw request body (how the browser uploads a photo). */
const putPhoto = (tok: string, path: string, bytes: Buffer, type = 'image/jpeg') =>
  request(t.app)
    .put(`/api/v1${path}`)
    .set('Authorization', `Bearer ${tok}`)
    .set('x-branch-id', branchId)
    .set('Content-Type', type)
    .send(bytes);

let item: { id: string; variantId: string };
let cashId: string;
let seq = 0;

async function settledBill(): Promise<string> {
  const o = (await api(captain).post('/orders', { type: 'TAKEAWAY' })).body;
  await api(captain).post(`/orders/${o.id}/items`, { itemId: item.id, variantId: item.variantId });
  await api(captain).post(`/orders/${o.id}/send`, {});
  const bill = (await api(cashier).post(`/orders/${o.id}/bill`)).body;
  const res = await api(cashier)
    .post(`/bills/${bill.id}/settle`, {
      tenders: [{ methodId: cashId, amountPaisa: 100000, tenderedPaisa: 100000 }],
    })
    .set('Idempotency-Key', `brand-${Date.now()}-${++seq}`);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return bill.id;
}

beforeAll(async () => {
  t = await startApp();
  owner = (await t.login('OWNER')).token;
  cashier = (await t.login('CASHIER')).token;
  captain = (await t.login('CAPTAIN')).token;
  branchId = (await api(owner).get('/branch')).body.id;
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
  cashId = (
    await api(owner).post('/payment-methods', {
      code: 'CASH',
      name: 'Cash',
      tender_class: 'CASH_OTHER',
      opens_drawer: true,
    })
  ).body.id;
  await api(cashier).post('/business-days/open', {});
  await api(cashier).post('/shifts/open', { openingFloatPaisa: 500000 });
}, 240_000);

afterAll(async () => {
  await t.stop();
});

describe('the restaurant logo', () => {
  it('starts with none; the owner sets it; everyone can see it; /branch says which version', async () => {
    expect((await api(cashier).get('/branch/logo')).status).toBe(404);
    expect((await api(owner).get('/branch')).body.logoVersion).toBeNull();

    const put = await api(owner).put('/branch/logo', logoBody());
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.hasLogo).toBe(true);

    const img = await api(cashier).get('/branch/logo');
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toContain('image/png');
    expect(Buffer.from(img.body).equals(PNG)).toBe(true);
    expect(typeof (await api(cashier).get('/branch')).body.logoVersion).toBe('number');

    const log = await t.kdb
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'BRANCH_LOGO_SET')
      .execute();
    expect(log).toHaveLength(1);
  });

  it('only people who manage settings can change it, and bad input is refused', async () => {
    expect((await api(captain).put('/branch/logo', logoBody())).status).toBe(403);
    expect((await api(captain).delete('/branch/logo')).status).toBe(403);
    // not an image
    const text = await api(owner).put(
      '/branch/logo',
      logoBody({ image: Buffer.from('hello world, not a picture').toString('base64') }),
    );
    expect(text.status).toBe(400);
    // a print version whose size does not match its height
    const wrong = await api(owner).put(
      '/branch/logo',
      logoBody({ raster80: { height: 10, data: Buffer.alloc(100).toString('base64') } }),
    );
    expect(wrong.status).toBe(400);
    // unknown fields are refused
    expect((await api(owner).put('/branch/logo', { ...logoBody(), extra: 1 })).status).toBe(400);
  });

  it('goes onto the thermal bill for the printer paper, and onto the bill a browser prints', async () => {
    // a receipt printer on 80 mm paper
    const pr = await api(owner).post('/printers', {
      name: 'Counter',
      kind: 'RECEIPT',
      conn_type: 'NETWORK',
      host: '127.0.0.1',
      port: 9,
      paper_mm: 80,
    });
    expect(pr.status, JSON.stringify(pr.body)).toBe(201);
    const id = await settledBill();

    const job = await t.kdb
      .selectFrom('print_jobs')
      .select('payload')
      .where('ref_id', '=', id)
      .where('kind', '=', 'RECEIPT')
      .executeTakeFirstOrThrow();
    const bytes = Buffer.from(job.payload as Buffer);
    const at = bytes.indexOf(Buffer.from([0x1d, 0x76, 0x30, 0x00]));
    expect(at).toBeGreaterThan(-1);
    // GS v 0, then width in bytes (72 for 80 mm) and the rows of the 80 mm version (60)
    expect(Array.from(bytes.subarray(at + 4, at + 8))).toEqual([72, 0, 60, 0]);
    const name = (await api(owner).get('/branch')).body.name as string;
    expect(bytes.indexOf(Buffer.from(name.slice(0, 4)))).toBeGreaterThan(at); // the name comes after the logo

    // the printer already printed it, so a browser print is a copy (it needs a reason); it gets the
    // picture itself, not the printer bits
    const browser = await api(cashier).post(`/bills/${id}/browser-print`, {
      reason: 'Customer asked',
    });
    expect(browser.status, JSON.stringify(browser.body)).toBe(201);
    expect(browser.body.logoUrl).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(browser.body.doc.logo).toBeUndefined();
  });

  it('removing it stops it printing', async () => {
    expect((await api(owner).delete('/branch/logo')).status).toBe(200);
    expect((await api(owner).get('/branch')).body.logoVersion).toBeNull();
    const id = await settledBill();
    const job = await t.kdb
      .selectFrom('print_jobs')
      .select('payload')
      .where('ref_id', '=', id)
      .where('kind', '=', 'RECEIPT')
      .executeTakeFirstOrThrow();
    expect(Buffer.from(job.payload as Buffer).indexOf(Buffer.from([0x1d, 0x76, 0x30, 0x00]))).toBe(
      -1,
    );
    const copy = await api(cashier).post(`/bills/${id}/browser-print`, {
      reason: 'Customer asked',
    });
    expect(copy.status, JSON.stringify(copy.body)).toBe(201);
    expect(copy.body.logoUrl).toBeNull();
  });
});

describe('a person’s photo', () => {
  it('anyone can set their own; others in the branch can see it; /auth/me and the user list say so', async () => {
    const me = (await api(owner).get('/auth/me')).body;
    expect(me.avatarVersion).toBeNull();

    const put = await putPhoto(owner, '/users/me/avatar', JPEG);
    expect(put.status, JSON.stringify(put.body)).toBe(200);

    const seen = await api(captain).get(`/users/${me.id}/avatar`);
    expect(seen.status).toBe(200);
    expect(seen.headers['content-type']).toContain('image/jpeg');
    expect(Buffer.from(seen.body).equals(JPEG)).toBe(true);

    expect(typeof (await api(owner).get('/auth/me')).body.avatarVersion).toBe('number');
    const list = (await api(owner).get('/users')).body.items as Json[];
    expect(typeof list.find((u) => u.id === me.id).avatar_version).toBe('number');
    expect(list.find((u) => u.id !== me.id && u.avatar_version === null)).toBeTruthy();

    // each person has their own; the captain cannot change the owner's
    expect((await putPhoto(captain, '/users/me/avatar', JPEG)).status).toBe(200);
    expect((await api(captain).get(`/users/${me.id}/avatar`)).status).toBe(200);
  });

  it('refuses what is not a photo or is too large, and can be removed', async () => {
    expect(
      (await putPhoto(cashier, '/users/me/avatar', Buffer.from('not an image at all'))).status,
    ).toBe(400);
    const big = Buffer.concat([JPEG, Buffer.alloc(160_000)]);
    expect((await putPhoto(cashier, '/users/me/avatar', big)).status).toBe(400);

    const me = (await api(owner).get('/auth/me')).body;
    expect((await api(owner).delete('/users/me/avatar')).status).toBe(200);
    expect((await api(captain).get(`/users/${me.id}/avatar`)).status).toBe(404);
    expect((await api(owner).get('/auth/me')).body.avatarVersion).toBeNull();
  });
});
