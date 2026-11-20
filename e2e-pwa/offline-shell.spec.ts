import { expect, test, type Page } from '@playwright/test';

// Runs against the PRODUCTION build (the service worker only exists there). See playwright.pwa.config.ts.
async function login(page: Page, username: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill(username);
  for (const d of '1234') await page.getByRole('button', { name: d, exact: true }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Tables', exact: true })).toBeVisible();
}

test('with no internet the app still opens on a refresh, and so does a screen nobody visited yet', async ({
  page,
  context,
}) => {
  await login(page, 'owner');
  // the service worker stores the whole app when it installs
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const names = await caches.keys();
          if (!names.includes('erp-shell-v2') || !names.includes('erp-files-v2')) return 0;
          return (await (await caches.open('erp-files-v2')).keys()).length;
        }),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(20);

  await context.setOffline(true);

  // a plain refresh: the shell and its files come from the device
  await page.reload();
  await expect(page.getByRole('link', { name: 'Tables' }).first()).toBeVisible();
  await expect(page.getByText('Something went wrong')).toHaveCount(0);

  // a screen this device never opened: its code was stored at install, not fetched now
  await page.goto('/bills');
  await expect(page.getByRole('heading', { name: 'Bills', exact: true })).toBeVisible();
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
});
