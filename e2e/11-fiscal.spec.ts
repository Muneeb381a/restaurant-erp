import { expect, test, type Page } from '@playwright/test';

const PIN = '1234';

test.describe.configure({ mode: 'serial' });

async function login(page: Page, username: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill(username);
  for (const digit of PIN) await page.getByRole('button', { name: digit, exact: true }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Tables' })).toBeVisible();
}

test('the owner turns on tax and the test reporting provider', async ({ page }) => {
  await login(page, 'owner');
  await page.getByRole('link', { name: 'Admin' }).click();
  await page.getByRole('link', { name: 'Tax', exact: true }).click();
  // wait until the form holds the saved branch data (it would overwrite what we type otherwise)
  await expect(page.getByLabel('Tax authority')).toHaveValue('PRA');
  await page.getByLabel('NTN').fill('1234567-8');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved')).toBeVisible();
  const enable = page.getByRole('switch', { name: 'Tax switched on' });
  await enable.click();
  await expect(enable).toHaveAttribute('aria-checked', 'true');

  await page.getByRole('link', { name: 'Fiscal' }).click();
  await expect(page.getByText(/Bills and credit notes are reported/)).toBeVisible();
  await page.getByRole('button', { name: /Test provider/ }).click();
  await expect(page.getByRole('button', { name: /Test provider/ })).toHaveClass(/btn-primary/);
});

test('a sale shows "pending" at once and the fiscal number a few seconds later', async ({
  page,
}) => {
  await login(page, 'cashier');
  const hasShift = await page
    .getByText('Shift ✓')
    .waitFor({ timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (!hasShift) {
    await page.getByRole('button', { name: 'Open shift' }).click();
    await page.getByRole('textbox').fill('5000');
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByText('Shift ✓')).toBeVisible();
  }
  await page.getByRole('button', { name: /M1/ }).click();
  await page.getByRole('button', { name: /Chicken Tikka \(Leg\)/ }).click();
  await page.getByRole('button', { name: 'Send to kitchen' }).click();
  await expect(page.locator('aside')).toContainText('Sent to the kitchen');
  await page.getByRole('button', { name: 'Bill', exact: true }).click();
  await page.getByRole('button', { name: '+ Cash', exact: true }).click();
  await page.getByRole('button', { name: 'Settle bill' }).click();
  await expect(page.getByText('✓ Paid')).toBeVisible();

  // the sale did not wait for the authority; the background worker reports it shortly after
  await expect(page.getByTestId('fiscal-no')).toContainText('MOCK-INV-', { timeout: 20_000 });
});

test('the owner sees the queue empty and the day balanced', async ({ page }) => {
  await login(page, 'owner');
  await page.getByRole('link', { name: 'Admin' }).click();
  await page.getByRole('link', { name: 'Fiscal' }).click();
  await expect(page.getByTestId('fiscal-summary')).toContainText('Reported');
  await expect(page.getByText('Nothing is waiting.')).toBeVisible();
  await expect(page.getByTestId('recon-status')).toContainText('Everything sold was reported.');

  // leave the shop as it was: provider off, tax off
  await page.getByRole('button', { name: 'Off', exact: true }).click();
  await page.getByRole('link', { name: 'Tax', exact: true }).click();
  const enable = page.getByRole('switch', { name: 'Tax switched on' });
  await enable.click();
  await expect(enable).toHaveAttribute('aria-checked', 'false');
});
