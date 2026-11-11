import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from './app-harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let t: TestApp;
let owner: string;
let cashier: string;
let karahi: { id: string };
const api = (tok: string) => t.as(tok);
let branchId = '';
const get = () => request(t.app).get(`/api/v1/public/menu?branch=${branchId}`);
const setting = (key: string, value: unknown) => api(owner).put(`/settings/${key}`, { value });

beforeAll(async () => {
  t = await startApp();
  owner = (await t.login('OWNER')).token;
  cashier = (await t.login('CASHIER')).token;
  branchId = (await api(owner).get('/branch')).body.id;
  const dine = (await api(owner).post('/price-lists', { code: 'DINE_IN', name: 'Dine in' })).body;
  const station = (await api(owner).post('/stations', { code: 'BBQ', name: 'BBQ' })).body.id;
  const cat = (await api(owner).post('/categories', { name: 'Grill', nameUr: 'گرل' })).body;
  const mk = async (name: string, price: number | null, extra: Json = {}): Promise<Json> => {
    const res = await api(owner).post('/items', {
      kind: 'STANDARD',
      name,
      stationId: station,
      categoryId: cat.id,
      ...extra,
    });
    if (price !== null)
      await api(owner).put(`/variants/${res.body.variants[0].id}/prices/${dine.id}`, {
        pricePaisa: price,
      });
    return { id: res.body.id, variantId: res.body.variants[0].id };
  };
  await mk('Tikka', 45000, { nameUr: 'تکہ' });
  karahi = await mk('Karahi', 220000);
  await mk('No price yet', null);
  const hidden = await mk('Hidden', 10000);
  await api(owner).patch(`/items/${hidden.id}`, { isActive: false });
  await api(owner).patch(`/branch`, { name: 'Lahore Karahi House', phone: '0300 1234567' });
}, 240_000);

afterAll(async () => {
  await t.stop();
});

describe('GET /public/menu', () => {
  it('is off until the owner switches it on, and needs no login once it is', async () => {
    const off = await get();
    expect(off.status).toBe(404);
    expect(off.body.code).toBe('MENU_NOT_PUBLIC');

    expect((await setting('menu.public_enabled', true)).status).toBe(200);
    const on = await get();
    expect(on.status).toBe(200);
    expect(on.body.restaurant).toMatchObject({
      name: 'Lahore Karahi House',
      phone: '0300 1234567',
    });
  });

  it('lists only what a customer may see: priced, active dishes with their prices', async () => {
    const r = await get();
    const names = r.body.items.map((i: Json) => i.name).sort();
    expect(names).toEqual(['Karahi', 'Tikka']); // not the unpriced one, not the inactive one
    const tikkaRow = r.body.items.find((i: Json) => i.name === 'Tikka');
    expect(tikkaRow).toMatchObject({
      nameUr: 'تکہ',
      available: true,
      variants: [expect.objectContaining({ pricePaisa: 45000 })],
    });
    expect(r.body.categories).toEqual([expect.objectContaining({ name: 'Grill', nameUr: 'گرل' })]);
  });

  it('never exposes internals: codes, stations, costs, search terms, modifiers, ids of variants', async () => {
    const text = JSON.stringify((await get()).body);
    for (const leak of ['station', 'searchTerms', 'cost', 'modifier', 'variantId', 'code', 'BBQ'])
      expect(text).not.toContain(leak);
  });

  it('shows a dish that is 86d as sold out, and the note for today', async () => {
    await api(owner).patch(`/items/${karahi.id}/availability`, { isAvailable: false });
    await setting('menu.public_note', 'Fresh naan after 7 pm');
    const r = await get();
    expect(r.body.items.find((i: Json) => i.name === 'Karahi').available).toBe(false);
    expect(r.body.note).toBe('Fresh naan after 7 pm');
  });

  it('answers a repeat scan with 304 and caches for half a minute', async () => {
    const first = await get();
    expect(first.headers['cache-control']).toContain('max-age=30');
    const again = await get().set('If-None-Match', first.headers.etag as string);
    expect(again.status).toBe(304);
  });

  it('only people with settings.manage can change it, and the address must be http(s)', async () => {
    const denied = await api(cashier).put('/settings/menu.public_enabled', { value: false });
    expect(denied.status).toBe(403);
    expect((await setting('menu.public_url', 'javascript:alert(1)')).status).toBe(400);
    expect((await setting('menu.public_url', 'http://192.168.1.10:8080')).status).toBe(200);
    // switching it off closes the door again
    await setting('menu.public_enabled', false);
    expect((await get()).status).toBe(404);
    await setting('menu.public_enabled', true);
  });

  it('needs to know which branch when there are several', async () => {
    const r = await request(t.app).get(
      '/api/v1/public/menu?branch=00000000-0000-4000-8000-000000000000',
    );
    expect(r.status).toBe(404);
  });

  it('is read-only and rate limited', async () => {
    expect((await request(t.app).post('/api/v1/public/menu').send({})).status).toBe(404);
    let limited = 0;
    for (let i = 0; i < 260; i++) if ((await get()).status === 429) limited += 1;
    expect(limited).toBeGreaterThan(0);
  });
});
