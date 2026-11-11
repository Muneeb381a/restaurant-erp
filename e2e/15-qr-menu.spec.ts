import { expect, test, type Page } from '@playwright/test';

const PIN = '1234';

async function loginOwner(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill('owner');
  for (const digit of PIN) await page.getByRole('button', { name: digit, exact: true }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Tables' })).toBeVisible();
}

test('QR menu: the owner publishes it, a guest with no login reads it, and switching it off closes it', async ({
  page,
  browser,
}) => {
  await loginOwner(page);
  await page.getByRole('link', { name: 'Admin' }).click();
  await page.getByRole('link', { name: 'QR menu' }).click();

  // off by default: the guest link is shown but the switch is off
  const visible = page.getByRole('switch', { name: 'Customers can see the menu' });
  await expect(visible).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('img', { name: 'QR code for the menu' })).toBeVisible();
  const link = (await page
    .getByText(/\/m\?b=/)
    .first()
    .textContent())!.trim();

  await page.getByLabel('Note', { exact: true }).fill('Fresh naan after 7 pm');
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(page.getByText('Saved').first()).toBeVisible();

  // a guest (no login, own browser) sees "not available" while it is off
  const guest = await (await browser.newContext()).newPage();
  await guest.goto(link);
  await expect(guest.getByRole('heading', { name: 'Menu not available' })).toBeVisible();

  await visible.click();
  await expect(visible).toHaveAttribute('aria-checked', 'true');

  await guest.reload();
  await expect(guest.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(guest.getByText('Fresh naan after 7 pm')).toBeVisible();
  await expect(guest.getByText('Chicken Tikka (Leg)').first()).toBeVisible();
  await expect(guest.getByText('Rs 4').first()).toBeVisible(); // a priced dish
  // no staff screens, no ordering
  await expect(guest.getByRole('link', { name: 'Admin' })).toHaveCount(0);

  // search narrows the list; Urdu flips the page right-to-left
  await guest.getByLabel('Search the menu').fill('zzzz');
  await expect(guest.getByText('No dish matches your search.')).toBeVisible();
  await guest.getByLabel('Search the menu').fill('tikka');
  await expect(guest.getByText('Chicken Tikka (Leg)').first()).toBeVisible();
  await guest.getByRole('button', { name: 'اردو' }).click();
  await expect(guest.locator('html')).toHaveAttribute('dir', 'rtl');

  // switch it off again: the guest's page now says so
  await visible.click();
  await expect(visible).toHaveAttribute('aria-checked', 'false');
  await guest.getByRole('button', { name: 'اردو' }).click(); // keep the page language stable
  await guest.reload();
  await expect(guest.locator('main, h2').first()).toBeVisible();
  await guest.context().close();
});
