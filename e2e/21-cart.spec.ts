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

test('the order works like a shopping cart: stepper on the dish, undo, note, groups', async ({
  page,
}) => {
  await login(page, 'cashier');
  await page.getByRole('button', { name: 'New takeaway' }).click();
  const cart = page.locator('aside');

  // tap a dish: it is in the cart, and the dish itself now shows − 1 +
  await page.getByRole('button', { name: /^Chicken Tikka \(Leg\)/ }).click();
  await expect(cart).toContainText('Rs 360');
  await page.getByRole('button', { name: /^Increase Chicken Tikka \(Leg\)/ }).click();
  await expect(cart).toContainText('Rs 720');
  await expect(cart).toContainText('2 × Rs 360');

  // a note on a dish that is not sent yet
  await cart.getByRole('button', { name: /^Note Chicken Tikka/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Less spicy' }).click();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(cart).toContainText('Less spicy');

  // taking the last one off removes the line, and Undo puts it back
  await cart.getByRole('button', { name: /^Void Chicken Tikka/ }).click();
  await expect(cart).toContainText('Rs 0'); // nothing left to send
  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();
  await expect(cart).toContainText('2 new item(s) not sent');
  await expect(cart).toContainText('Less spicy');

  // after sending, the cart splits into "To send" and "Already in kitchen"
  await page.getByRole('button', { name: 'Send to kitchen' }).click();
  await expect(cart).toContainText('In kitchen');
  await page.getByRole('button', { name: /^Chicken Tikka \(Leg\)/ }).click();
  await expect(cart).toContainText('To send');
  await expect(cart).toContainText('Already in kitchen');
});
