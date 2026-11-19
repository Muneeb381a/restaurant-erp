import { expect, request, test, type Page } from '@playwright/test';

const API = 'http://127.0.0.1:18081/api/v1';
const PIN = '1234';

test.describe.configure({ mode: 'serial' });

async function login(page: Page, username: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill(username);
  for (const digit of PIN) await page.getByRole('button', { name: digit, exact: true }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Tables', exact: true })).toBeVisible();
}

test.beforeAll(async () => {
  const api = await request.newContext();
  const t = await api.post(`${API}/auth/login`, {
    data: { username: 'owner', password: 'Dev#Passw0rd' },
  });
  const auth = { Authorization: `Bearer ${(await t.json()).accessToken}` };
  for (const code of ['M1', 'M2'])
    expect(
      (await api.post(`${API}/tables`, { headers: auth, data: { code, seats: 2 } })).ok(),
    ).toBe(true);
  await api.dispose();
});

test('the owner sets tax up from scratch: authority, confirmed rates, then ON', async ({
  page,
}) => {
  await login(page, 'owner');
  await page.getByRole('link', { name: 'Admin' }).click();
  await page.getByRole('link', { name: 'Business' }).click();
  await page.getByRole('link', { name: 'Tax', exact: true }).click();
  await expect(page.getByText('This software contains no tax rates')).toBeVisible();
  await expect(page.getByText('OFF', { exact: true })).toBeVisible();

  // not ready: no authority yet
  const enable = page.getByRole('switch', { name: 'Tax switched on' });
  await enable.click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'cannot be switched on yet' }),
  ).toBeVisible();
  await expect(enable).toHaveAttribute('aria-checked', 'false');

  await page.getByLabel('Tax authority').selectOption('PRA');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved')).toBeVisible();

  // the rates (placeholders from the dev seed) are shown but nobody has confirmed them
  await expect(page.getByTestId('rule-RESTAURANT_SERVICE-CASH_OTHER')).toContainText('16%');
  await expect(page.getByTestId('rule-RESTAURANT_SERVICE-DIGITAL')).toContainText('8%');
  await enable.click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'cannot be switched on yet' }),
  ).toBeVisible();

  for (const cls of ['CASH_OTHER', 'DIGITAL']) {
    page.once('dialog', (d) => void d.accept('A. Khan, CA'));
    await page
      .getByTestId(`rule-RESTAURANT_SERVICE-${cls}`)
      .getByRole('button', { name: 'Confirm' })
      .click();
    await expect(page.getByTestId(`rule-RESTAURANT_SERVICE-${cls}`)).toContainText('A. Khan, CA');
  }
  await expect(page.getByText('tax can be switched on')).toBeVisible();
  await enable.click();
  await expect(enable).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText('ON', { exact: true })).toBeVisible();
});

test('the bill total follows how it is paid: 16 % for cash, 8 % for card', async ({ page }) => {
  await login(page, 'cashier');
  const hasShift = await page
    .getByText('Shift open')
    .waitFor({ timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (!hasShift) {
    await page.getByRole('button', { name: /^Day / }).click();
    await page.getByRole('button', { name: 'Open shift' }).first().click();
    await page.getByRole('dialog').getByRole('textbox').fill('5000');
    await page.getByRole('button', { name: 'Open shift' }).last().click();
    await expect(page.getByText('Shift open')).toBeVisible();
  }
  const sell = async (table: string): Promise<void> => {
    await page.getByRole('link', { name: 'Restaurant POS' }).click();
    await page.getByRole('button', { name: new RegExp(table) }).click();
    await page.getByRole('button', { name: /^Chicken Tikka \(Leg\)/ }).click();
    await expect(page.locator('aside')).toContainText('Rs 400');
    await page.getByRole('button', { name: 'Send to kitchen' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Sent to the kitchen' }).first(),
    ).toContainText('Sent to the kitchen');
    await page.getByRole('button', { name: /^Bill/ }).click();
    await expect(page).toHaveURL(/\/pay$/);
  };

  // cash (the default view of the bill): 400 + 16 % = 464
  await sell('M1');
  await expect(page.getByTestId('bill-total')).toContainText('Rs 464');
  await page.getByRole('button', { name: 'Cash', exact: true }).click();
  await expect(page.getByTestId('bill-total')).toContainText('Rs 464');
  await expect(page.getByText(/Tax 16%/)).toBeVisible();
  await expect(page.getByTestId('remaining')).toContainText('Rs 0');
  await page.getByRole('button', { name: /^Take payment/ }).click();
  await expect(page.getByRole('heading', { name: 'Paid' })).toBeVisible();

  // card: the same bill is 400 + 8 % = 432 once the tender is all digital
  await sell('M2');
  await page.getByRole('button', { name: 'Debit/Credit Card', exact: true }).click();
  await expect(page.getByTestId('bill-total')).toContainText('Rs 432');
  await page.getByLabel(/Reference/).fill('RRN-TAX-1');
  await expect(page.getByTestId('remaining')).toContainText('Rs 0');
  await page.getByRole('button', { name: /^Take payment/ }).click();
  await expect(page.getByRole('heading', { name: 'Paid' })).toBeVisible();
  await page.getByRole('link', { name: 'Bills', exact: true }).click();
  await expect(page.getByRole('link', { name: /Rs 432/ }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: /Rs 464/ }).first()).toBeVisible();
});

test('the owner can switch tax off again; nothing else changes', async ({ page }) => {
  await login(page, 'owner');
  await page.getByRole('link', { name: 'Admin' }).click();
  await page.getByRole('link', { name: 'Business' }).click();
  await page.getByRole('link', { name: 'Tax', exact: true }).click();
  const enable = page.getByRole('switch', { name: 'Tax switched on' });
  await expect(enable).toHaveAttribute('aria-checked', 'true');
  await enable.click();
  await expect(enable).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByText('OFF', { exact: true })).toBeVisible();
});
