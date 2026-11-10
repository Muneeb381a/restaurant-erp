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

test('the cashier sells two tikka for cash', async ({ page }) => {
  await login(page, 'cashier');
  await page.getByRole('button', { name: /T4/ }).click();
  await page.getByRole('button', { name: /Chicken Tikka \(Leg\)/ }).click();
  await page.locator('aside').getByRole('button', { name: 'plus' }).first().click();
  await expect(page.locator('aside')).toContainText('Rs 800');
  await page.getByRole('button', { name: 'Send to kitchen' }).click();
  await expect(page.locator('aside')).toContainText('Sent to the kitchen');
  await page.getByRole('button', { name: 'Bill', exact: true }).click();
  await page.getByRole('button', { name: '+ Cash', exact: true }).click();
  await page.getByRole('button', { name: 'Settle bill' }).click();
  await expect(page.getByText('✓ Paid')).toBeVisible();

  // a cashier may look the bill up but cannot refund it
  await page.getByRole('link', { name: 'Bills', exact: true }).click();
  await page
    .getByRole('link', { name: /Rs 800/ })
    .first()
    .click();
  await expect(page.getByText('✓ Paid')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refund', exact: true })).toHaveCount(0);
});

test('a manager returns one tikka, then the rest; the server computes every amount', async ({
  page,
}) => {
  await login(page, 'manager');
  await page.getByRole('button', { name: 'Open shift' }).click();
  await page.getByRole('textbox').fill('5000');
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText('Shift ✓')).toBeVisible();

  await page.getByRole('link', { name: 'Bills', exact: true }).click();
  await page
    .getByRole('link', { name: /Rs 800/ })
    .first()
    .click();
  await page.getByRole('button', { name: 'Refund', exact: true }).click();

  // nothing chosen yet: the confirm button is off
  await expect(page.getByRole('button', { name: 'Refund', exact: true }).last()).toBeDisabled();
  await page.getByLabel('Chicken Tikka (Leg) qty').fill('1');
  await page.getByRole('button', { name: 'Cash', exact: true }).click();
  await expect(page.getByTestId('refund-total')).toContainText('Rs 400');
  await page.getByLabel('Reason (required)').fill('Guest sent one back');
  await page.getByRole('button', { name: 'Refund', exact: true }).last().click();
  await expect(page.getByText('Refund recorded')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByTestId('credit-notes')).toContainText(/Credit note\W*#1/);
  await expect(page.getByTestId('credit-notes')).toContainText('Rs 400');

  // return everything that is left: one more tikka, the total is again computed by the server
  await page.getByRole('button', { name: 'Refund', exact: true }).click();
  await page.getByRole('button', { name: 'Return everything left' }).click();
  await page.getByRole('button', { name: 'Cash', exact: true }).click();
  await expect(page.getByTestId('refund-total')).toContainText('Rs 400');
  await page.getByLabel('Reason (required)').fill('Whole table left');
  await page.getByRole('button', { name: 'Refund', exact: true }).last().click();
  await expect(page.getByText('Refund recorded')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  await expect(page.getByTestId('credit-notes')).toContainText(/Credit note\W*#2/);
  // fully returned: nothing left to refund
  await expect(page.getByRole('button', { name: 'Refund', exact: true })).toHaveCount(0);
});

test('a refund cannot be paid out of a drawer without a shift', async ({ page }) => {
  await login(page, 'owner');
  await page.getByRole('button', { name: /T4/ }).click();
  await page.getByRole('button', { name: /Chicken Tikka \(Leg\)/ }).click();
  await page.getByRole('button', { name: 'Send to kitchen' }).click();
  await expect(page.locator('aside')).toContainText('Sent to the kitchen');
  await page.getByRole('button', { name: 'Bill', exact: true }).click();
  // the owner has no shift, so even taking payment is refused by the server
  await page.getByRole('button', { name: '+ Cash', exact: true }).click();
  await page.getByRole('button', { name: 'Settle bill' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Open your shift before taking payment' }),
  ).toBeVisible();
});
