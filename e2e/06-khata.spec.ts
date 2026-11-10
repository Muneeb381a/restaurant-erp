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

/** One Chicken Tikka (Rs 400) at T4, sent to the kitchen, then on to the payment screen. */
async function orderAndBill(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Restaurant POS' }).click();
  await page.getByRole('button', { name: /T4/ }).click();
  await page.getByRole('button', { name: /Chicken Tikka \(Leg\)/ }).click();
  await expect(page.locator('aside')).toContainText('Rs 400');
  await page.getByRole('button', { name: 'Send to kitchen' }).click();
  await expect(page.locator('aside')).toContainText('Sent to the kitchen');
  await page.getByRole('button', { name: 'Bill', exact: true }).click();
  await expect(page).toHaveURL(/\/pay$/);
}

async function chooseKhata(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: '+ Customer Khata (credit)' }).click();
  await page.getByLabel('Search name or phone').fill(name);
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await expect(page.getByTestId('khata-chosen')).toContainText(name);
}

test('a manager creates a khata account with a credit limit', async ({ page }) => {
  await login(page, 'manager');
  await page.getByRole('link', { name: 'Khata', exact: true }).click();
  await page.getByRole('button', { name: '+ New account' }).click();
  await page.getByLabel('Customer name').fill('Haji Rashid');
  await page.getByLabel('Phone').fill('0300-5550101');
  await page.getByLabel('Credit limit (Rs)').fill('1000');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('link', { name: /Haji Rashid/ })).toBeVisible();

  // a cashier can look and take payments, but cannot create accounts
  await page.getByRole('button', { name: 'Log out' }).click();
  await login(page, 'cashier');
  await page.getByRole('link', { name: 'Khata', exact: true }).click();
  await expect(page.getByRole('link', { name: /Haji Rashid/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '+ New account' })).toHaveCount(0);
});

test('credit sales run up the balance until the limit stops the next one', async ({ page }) => {
  await login(page, 'cashier');
  await page.getByRole('button', { name: 'Open shift' }).click();
  await page.getByRole('textbox').fill('5000');
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText('Shift ✓')).toBeVisible();

  for (let i = 0; i < 2; i++) {
    await orderAndBill(page);
    await chooseKhata(page, 'Haji Rashid');
    await expect(page.getByTestId('remaining')).toContainText('Rs 0');
    await page.getByRole('button', { name: 'Settle bill' }).click();
    await expect(page.getByText('✓ Paid')).toBeVisible();
  }

  // Rs 800 is on credit; a third Rs 400 sale would pass the Rs 1,000 limit
  await orderAndBill(page);
  await chooseKhata(page, 'Haji Rashid');
  await expect(page.getByTestId('khata-chosen')).toContainText('Rs 200'); // available credit
  await expect(page.getByText(/Over the credit limit\. Available:.*Rs 200/)).toBeVisible();
  await page.getByRole('button', { name: 'Settle bill' }).click();
  // the SERVER refused it (the earlier line was only a hint): the bill is still unpaid
  await expect(page.getByRole('alert').filter({ hasText: 'Over the credit limit' })).toBeVisible();
  await expect(page.getByText('✓ Paid')).toHaveCount(0);

  // split: Rs 200 on khata, the rest in cash, goes through
  await page.getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('button', { name: '+ Customer Khata (credit)' }).click();
  await page.getByLabel('Search name or phone').fill('Rashid');
  await page.getByRole('button', { name: /Haji Rashid/ }).click();
  await page.getByLabel('Customer Khata (credit) Amount').fill('200');
  await page.getByRole('button', { name: '+ Cash', exact: true }).click();
  await expect(page.getByTestId('remaining')).toContainText('Rs 0');
  await page.getByRole('button', { name: 'Settle bill' }).click();
  await expect(page.getByText('✓ Paid')).toBeVisible();
});

test('the customer pays part of the balance at the counter and the ledger shows everything', async ({
  page,
}) => {
  await login(page, 'cashier');
  await page.getByRole('link', { name: 'Khata', exact: true }).click();
  await page.getByRole('link', { name: /Haji Rashid/ }).click();
  await expect(page.getByTestId('khata-balance')).toContainText('Rs 1,000');

  await page.getByRole('button', { name: 'Receive payment' }).click();
  await page.getByRole('button', { name: 'Cash', exact: true }).click();
  await page.getByLabel('Amount (Rs)').fill('1500'); // more than owed
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('More than the customer owes')).toBeVisible();

  await page.getByLabel('Amount (Rs)').fill('300');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved')).toBeVisible();
  await expect(page.getByTestId('khata-balance')).toContainText('Rs 700');

  const ledger = page.getByRole('listitem').filter({ hasText: /Credit sale|Payment/ });
  await expect(ledger.filter({ hasText: 'Payment' })).toHaveCount(1);
  await expect(ledger.filter({ hasText: 'Credit sale' })).toHaveCount(3);

  // cashiers cannot adjust or change limits
  await expect(page.getByRole('button', { name: 'Adjust balance' })).toHaveCount(0);
});
