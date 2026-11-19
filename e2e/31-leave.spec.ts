import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

async function loginOwner(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill('owner');
  for (const digit of '1234') await page.getByRole('button', { name: digit, exact: true }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Tables', exact: true })).toBeVisible();
}

test('leave: set an allowance, enter a leave that is approved at once, see the balance, then cancel it with a reason', async ({
  page,
}) => {
  await loginOwner(page);
  // a person to take leave (the staff spec may already have added one: use a fresh name)
  await page.goto('/admin/employees');
  await page.getByRole('button', { name: 'Add staff' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Leave Tester');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('cell', { name: 'Leave Tester' })).toBeVisible();

  // an allowance is typed by the owner (none is built in)
  await page.goto('/admin/leave');
  await page.getByRole('tab', { name: 'Kinds of leave' }).click();
  await expect(page.getByText(/None is built in/)).toBeVisible();
  const casual = page.getByRole('row', { name: /Casual leave/ });
  await casual.getByLabel('Days per year').fill('10');
  await casual.getByLabel('Days per year').blur();
  await expect(casual.getByLabel('Days per year')).toHaveValue('10');

  // a new leave, approved at once
  await page.getByRole('tab', { name: 'Requests' }).click();
  await page.getByRole('button', { name: 'New leave' }).click();
  const form = page.getByRole('dialog');
  const value = await form.locator('option:has-text("Leave Tester")').getAttribute('value');
  await form.getByRole('combobox').nth(0).selectOption(value!);
  await form.getByRole('combobox').nth(1).selectOption({ label: 'Casual leave' });
  await form.getByLabel('From').fill('2031-03-03');
  await form.getByLabel('To').fill('2031-03-04');
  await form.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'All', exact: true }).click();
  const row = page.getByRole('row', { name: /Leave Tester/ });
  await expect(row).toContainText('Approved');

  // the balance shows it
  await page.getByRole('tab', { name: 'Balances' }).click();
  for (let i = 0; i < 5; i++) {
    if ((await page.locator('span[dir="ltr"]').first().textContent())?.trim() === '2031') break;
    await page.getByRole('button', { name: 'Next year' }).click();
  }
  await expect(page.getByRole('row', { name: /Leave Tester/ })).toContainText('2 of 10 used');

  // cancelling needs a reason
  await page.getByRole('tab', { name: 'Requests' }).click();
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel leave' }).click();
  const why = page.getByRole('dialog');
  await expect(why.getByRole('button', { name: 'Confirm' })).toBeDisabled();
  await why.getByLabel('Reason').fill('plans changed');
  await why.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('row', { name: /Leave Tester/ })).toContainText('Cancelled');
});
