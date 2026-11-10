import { readFileSync } from 'node:fs';
import { expect, request, test, type Page } from '@playwright/test';

const API = 'http://127.0.0.1:18081/api/v1';
const PASSWORD = 'Dev#Passw0rd';
const PIN = '1234';

test.describe.configure({ mode: 'serial' });

async function login(page: Page, username: string): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/); // signed-out users are sent to the login screen
  await page.getByLabel('Username').fill(username);
  for (const digit of PIN) await page.getByRole('button', { name: digit, exact: true }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Tables' })).toBeVisible();
}

test.beforeAll(async () => {
  // Seed what the restaurant owner would set up: the menu (CSV import) and some tables.
  const api = await request.newContext();
  const t = await api.post(`${API}/auth/login`, {
    data: { username: 'owner', password: PASSWORD },
  });
  const auth = { Authorization: `Bearer ${(await t.json()).accessToken}` };

  const csv = readFileSync('docs/samples/desi-menu.csv');
  const imp = await api.post(`${API}/menu/import?dryRun=false`, {
    headers: { ...auth, 'content-type': 'text/csv; charset=utf-8' },
    data: csv,
  });
  expect(imp.ok(), await imp.text()).toBe(true);

  const area = await (
    await api.post(`${API}/areas`, { headers: auth, data: { name: 'Main Hall' } })
  ).json();
  for (const code of ['T1', 'T2', 'T3', 'T4']) {
    const r = await api.post(`${API}/tables`, {
      headers: auth,
      data: { code, seats: 4, area_id: area.id },
    });
    expect(r.ok()).toBe(true);
  }
  await api.dispose();
});

test('cashier opens the day and a shift, then takes an order at table T1', async ({ page }) => {
  await login(page, 'cashier');

  // nothing can be ordered until the business day is open
  await expect(page.getByText('Open the business day to take orders')).toBeVisible();
  await expect(page.getByRole('button', { name: /T1/ })).toBeDisabled();

  await page.getByRole('button', { name: 'Open day' }).click();
  await expect(page.getByText(/Business day: \d{4}-\d{2}-\d{2}/)).toBeVisible();
  await page.getByRole('button', { name: 'Open shift' }).click();
  await page.getByRole('textbox').fill('5000');
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText('Shift ✓')).toBeVisible();

  await page.getByRole('button', { name: /T1/ }).click();
  await expect(page).toHaveURL(/\/order\//);
  await expect(page.getByText('No items yet')).toBeVisible();

  // a single-variant item is added with one tap; the SERVER prices it
  await page.getByRole('button', { name: /Chicken Tikka \(Leg\)/ }).click();
  await expect(page.locator('aside')).toContainText('Rs 360');

  // Half/Full item opens the sheet
  await page.getByRole('button', { name: /^Chicken Karahi/ }).click();
  await page.getByRole('button', { name: /Full · Rs 2,400/ }).click();
  await page.getByRole('button', { name: /^Add/ }).click();
  await expect(page.locator('aside')).toContainText('Rs 2,760');

  // quantity stepper re-prices on the server
  await page.locator('aside').getByRole('button', { name: 'plus' }).first().click();
  await expect(page.locator('aside')).toContainText('Rs 3,120'); // 2 × tikka + karahi

  // a required modifier-free weighed item asks for a weight
  await page.getByRole('button', { name: /^Mutton Chops/ }).click();
  await expect(page.getByRole('button', { name: /^Add/ })).toBeDisabled();
  await page.getByRole('button', { name: '500', exact: true }).click();
  await page.getByRole('button', { name: /^Add/ }).click();
  await expect(page.locator('aside')).toContainText('Rs 5,520'); // + 500 g of Rs 4,800/kg

  // voiding a not-yet-sent line is free
  await page.locator('aside').getByRole('button', { name: 'Void' }).last().click();
  await expect(page.locator('aside')).toContainText('Rs 3,120');

  await page.getByRole('link', { name: /Back/ }).click();
  await expect(page.getByRole('button', { name: /T1/ })).toContainText('Occupied');
  await expect(page.getByRole('button', { name: /T1/ })).toContainText('Rs 3,120');
});

test('a captain on another tablet sees T1 occupied, and cannot take it', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, 'captain');

  // live (polled) floor: T1 was taken by the cashier
  await expect(page.getByRole('button', { name: /T1/ })).toContainText('Occupied');
  await expect(page.getByRole('button', { name: /T2/ })).toContainText('Free');

  // tapping the occupied table joins the existing order (no second order is created)
  await page.getByRole('button', { name: /T1/ }).click();
  await expect(page.locator('aside')).toContainText('Rs 3,120');

  // …and the captain can start their own order on a free table
  await page.getByRole('link', { name: /Back/ }).click();
  await page.getByRole('button', { name: /T2/ }).click();
  await page.getByRole('button', { name: /^Plain Naan/ }).click();
  await expect(page.locator('aside')).toContainText('Rs 50');
  await context.close();
});

test('Urdu mode is right-to-left and shows Urdu item names', async ({ page }) => {
  await login(page, 'cashier');
  await page.getByRole('button', { name: 'اردو' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ur');
  await expect(page.getByRole('heading', { name: 'ٹیبلز' })).toBeVisible();

  await page.getByRole('button', { name: /T2/ }).click();
  await expect(page.getByRole('button', { name: /نان/ }).first()).toBeVisible(); // Urdu item name from the menu
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
});

test('signing out returns to the login screen and protects the floor', async ({ page }) => {
  await login(page, 'cashier');
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
});
