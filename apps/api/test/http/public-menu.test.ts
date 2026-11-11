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
const putImage = (tok: string, id: string, bytes: Buffer, type = 'application/octet-stream') =>
  request(t.app)
    .put(`/api/v1/items/${id}/image`)
    .set('Authorization', `Bearer ${tok}`)
    .set('x-branch-id', branchId)
    .set('Content-Type', type)
    .send(bytes);
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

  describe('what guests see about a dish', () => {
    // a real 1x1 PNG
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGO42aMNAAPSAZGjv8RZAAAAAElFTkSuQmCC',
      'base64',
    );
    let dish: { id: string };
    beforeAll(async () => {
      const cat = (await api(owner).get('/categories')).body.items[0];
      dish = (
        await api(owner).post('/items', {
          kind: 'STANDARD',
          name: 'Seekh Kabab',
          categoryId: cat.id,
          description: 'Minced beef on the skewer',
          descriptionUr: 'سیخ پر بنا قیمہ',
          guestTags: ['HALAL', 'SPICY'],
          allergens: ['MILK', 'GLUTEN'],
        })
      ).body;
      const v = (await api(owner).get(`/items/${dish.id}`)).body.variants[0];
      const dine = (await api(owner).get('/price-lists')).body.items[0];
      await api(owner).put(`/variants/${v.id}/prices/${dine.id}`, { pricePaisa: 90000 });
    });

    it('shows the description, labels and allergens the owner entered', async () => {
      const row = (await get()).body.items.find((i: Json) => i.name === 'Seekh Kabab');
      expect(row).toMatchObject({
        description: 'Minced beef on the skewer',
        descriptionUr: 'سیخ پر بنا قیمہ',
        tags: ['HALAL', 'SPICY'],
        allergens: ['MILK', 'GLUTEN'],
        imageUrl: null,
      });
    });

    it('rejects labels that are not on the list, and long descriptions', async () => {
      const bad = await api(owner).patch(`/items/${dish.id}`, { guestTags: ['GLUTEN_FREE'] });
      expect(bad.status).toBe(400);
      expect((await api(owner).patch(`/items/${dish.id}`, { allergens: ['PEANUT'] })).status).toBe(
        400,
      );
      expect(
        (await api(owner).patch(`/items/${dish.id}`, { description: 'x'.repeat(301) })).status,
      ).toBe(400);
    });

    it('serves a photo only after the owner uploads it, with a versioned address', async () => {
      const up = await putImage(owner, dish.id, png, 'application/octet-stream');
      expect(up.status).toBe(200);
      const row = (await get()).body.items.find((i: Json) => i.name === 'Seekh Kabab');
      expect(row.imageUrl).toContain(`/api/v1/public/items/${dish.id}/image?v=`);
      const img = await request(t.app).get(row.imageUrl);
      expect(img.status).toBe(200);
      expect(img.headers['content-type']).toContain('image/png');
      expect(img.headers['cache-control']).toContain('immutable');
      expect(img.headers['x-content-type-options']).toBe('nosniff');
      expect(Buffer.compare(img.body, png)).toBe(0);
      const again = await request(t.app)
        .get(row.imageUrl)
        .set('If-None-Match', img.headers.etag as string);
      expect(again.status).toBe(304);
    });

    it('refuses anything that is not a photo, and photos from people without menu rights', async () => {
      const svg = await putImage(
        owner,
        dish.id,
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'),
        'image/png',
      );
      expect(svg.status).toBe(400);
      const huge = await putImage(
        owner,
        dish.id,
        Buffer.concat([png, Buffer.alloc(700_000)]),
        'image/png',
      );
      expect(huge.status).toBe(413);
      const nope = await putImage(cashier, dish.id, png, 'image/png');
      expect(nope.status).toBe(403);
    });

    it('keeps an item the owner hides off the guest menu, its photo and any deal that lists it', async () => {
      const deal = (await api(owner).post('/items', { kind: 'DEAL', name: 'Kabab Platter' })).body;
      const dealVariant = (await api(owner).get(`/items/${deal.id}`)).body.variants[0];
      const dine = (await api(owner).get('/price-lists')).body.items[0];
      await api(owner).put(`/variants/${dealVariant.id}/prices/${dine.id}`, { pricePaisa: 150000 });
      const kabab = (await api(owner).get(`/items/${dish.id}`)).body.variants[0];
      expect(
        (
          await api(owner).put(`/items/${deal.id}/deal`, {
            slots: [
              {
                name: 'Main',
                qty: 1,
                options: [{ variantId: kabab.id, priceDeltaPaisa: 0, isDefault: true }],
              },
            ],
          })
        ).status,
      ).toBe(200);
      const before = (await get()).body.items.find((i: Json) => i.name === 'Kabab Platter');
      expect(before.dealSlots[0].options.map((o: Json) => o.name)).toEqual(['Seekh Kabab']);
      const url = (await get()).body.items.find((i: Json) => i.name === 'Seekh Kabab').imageUrl;

      expect((await api(owner).patch(`/items/${dish.id}`, { hiddenFromGuests: true })).status).toBe(
        200,
      );
      const body = (await get()).body;
      expect(body.items.map((i: Json) => i.name)).not.toContain('Seekh Kabab');
      const platter = body.items.find((i: Json) => i.name === 'Kabab Platter');
      expect(platter.dealSlots[0].options).toEqual([]);
      expect((await request(t.app).get(url)).status).toBe(404);
      // still on the till's own menu
      const pos = (await api(owner).get('/menu')).body;
      expect(pos.items.map((i: Json) => i.name)).toContain('Seekh Kabab');
      await api(owner).patch(`/items/${dish.id}`, { hiddenFromGuests: false });
    });

    it('removes a photo on request', async () => {
      expect((await api(owner).delete(`/items/${dish.id}/image`)).status).toBe(200);
      const row = (await get()).body.items.find((i: Json) => i.name === 'Seekh Kabab');
      expect(row.imageUrl).toBeNull();
    });
  });

  it('is read-only and rate limited', async () => {
    expect((await request(t.app).post('/api/v1/public/menu').send({})).status).toBe(404);
    let limited = 0;
    for (let i = 0; i < 260; i++) if ((await get()).status === 429) limited += 1;
    expect(limited).toBeGreaterThan(0);
  });
});
