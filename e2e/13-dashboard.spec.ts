import { expect, test, type Page } from '@playwright/test';

const PIN = '1234';

async function login(page: Page, user: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill(user);
  for (const digit of PIN) await page.getByRole('button', { name: digit, exact: true }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Tables', exact: true })).toBeVisible();
}

test('the owner sees the business overview with profit and loss; the cashier has no dashboard', async ({
  page,
  browser,
}) => {
  await login(page, 'owner');
  await page.getByRole('link', { name: 'Dashboard' }).click();
  await expect(page.getByRole('heading', { name: 'Business overview' })).toBeVisible();
  // headline numbers, profit and loss and the "where it went" breakdown are always there
  await expect(page.getByText('Net profit', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Profit and loss' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'How guests paid' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Watch for leaks' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Kitchen speed' })).toBeVisible();

  // switching the period reloads the figures
  await page.getByRole('button', { name: 'Last 30 days' }).click();
  await expect(page.getByRole('button', { name: 'Last 30 days' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('heading', { name: 'Sales and gross profit by day' })).toBeVisible();

  const cashier = await (await browser.newContext()).newPage();
  await login(cashier, 'cashier');
  await expect(cashier.getByRole('link', { name: 'Dashboard' })).toHaveCount(0);
  await cashier.goto('/dashboard');
  await expect(cashier.getByText('Something went wrong')).toBeVisible(); // the server refuses: no financial permission
  await cashier.context().close();
});
