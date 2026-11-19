import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

async function loginOwner(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill('owner');
  for (const digit of '1234') await page.getByRole('button', { name: digit, exact: true }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Tables' })).toBeVisible();
}

test('the owner adds a cook with a PIN, marks the day, and the cook clocks in on the clock screen', async ({
  page,
}) => {
  await loginOwner(page);

  // add the person
  await page.goto('/admin/employees');
  await expect(page.getByText('No staff yet. Add the first person.')).toBeVisible();
  await page.getByRole('button', { name: 'Add staff' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Bilal Cook');
  await dialog.getByLabel('Job title').fill('Cook');
  await dialog.getByLabel('Salary per month (Rs)').fill('35000');
  await dialog.getByLabel('Set a PIN').fill('2468');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('cell', { name: 'Bilal Cook' })).toBeVisible();
  await expect(page.getByText('Rs 35,000')).toBeVisible();

  // the day sheet: one tap marks him present
  await page.goto('/admin/attendance');
  await page.getByRole('button', { name: 'Bilal Cook: Present' }).click();
  await expect(page.getByRole('button', { name: 'Bilal Cook: Present' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // a correction to absent replaces the mark, it does not add a second one
  await page.getByRole('button', { name: 'Bilal Cook: Absent' }).click();
  await expect(page.getByRole('button', { name: 'Bilal Cook: Absent' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: 'Bilal Cook: Present' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );

  // the month shows the absence
  await page.getByRole('tab', { name: 'Month' }).click();
  await expect(page.getByRole('cell', { name: 'Bilal Cook' })).toBeVisible();

  // the clock screen: a wrong PIN is an error message, not a sign-out; the right PIN clocks in
  await page.goto('/admin/clock');
  await page.getByRole('button', { name: /Bilal Cook/ }).click();
  const pad = page.getByRole('dialog');
  for (const d of '1111') await pad.getByRole('button', { name: d, exact: true }).click();
  await pad.getByRole('button', { name: 'Clock in' }).click();
  await expect(pad.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Clock in / out' })).toBeVisible(); // still signed in
  for (const d of '2468') await pad.getByRole('button', { name: d, exact: true }).click();
  await pad.getByRole('button', { name: 'Clock in' }).click();
  await expect(page.getByRole('status')).toContainText('Bilal Cook clocked in');
});
