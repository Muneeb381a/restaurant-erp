import { expect, request, test, type Page } from '@playwright/test';

const API = 'http://127.0.0.1:18081/api/v1';

const PIN = '1234';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  // this spec uses its own tables so it never depends on what earlier specs left open
  const api = await request.newContext();
  const t = await api.post(`${API}/auth/login`, {
    data: { username: 'owner', password: 'Dev#Passw0rd' },
  });
  const auth = { Authorization: `Bearer ${(await t.json()).accessToken}` };
  for (const code of ['L1', 'L2', 'L3'])
    expect(
      (await api.post(`${API}/tables`, { headers: auth, data: { code, seats: 2 } })).ok(),
    ).toBe(true);
  await api.dispose();
});

async function login(page: Page, username: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill(username);
  for (const digit of PIN) await page.getByRole('button', { name: digit, exact: true }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Tables' })).toBeVisible();
}

test('another tablet sees a new order at once, without polling every 3 seconds', async ({
  browser,
}) => {
  const captainCtx = await browser.newContext();
  const captain = await captainCtx.newPage();
  const floorRequests: number[] = [];
  captain.on('request', (r) => {
    if (r.url().includes('/api/v1/floor')) floorRequests.push(Date.now());
  });
  await login(captain, 'captain');
  await expect(captain.getByRole('button', { name: /L1/ })).toContainText('Free');

  // idle: the live stream is connected, so the floor is not re-fetched every 3 s
  await captain.waitForTimeout(1500);
  const idleStart = floorRequests.length;
  await captain.waitForTimeout(7000);
  expect(floorRequests.length - idleStart).toBeLessThanOrEqual(1);

  // the cashier takes L1 on another device: the captain's floor flips within a moment
  const cashierCtx = await browser.newContext();
  const cashier = await cashierCtx.newPage();
  await login(cashier, 'cashier');
  await cashier.getByRole('button', { name: /L1/ }).click();
  await cashier.getByRole('button', { name: /^Plain Naan/ }).click();
  await expect(cashier.locator('aside')).toContainText('Rs 50');
  await expect(captain.getByRole('button', { name: /L1/ })).toContainText('Occupied', {
    timeout: 2000,
  });
  await captainCtx.close();
  await cashierCtx.close();
});

test('a manager moves an order to another table, merges two orders, and cancels one', async ({
  page,
}) => {
  await login(page, 'manager');
  await expect(page.getByRole('button', { name: /L1/ })).toContainText('Occupied'); // naan from above
  await expect(page.getByRole('button', { name: /L2/ })).toContainText('Free');

  // ── move L1 → L2
  await page.getByRole('button', { name: /L1/ }).click();
  await page.getByRole('button', { name: 'Move to another table' }).click();
  await page.getByRole('button', { name: /L2/ }).click();
  await expect(page.locator('aside')).toContainText('L2');
  await page.getByRole('link', { name: /Back/ }).click();
  await expect(page.getByRole('button', { name: /L2/ })).toContainText('Occupied');
  await expect(page.getByRole('button', { name: /L1/ })).toContainText('Free');

  // ── a second order at L1, merged into the one at L2
  await page.getByRole('button', { name: /L1/ }).click();
  await page.getByRole('button', { name: /^Chicken Tikka \(Leg\)/ }).click();
  await expect(page.locator('aside')).toContainText('Rs 400');
  await page.getByRole('link', { name: /Back/ }).click();
  await page.getByRole('button', { name: /L2/ }).click();
  await page.getByRole('button', { name: 'Merge another table into this order' }).click();
  await page.getByRole('button', { name: /L1/ }).click();
  await expect(page.locator('aside')).toContainText('Rs 450'); // naan 50 + tikka 400
  await page.getByRole('link', { name: /Back/ }).click();
  await expect(page.getByRole('button', { name: /L1/ })).toContainText('Free');

  // ── cancel the merged order (nothing was sent to the kitchen, so it is allowed)
  await page.getByRole('button', { name: /L2/ }).click();
  await page.getByRole('button', { name: 'Cancel order' }).click();
  await page.getByLabel('Reason').fill('Guests left');
  await page.getByRole('button', { name: 'Cancel order' }).last().click();
  await expect(page.getByRole('heading', { name: 'Tables' })).toBeVisible();
  await expect(page.getByRole('button', { name: /L2/ })).toContainText('Free');
});

test('a captain can move tables but has no cancel button', async ({ page }) => {
  await login(page, 'captain');
  await page.getByRole('button', { name: /L3/ }).click();
  await page.getByRole('button', { name: /^Plain Naan/ }).click();
  await expect(page.getByRole('button', { name: 'Move to another table' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel order' })).toHaveCount(0);
});
