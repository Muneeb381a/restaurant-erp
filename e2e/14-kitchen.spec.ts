import { expect, test, type Page } from '@playwright/test';

const PIN = '1234';

test.describe.configure({ mode: 'serial' });

async function login(page: Page, username: string, landing: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill(username);
  for (const digit of PIN) await page.getByRole('button', { name: digit, exact: true }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: landing })).toBeVisible();
}

test('an order sent from the table shows on the kitchen screen, moves to ready, and the table lights up "Food ready"', async ({
  page,
  browser,
}) => {
  // the captain takes the order at table L2 and sends it
  await login(page, 'captain', 'Tables');
  await page.getByRole('button', { name: /L2/ }).click();
  await page.getByRole('button', { name: /^Plain Naan/ }).click();
  await page.getByRole('button', { name: 'Print KOT' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'KOT' }).first()).toBeVisible();
  await page.getByRole('link', { name: /Back/ }).click();

  // the cook has a kitchen-only login: it opens straight on the board
  const cook = await (await browser.newContext()).newPage();
  await login(cook, 'kitchen', 'Kitchen');
  const ticket = cook.getByRole('article').filter({ hasText: 'Plain Naan' }).first();
  // the table code is the big thing on the ticket, with a small "Table" label
  await expect(ticket).toContainText('L2');
  await expect(ticket).toContainText('Table');
  await ticket.getByRole('button', { name: 'Start cooking' }).click();
  await expect(cook.getByRole('region', { name: 'Cooking' }).getByRole('article')).toContainText(
    'Plain Naan',
  );
  await cook
    .getByRole('region', { name: 'Cooking' })
    .getByRole('button', { name: 'Ready' })
    .click();
  await expect(cook.getByRole('region', { name: 'Ready' }).getByRole('article')).toContainText(
    'Plain Naan',
  );
  // a cook does not serve food to the table
  await expect(
    cook.getByRole('region', { name: 'Ready' }).getByRole('button', { name: 'Served' }),
  ).toBeVisible();

  // the captain's floor shows food ready on the table without a refresh
  await expect(page.getByRole('button', { name: /L2/ })).toContainText('Food ready');

  // the waiter carries it over and marks it served
  await page.getByRole('link', { name: 'Kitchen' }).click();
  await page.getByRole('region', { name: 'Ready' }).getByRole('button', { name: 'Served' }).click();
  await page.getByRole('link', { name: 'Tables' }).click();
  await expect(page.getByRole('button', { name: /L2/ })).not.toContainText('Food ready');
  await cook.context().close();
});
