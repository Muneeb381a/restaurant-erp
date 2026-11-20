import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// Runs against the PRODUCTION build (the service worker only exists there). See playwright.pwa.config.ts.
async function login(page: Page, username: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill(username);
  for (const d of '1234') await page.getByRole('button', { name: d, exact: true }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Tables', exact: true })).toBeVisible();
}

test('with no internet the app still opens on a refresh, and so does a screen nobody visited yet', async ({
  page,
  context,
}) => {
  await login(page, 'owner');
  // the service worker stores the whole app when it installs
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const names = await caches.keys();
          if (!names.includes('erp-shell-v2') || !names.includes('erp-files-v2')) return 0;
          return (await (await caches.open('erp-files-v2')).keys()).length;
        }),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(20);

  await context.setOffline(true);

  // a plain refresh: the shell and its files come from the device
  await page.reload();
  await expect(page.getByRole('link', { name: 'Tables' }).first()).toBeVisible();
  await expect(page.getByText('Something went wrong')).toHaveCount(0);

  // a screen this device never opened: its code was stored at install, not fetched now
  await page.goto('/bills');
  await expect(page.getByRole('heading', { name: 'Bills', exact: true })).toBeVisible();
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
});

test('with no internet a table can be opened, a dish added, and it all reaches the server when the internet is back', async ({
  page,
  context,
  request,
}) => {
  const API = 'http://127.0.0.1:18082/api/v1';
  const tok = (
    await (
      await request.post(`${API}/auth/login`, {
        data: { username: 'cashier', password: 'Dev#Passw0rd' },
      })
    ).json()
  ).accessToken as string;
  const auth = { Authorization: `Bearer ${tok}` };
  const ownerTok = (
    await (
      await request.post(`${API}/auth/login`, {
        data: { username: 'owner', password: 'Dev#Passw0rd' },
      })
    ).json()
  ).accessToken as string;
  const own = { Authorization: `Bearer ${ownerTok}` };
  const imp = await request.post(`${API}/menu/import?dryRun=false`, {
    headers: { ...own, 'content-type': 'text/csv; charset=utf-8' },
    data: readFileSync('docs/samples/desi-menu.csv'),
  });
  expect(imp.ok(), await imp.text()).toBe(true);
  const area = await (
    await request.post(`${API}/areas`, { headers: own, data: { name: 'Main Hall' } })
  ).json();
  for (const code of ['T3'])
    await request.post(`${API}/tables`, {
      headers: own,
      data: { code, seats: 4, area_id: area.id },
    });
  await request.post(`${API}/business-days/open`, { headers: auth, data: {} });
  await request.post(`${API}/shifts/open`, { headers: auth, data: { openingFloatPaisa: 500000 } });

  await login(page, 'cashier');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect(page.getByRole('button', { name: /T3/ })).toBeVisible();
  await page.waitForTimeout(4000); // the cache of the menu and the floor is written

  await context.setOffline(true);
  const t0 = Date.now();
  await page.getByRole('button', { name: /^T3 / }).click();
  await expect(page).toHaveURL(/\/order\//);
  expect(Date.now() - t0, 'opening a table offline is instant').toBeLessThan(2500);
  await expect(page.getByText('Token: when online')).toBeVisible();
  await page.waitForTimeout(8000); // longer than the reads' retries: the order must stay on screen after they give up
  await expect(page.getByText('Token: when online')).toBeVisible();
  const t1 = Date.now();
  await page.getByRole('button', { name: /^Plain Naan/ }).click();
  await expect(page.getByText(/Kept|Waiting/i).first()).toBeVisible();
  expect(Date.now() - t1, 'adding a dish offline is instant').toBeLessThan(2500);

  await context.setOffline(false);
  // the order and its dish are sent by themselves; the order now has a real token
  await expect(page.getByText('Token: when online')).toHaveCount(0, { timeout: 40_000 });
  const orders = await (await request.get(`${API}/orders?status=active`, { headers: auth })).json();
  expect(orders.items.some((o: { tableCode?: string }) => o.tableCode === 'T3')).toBe(true);
});
