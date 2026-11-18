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

test('no internet: dishes are kept on the device, the kitchen is not told, and everything is sent once it is back', async ({
  page,
  context,
}) => {
  await login(page, 'cashier');
  await page.getByRole('button', { name: 'New takeaway' }).click();
  const cart = page.locator('aside');
  await page.getByRole('button', { name: /^Chicken Tikka \(Leg\)/ }).click();
  await expect(cart).toContainText('Rs 360');

  // the internet goes away
  await context.setOffline(true);
  await expect(page.getByRole('status').filter({ hasText: 'No internet' })).toBeVisible();

  // adding a dish is kept, clearly not saved and not in the kitchen
  await page.getByRole('button', { name: /^Plain Naan/ }).click();
  await expect(cart).toContainText('Waiting for internet');
  await expect(cart).toContainText('Plain Naan');
  await expect(cart).toContainText('Not saved yet');
  // the bill cannot be asked for while something is not saved
  await expect(cart.getByRole('button', { name: /^Bill/ })).toHaveCount(0);

  // "send to kitchen" is kept too, with a warning that the kitchen has not heard
  await cart.getByRole('button', { name: 'Send to kitchen' }).click();
  await expect(cart).toContainText('Not sent to the kitchen yet');
  await expect(page.getByRole('status').filter({ hasText: 'NOT received' })).toBeVisible();

  // the connection is back: everything is saved in order, and nothing is added twice
  await context.setOffline(false);
  await expect(cart).not.toContainText('Waiting for internet', { timeout: 30_000 });
  await expect(cart).toContainText('In kitchen');
  await expect(cart).toContainText('Plain Naan');
  await expect(cart.getByText(/^⁦?1×/).filter({ hasText: 'Plain Naan' })).toHaveCount(0);
  await expect(cart.locator('li').filter({ hasText: 'Plain Naan' })).toHaveCount(1);
});
