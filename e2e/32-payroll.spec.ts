import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

async function loginOwner(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill('owner');
  for (const digit of '1234') await page.getByRole('button', { name: digit, exact: true }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Tables', exact: true })).toBeVisible();
}

test('payroll: calculate last month, see why it cannot be approved, add a bonus and open the payslip', async ({
  page,
}) => {
  await loginOwner(page);

  await page.goto('/admin/employees');
  await page.getByRole('button', { name: 'Add staff' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Payroll Tester');
  await dialog.getByLabel('Salary per month (Rs)').fill('30000');
  await dialog.getByLabel('Joined on').fill('2026-01-01');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('cell', { name: 'Payroll Tester' })).toBeVisible();

  await page.goto('/admin/payroll');
  await page.getByRole('button', { name: 'New pay run' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Calculate' }).click();
  await expect(page.getByText('Draft', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Some days are not marked')).toBeVisible();

  // the days nobody marked stop the approval, in plain words
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'cannot be approved' })).toContainText(
    'unmarked working day',
  );

  // a bonus line, written down by hand
  await page.getByRole('button', { name: 'Add a line' }).click();
  const form = page.getByRole('dialog');
  await form.getByLabel('What is it for').fill('Eid bonus');
  await form.getByLabel('Amount (Rs)').fill('2000');
  await form.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Payroll Tester' }).click();
  await expect(page.getByText('Eid bonus')).toBeVisible();

  await page.getByRole('button', { name: 'Payslip' }).click();
  const slip = page.getByRole('dialog');
  await expect(slip).toContainText('Eid bonus');
  await expect(slip).toContainText('Draft: the figures can still change.');
});
