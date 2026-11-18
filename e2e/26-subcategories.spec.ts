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

test('the owner makes BBQ sub-categories Regular and Special and files a dish under one', async ({
  page,
}) => {
  await login(page, 'owner');
  await page.goto('/admin/menu');
  await page.getByRole('button', { name: 'Categories', exact: true }).click();
  const setup = page.getByRole('dialog');

  for (const name of ['Regular', 'Special']) {
    await setup.getByRole('button', { name: 'Add sub-category to BBQ' }).click();
    await setup.getByLabel('Name', { exact: true }).fill(name);
    // it starts inside BBQ
    await expect(setup.getByLabel('Inside')).toHaveValue(/.+/);
    await setup.getByRole('button', { name: 'Create' }).click();
    await expect(setup.getByRole('button', { name: `Edit ${name}` })).toBeVisible();
  }
  await setup.getByRole('button', { name: 'Close' }).last().click();

  // file Chicken Tikka (Leg) under BBQ › Regular
  const row = page.getByRole('row').filter({ hasText: 'Chicken Tikka (Leg)' }).first();
  await row.getByRole('button', { name: /^Edit/ }).first().click();
  const dialog = page.getByRole('dialog');
  const value = await dialog
    .getByLabel('Category')
    .locator('option', { hasText: 'Regular' })
    .getAttribute('value');
  await dialog.getByLabel('Category').selectOption(value!);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('row').filter({ hasText: 'Chicken Tikka (Leg)' }).first(),
  ).toContainText('BBQ › Regular');

  // the menu screen shows the sub-categories as a second row of chips, with counts
  await page.getByRole('button', { name: /^BBQ/ }).first().click();
  const subs = page.getByRole('group', { name: 'Sub-category' });
  await expect(subs.getByRole('button', { name: /^Regular/ })).toContainText('1');
  await subs.getByRole('button', { name: /^Special/ }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Chicken Tikka (Leg)' })).toHaveCount(0);
});

test('at the till BBQ opens a second row of tabs: Regular and Special', async ({ page }) => {
  await login(page, 'cashier');
  await page.getByRole('button', { name: 'New takeaway' }).click();
  const dish = page.getByRole('button', { name: /^Chicken Tikka \(Leg\)/ });
  await page.getByRole('tab', { name: /BBQ/ }).click();
  const subs = page.getByRole('tablist', { name: 'Sub-category' });
  await expect(subs).toBeVisible();
  await subs.getByRole('tab', { name: 'Special' }).click();
  await expect(dish).toHaveCount(0);
  await subs.getByRole('tab', { name: 'Regular' }).click();
  await expect(dish).toBeVisible();
  // BBQ as a whole still shows everything below it
  await subs.getByRole('tab', { name: 'All' }).click();
  await expect(dish).toBeVisible();
});
