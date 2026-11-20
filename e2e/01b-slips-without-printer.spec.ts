import { expect, test, type Page } from '@playwright/test';

// Runs right after 01-pos (menu, day, shift) and before any receipt printer exists: the counter has no printer for
// the token, so the screen opens a modal with the slip and a Print button.
test.describe.configure({ mode: 'serial' });

async function login(page: Page, username: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill(username);
  for (const digit of '1234') await page.getByRole('button', { name: digit, exact: true }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Tables', exact: true })).toBeVisible();
}

test('a takeaway: add the customer, print the token with no printer connected, and a modal opens to print it', async ({
  page,
}) => {
  await login(page, 'cashier');
  await page.getByRole('button', { name: 'New delivery' }).click();
  await expect(page).toHaveURL(/\/order\//);
  await page.getByRole('button', { name: /^Chicken Tikka \(Leg\)/ }).click();

  // who the delivery is for: name, phone and the address the rider needs
  await page.getByRole('button', { name: 'Customer name / phone' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Ali Raza');
  await dialog.getByLabel('Phone', { exact: true }).fill('0300-1234567');
  await dialog.getByLabel('Delivery address').fill('House 12, Street 4, Gulberg');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: /Ali Raza/ })).toBeVisible();

  // no printer for the token: a modal with the slip and a Print button
  await page.getByRole('button', { name: 'Print token' }).click();
  const slip = page.getByRole('dialog', { name: 'Token slip' });
  await expect(slip).toBeVisible();
  await expect(slip).toContainText('TOKEN');
  await expect(slip).toContainText('DELIVERY');
  await expect(slip).toContainText('Name: Ali Raza');
  await expect(slip).toContainText('Phone: 0300-1234567');
  await expect(slip).not.toContainText('Gulberg'); // the address is for the bill, not the slip the customer keeps
  await expect(slip.getByRole('button', { name: 'Print' })).toBeVisible();
  await slip.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(slip).toHaveCount(0);
});
