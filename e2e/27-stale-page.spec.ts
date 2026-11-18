import { expect, test } from '@playwright/test';

// If the app is updated while a tab is open, the page file it asks for is gone. The screen must say so
// and offer a reload instead of leaving the browser blank.
test('a page file that cannot be loaded shows a message, not a blank screen', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Username').fill('owner');
  for (const digit of '1234') await page.getByRole('button', { name: digit, exact: true }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Tables' })).toBeVisible();

  await page.route(/SettingsAdmin/, (route) => route.abort());
  await page.goto('/admin/settings');
  await expect(page.getByRole('alert').filter({ hasText: 'could not open' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible();
  // the rest of the app is still there
  await expect(page.getByRole('link', { name: 'Tables' }).first()).toBeVisible();
});
