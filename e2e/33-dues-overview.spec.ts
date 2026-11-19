import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

async function loginOwner(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill('owner');
  for (const digit of '1234') await page.getByRole('button', { name: digit, exact: true }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Tables' })).toBeVisible();
}

test('a fine is recorded against a person, shown as owed, paused and written off with a reason; the overview shows the team', async ({
  page,
}) => {
  await loginOwner(page);

  await page.goto('/admin/employees');
  await page.getByRole('button', { name: 'Add staff' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Fine Tester');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('cell', { name: 'Fine Tester' })).toBeVisible();

  await page.goto('/admin/dues');
  await expect(page.getByText('Nothing owed.')).toBeVisible();
  await page.getByRole('button', { name: 'New advance, loan or fine' }).click();
  const form = page.getByRole('dialog');
  await form.getByRole('button', { name: 'Fine', exact: true }).click();
  const value = await form.locator('option:has-text("Fine Tester")').getAttribute('value');
  await form.getByRole('combobox').first().selectOption(value!);
  await form.getByLabel('Amount (Rs)').fill('500');
  await form.getByLabel('Reason', { exact: true }).fill('Broke a plate');
  await form.getByRole('button', { name: 'Save' }).click();

  const row = page.getByRole('row', { name: /Fine Tester/ });
  await expect(row).toContainText('Rs 500');
  await expect(row).toContainText('Broke a plate');

  await row.getByRole('button', { name: 'Pause' }).click();
  await expect(row).toContainText('Paused');
  await row.getByRole('button', { name: 'Resume' }).click();

  await row.getByRole('button', { name: 'Write off' }).click();
  const why = page.getByRole('dialog');
  await expect(why.getByRole('button', { name: 'Confirm' })).toBeDisabled();
  await why.getByLabel('Reason').fill('Forgiven');
  await why.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText('Nothing owed.')).toBeVisible();

  await page.goto('/admin/overview');
  await expect(page.getByText('Team (')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'What the staff cost' })).toBeVisible();
});
