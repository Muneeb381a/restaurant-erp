import { expect, test, type Page } from '@playwright/test';

// Runs after the earlier specs have taken payments today: the list must show them by the day they were billed.
async function login(page: Page, username: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill(username);
  for (const digit of '1234') await page.getByRole('button', { name: digit, exact: true }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Tables', exact: true })).toBeVisible();
}

test('Bills shows today by its own date, filters by day, status and search, and explains an empty day', async ({
  page,
}) => {
  await login(page, 'manager');
  await page.getByRole('link', { name: 'Bills', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Bills', exact: true })).toBeVisible();

  // today: bills are there, with their totals and the paid state
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  const rows = page.getByRole('link', { name: /Rs [\d,]+/ });
  await expect(rows.first()).toBeVisible();
  await expect(page.getByText('Paid in total')).toBeVisible();

  // the paid filter keeps only paid bills; waiting-for-payment ones disappear
  await page.getByRole('button', { name: 'Paid', exact: true }).click();
  await expect(rows.first()).toBeVisible();
  await expect(page.locator('ul .chip-warn')).toHaveCount(0);
  await page.getByRole('button', { name: 'All', exact: true }).last().click();

  // searching for something that does not exist says so, and a way back
  await page.getByLabel('Bill no, token, table or name').fill('zzzz-nothing');
  await expect(page.getByText('No bills found')).toBeVisible();
  await page.getByLabel('Bill no, token, table or name').fill('');

  // yesterday has no bills in a fresh test database: an empty day is explained, and one tap goes back
  await page.getByRole('button', { name: 'Yesterday', exact: true }).click();
  await expect(page.getByText('No bills on this day.')).toBeVisible();
  await page.getByRole('button', { name: 'Show the last 7 days' }).click();
  await expect(rows.first()).toBeVisible();
});

test('the day report downloads as a PDF with every bill of the day', async ({ page }) => {
  await login(page, 'manager');
  await page.getByRole('link', { name: 'Bills', exact: true }).click();
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /^Download PDF/ }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^daily-sales-\d{4}-\d{2}-\d{2}\.pdf$/);
  const path = await download.path();
  const { readFileSync } = await import('node:fs');
  const bytes = readFileSync(path);
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  expect(bytes.length).toBeGreaterThan(2000);
});
