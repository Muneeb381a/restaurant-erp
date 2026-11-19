import { expect, test, type Page } from '@playwright/test';

// Runs after the earlier specs (menu, a business day and a cashier shift exist).
test.describe.configure({ mode: 'serial' });

async function loginOwner(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill('owner');
  for (const digit of '1234') await page.getByRole('button', { name: digit, exact: true }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Tables', exact: true })).toBeVisible();
}

test('a category that still has a dish is deleted by moving the dish out; the dish is kept', async ({
  page,
}) => {
  await loginOwner(page);
  await page.goto('/admin/menu');

  await page.getByRole('button', { name: 'Categories', exact: true }).click();
  await page.getByRole('button', { name: 'New category' }).click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).last().fill('Zonk');
  await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('button', { name: 'Edit Zonk' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).last().click();

  await page.getByRole('button', { name: 'New item' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).first().fill('Zonk Dish');
  await dialog.getByLabel('Category').selectOption({ label: 'Zonk' });
  await dialog.getByLabel('Station').selectOption({ label: 'BBQ' });
  await dialog
    .getByRole('button', { name: /Create|Save/ })
    .last()
    .click();
  await expect(page.getByRole('row').filter({ hasText: 'Zonk Dish' })).toContainText('Zonk');

  // delete the category: it asks where the dish goes, and "No category" is the default
  await page.getByRole('button', { name: 'Categories', exact: true }).click();
  await page.getByRole('button', { name: 'Delete Zonk' }).click();
  const ask = page.getByRole('dialog').last();
  await expect(ask.getByText('Move the dishes to')).toBeVisible();
  await ask.getByRole('button', { name: 'Move and delete' }).click();
  await expect(page.getByRole('button', { name: 'Edit Zonk' })).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).last().click();

  // the dish is still on the menu, now without a category
  await expect(page.getByRole('row').filter({ hasText: 'Zonk Dish' })).toBeVisible();
  // its category cell is empty (a dash), not "Zonk"
  await expect(
    page.getByRole('row').filter({ hasText: 'Zonk Dish' }).locator('td').nth(1),
  ).not.toContainText('Zonk');
});

test('a supplier can be edited from the purchases screen', async ({ page }) => {
  await loginOwner(page);
  await page.goto('/admin/purchases');
  await page.getByRole('button', { name: '+', exact: true }).click(); // next to the supplier choice
  await page
    .getByRole('dialog', { name: 'New supplier' })
    .getByLabel('Name')
    .fill('Edit Me Traders');
  await page
    .getByRole('dialog', { name: 'New supplier' })
    .getByRole('button', { name: 'Add' })
    .click();
  await expect(page.getByTestId('supplier-Edit Me Traders')).toBeVisible();

  await page.getByRole('button', { name: 'Edit Edit Me Traders' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('Edited Traders');
  await dialog.getByLabel('Phone').fill('0300-999');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('supplier-Edited Traders')).toBeVisible();
  await expect(page.getByTestId('supplier-Edit Me Traders')).toHaveCount(0);
});
