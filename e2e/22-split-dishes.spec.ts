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

test('two friends pay for their own dishes: each person gets their dishes, shares add up to the bill', async ({
  page,
}) => {
  await login(page, 'cashier');
  await page.getByRole('button', { name: 'New takeaway' }).click();
  await page.getByRole('button', { name: /^Chicken Tikka \(Leg\)/ }).click();
  await expect(page.locator('aside')).toContainText('Rs 360');
  await page.getByRole('button', { name: /^Plain Naan/ }).click();
  await page.getByRole('button', { name: 'Print KOT' }).click();
  await expect(page.locator('aside')).toContainText('In kitchen');
  await page.getByRole('button', { name: /^Bill/ }).click();
  await expect(page).toHaveURL(/\/pay$/);

  await page.getByRole('button', { name: 'Split between people' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'By dishes' }).click();

  // everyone shares both dishes at first; the naan is the second person's
  await dialog.getByLabel(/^Who pays for Chicken Tikka/).selectOption('0');
  await dialog.getByLabel(/^Who pays for Plain Naan/).selectOption('1');
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Make the payments' }).click();
  await expect(page.getByTestId(/^tender-CASH/)).toHaveCount(2);

  // a person with nothing to pay for blocks the split
  await page.getByRole('button', { name: 'Split between people' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'By dishes' }).click();
  await page
    .getByRole('dialog')
    .getByLabel(/^Who pays for Chicken Tikka/)
    .selectOption('0');
  await page
    .getByRole('dialog')
    .getByLabel(/^Who pays for Plain Naan/)
    .selectOption('0');
  await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Make the payments' })).toBeDisabled();
});
