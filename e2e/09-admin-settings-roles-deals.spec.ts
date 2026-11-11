import { expect, test, type Page } from '@playwright/test';

const PIN = '1234';

test.describe.configure({ mode: 'serial' });

async function loginOwner(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill('owner');
  for (const digit of PIN) await page.getByRole('button', { name: digit, exact: true }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Tables' })).toBeVisible();
}

test('settings: restaurant details, service charge and receipt language are saved', async ({
  page,
}) => {
  await loginOwner(page);
  await page.getByRole('link', { name: 'Admin' }).click();
  await page.getByRole('link', { name: 'Business' }).click();
  await page.getByRole('link', { name: 'Settings' }).click();

  await page.getByLabel('Restaurant name (Urdu)').fill('لاہور کڑاہی ہاؤس');
  await page.getByRole('button', { name: 'Save restaurant details' }).click();
  await expect(page.getByText('Saved')).toBeVisible();

  await page.getByLabel('Service charge (%)').fill('5');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('Saved')).toBeVisible();

  const round = page.getByRole('switch', { name: 'Round bills to the nearest rupee' });
  const was = (await round.getAttribute('aria-checked')) === 'true'; // the dev seed has it on
  await round.click();
  await expect(round).toHaveAttribute('aria-checked', String(!was));

  await page.getByRole('button', { name: /اردو \(bitmap\)/ }).click();
  await page.reload();
  // everything survived a reload
  await expect(page.getByLabel('Restaurant name (Urdu)')).toHaveValue('لاہور کڑاہی ہاؤس');
  await expect(page.getByLabel('Service charge (%)')).toHaveValue('5');
  await expect(
    page.getByRole('switch', { name: 'Round bills to the nearest rupee' }),
  ).toHaveAttribute('aria-checked', String(!was));
  await expect(page.getByRole('button', { name: /اردو \(bitmap\)/ })).toHaveClass(/btn-primary/);

  // put the shop back the way it was
  await page.getByLabel('Service charge (%)').fill('0');
  await page.getByRole('button', { name: 'Apply' }).click();
  await page.getByRole('switch', { name: 'Round bills to the nearest rupee' }).click();
  await page.getByRole('button', { name: /English \(text\)/ }).click();
  await expect(page.getByRole('button', { name: /English \(text\)/ })).toHaveClass(/btn-primary/);
});

test('roles: change what a cashier may do, and it sticks', async ({ page }) => {
  await loginOwner(page);
  await page.getByRole('link', { name: 'Admin' }).click();
  await page.getByRole('link', { name: 'People & access' }).click();
  await page.getByRole('link', { name: 'Roles' }).click();

  await page.getByRole('button', { name: /^Cashier/ }).click();
  const reprint = page.getByRole('checkbox', { name: 'bill.reprint' });
  await expect(reprint).toBeChecked();
  await reprint.uncheck();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved')).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: /^Cashier/ }).click();
  await expect(page.getByRole('checkbox', { name: 'bill.reprint' })).not.toBeChecked();
  await page.getByRole('checkbox', { name: 'bill.reprint' }).check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved')).toBeVisible();

  // the owner role is fixed
  await page.getByRole('button', { name: /^Owner/ }).click();
  await expect(page.getByText('Fixed')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'bill.reprint' })).toBeDisabled();
});

test('deals: build a deal from slots and items, and it is still there when reopened', async ({
  page,
}) => {
  await loginOwner(page);
  await page.getByRole('link', { name: 'Admin' }).click();
  const row = (name: string) => page.getByRole('row').filter({ hasText: name });

  await page.getByRole('button', { name: /New item/ }).click();
  const dialog = page.getByRole('dialog', { name: 'New item' });
  await dialog.getByLabel('Name', { exact: true }).fill('E2E Family Deal');
  await dialog.getByLabel('Type').selectOption('DEAL');
  await dialog.getByLabel('Station').selectOption({ label: 'BBQ' });
  await dialog.getByLabel('price DINE_IN').fill('2000');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(row('E2E Family Deal')).toBeVisible();

  await row('E2E Family Deal').getByRole('button', { name: 'Edit contents' }).click();
  const editor = page.getByRole('dialog', { name: /Deal contents/ });
  await editor.getByLabel('Slot name').fill('Main');
  // cannot save a slot without an item
  await expect(editor.getByRole('button', { name: 'Save' })).toBeDisabled();
  await editor.getByRole('button', { name: /Add item/ }).click();
  await editor.getByLabel('Item', { exact: true }).selectOption({ label: 'Chicken Tikka (Leg)' });
  await editor.getByLabel('Upcharge (Rs)').fill('-50');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor).toHaveCount(0);

  await row('E2E Family Deal').getByRole('button', { name: 'Edit contents' }).click();
  const again = page.getByRole('dialog', { name: /Deal contents/ });
  await expect(again.getByLabel('Slot name')).toHaveValue('Main');
  await expect(again.getByLabel('Item', { exact: true })).toHaveValue(/.+/);
  await expect(again.getByLabel('Upcharge (Rs)')).toHaveValue('-50');
});
