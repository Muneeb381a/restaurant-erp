import { expect, test, type Page } from '@playwright/test';

// Runs after the earlier specs (menu, a business day and a cashier shift exist).
test.describe.configure({ mode: 'serial' });

async function login(page: Page, username: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill(username);
  for (const digit of '1234') await page.getByRole('button', { name: digit, exact: true }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Tables', exact: true })).toBeVisible();
}

test('the owner changes a dish price from its Edit dialog', async ({ page }) => {
  await login(page, 'owner');
  await page.goto('/admin/menu');
  await page.getByPlaceholder('Search').first().fill('Roghni Naan');
  const row = page.getByRole('row').filter({ hasText: 'Roghni Naan' }).first();
  await row.getByRole('button', { name: /^Edit/ }).first().click();

  const dialog = page.getByRole('dialog');
  const price = dialog.getByLabel('price DINE_IN');
  await expect(price).toBeVisible(); // the current price is there to change
  await price.fill('123');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);

  // the price cells of the table show the new amount
  await expect(
    page.getByRole('row').filter({ hasText: 'Roghni Naan' }).first().locator('input').first(),
  ).toHaveValue('123.00');
});
