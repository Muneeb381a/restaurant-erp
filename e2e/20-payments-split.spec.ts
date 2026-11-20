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

test('the owner adds JazzCash from the payments screen in one tap', async ({ page }) => {
  await login(page, 'owner');
  await page.goto('/admin/payments');
  const row = (name: string) => page.getByRole('row').filter({ hasText: name });

  // the usual ways are offered until they are added
  const add = page.getByRole('button', { name: 'JazzCash', exact: true });
  if (await add.count()) await add.click();
  await expect(row('JazzCash')).toBeVisible();
  await expect(row('JazzCash')).toContainText('Digital');
  await expect(page.getByRole('button', { name: 'JazzCash', exact: true })).toHaveCount(0); // no longer offered

  // it can be switched off and on again, never deleted
  await expect(row('JazzCash').getByRole('button', { name: /^Delete/ })).toHaveCount(0);
});

test('a cashier gives a rupee discount with a one-tap reason, then splits the bill between three', async ({
  page,
}) => {
  await login(page, 'cashier');
  await page.getByRole('button', { name: 'New takeaway' }).click();
  await page.getByRole('button', { name: /^Chicken Tikka \(Leg\)/ }).click();
  await expect(page.locator('aside')).toContainText('Rs 360');
  await page.getByRole('button', { name: 'Print KOT' }).click();
  await expect(page.locator('aside')).toContainText('In kitchen');
  await page.getByRole('button', { name: /^Bill/ }).click();
  await expect(page).toHaveURL(/\/pay$/);

  // Rs 10 off, reason chosen from the list
  await page.getByRole('button', { name: /discount/i }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Rupees' }).click();
  await dialog.getByLabel('Other amount in rupees').fill('10');
  await dialog.getByRole('button', { name: 'Regular customer' }).click();
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('Rs 350').first()).toBeVisible();

  // three people: 350 splits into 116.66, 116.66, 116.68 — the shares add up to the bill
  await page.getByRole('button', { name: 'Split between people' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'plus' }).click();
  await expect(page.getByTestId('split-n')).toHaveText('3');
  await page.getByRole('dialog').getByRole('button', { name: 'Make the payments' }).click();
  await expect(page.getByTestId(/^tender-CASH/)).toHaveCount(3);

  // one of the three pays by JazzCash instead, with its transaction number
  await page
    .getByTestId(/^tender-/)
    .last()
    .getByRole('combobox')
    .selectOption({ label: 'JazzCash' });
  await page.getByLabel(/^Reference/).fill('TXN-778812');

  await page.getByRole('button', { name: 'Take payment' }).click();
  await expect(page.getByTestId('change-due')).toBeVisible();
});
