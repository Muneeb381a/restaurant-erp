import { expect, test, type Page } from '@playwright/test';

// Runs after the earlier specs (menu, a business day and a cashier shift exist).
test.describe.configure({ mode: 'serial' });

async function login(page: Page, username: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill(username);
  for (const digit of '1234') await page.getByRole('button', { name: digit, exact: true }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Tables' })).toBeVisible();
}

// a 2x2 red PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4EIwDiqEAAAJ+4EAf6L1kQAAAAASUVORK5CYII=',
  'base64',
);

test('a dish with a photo shows it on its menu card at the till', async ({ page }) => {
  await login(page, 'owner');
  const token = await page.evaluate(() => {
    const raw = localStorage.getItem('erp-auth');
    return raw ? (JSON.parse(raw).state.tokens.accessToken as string) : '';
  });
  const headers = { authorization: `Bearer ${token}` };
  const menu = await page.request.get('/api/v1/menu?priceList=TAKEAWAY', { headers });
  const naan = (await menu.json()).items.find((i: { name: string }) => i.name === 'Plain Naan');
  const up = await page.request.put(`/api/v1/items/${naan.id}/image`, {
    headers: { ...headers, 'content-type': 'image/png' },
    data: PNG,
  });
  expect(up.status()).toBe(200);

  await page.context().clearCookies();
  await page.evaluate(() => localStorage.clear());
  await login(page, 'cashier');
  await page.getByRole('button', { name: 'New takeaway' }).click();
  const tile = page.getByRole('button', { name: /^Plain Naan/ });
  await expect(tile.locator('img')).toBeVisible({ timeout: 15_000 });
  await expect(tile.locator('img')).toHaveAttribute('src', /^blob:/);
});
