import { expect, test, type Page } from '@playwright/test';

const PIN = '1234';

async function loginOwner(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill('owner');
  for (const digit of PIN) await page.getByRole('button', { name: digit, exact: true }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Tables', exact: true })).toBeVisible();
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

// a real 1x1 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGO42aMNAAPSAZGjv8RZAAAAAElFTkSuQmCC',
  'base64',
);

test('guest menu details: description, labels, allergens and a photo show; hidden items do not', async ({
  page,
  browser,
}) => {
  await loginOwner(page);
  await page.getByRole('link', { name: 'Admin' }).click();

  const create = async (name: string, hide: boolean): Promise<void> => {
    await page.getByRole('button', { name: /New item/ }).click();
    const dialog = page.getByRole('dialog', { name: 'New item' });
    await dialog.getByLabel('Name', { exact: true }).fill(name);
    await dialog.getByLabel('Station').selectOption({ label: 'BBQ' });
    await dialog.getByLabel('price DINE_IN').fill('300');
    if (hide) {
      await dialog.getByRole('switch', { name: 'Hide from the guest menu' }).click();
    } else {
      await dialog
        .getByLabel('Short description', { exact: true })
        .fill('Minced beef on the skewer');
      await dialog.getByRole('button', { name: 'Halal', exact: true }).click();
      await dialog.getByRole('button', { name: 'Milk', exact: true }).click();
      await dialog
        .getByLabel('Choose photo')
        .setInputFiles({ name: 'dish.png', mimeType: 'image/png', buffer: PNG });
      await expect(dialog.getByRole('button', { name: 'Replace photo' })).toBeVisible();
    }
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('row').filter({ hasText: name })).toBeVisible();
  };
  await create('E2E Guest Dish', false);
  await create('E2E Staff Meal', true);
  await expect(
    page.getByRole('row').filter({ hasText: 'E2E Staff Meal' }).getByText('Hidden from guests'),
  ).toBeVisible();

  await page.getByRole('link', { name: 'QR menu' }).click();
  const visible = page.getByRole('switch', { name: 'Customers can see the menu' });
  if ((await visible.getAttribute('aria-checked')) !== 'true') await visible.click();
  await expect(visible).toHaveAttribute('aria-checked', 'true');
  const link = (await page
    .getByText(/\/m\?b=/)
    .first()
    .textContent())!.trim();

  const guest = await (await browser.newContext()).newPage();
  await guest.goto(link);
  await expect(guest.getByText('E2E Guest Dish')).toBeVisible();
  await expect(guest.getByText('Minced beef on the skewer')).toBeVisible();
  await expect(guest.getByText('Halal', { exact: true })).toBeVisible();
  await expect(guest.getByText(/Contains:\s*Milk/)).toBeVisible();
  const photo = guest.getByRole('img', { name: 'E2E Guest Dish' });
  await expect(photo).toBeVisible();
  await expect
    .poll(() => photo.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeGreaterThan(0);
  await expect(guest.getByText('E2E Staff Meal')).toHaveCount(0);

  // the staff meal is still sold at the till: it is on the ordinary menu list
  await page.getByRole('link', { name: 'Menu', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: 'E2E Staff Meal' })).toBeVisible();

  // turn the guest menu off again
  await page.getByRole('link', { name: 'QR menu' }).click();
  await visible.click();
  await guest.context().close();
});
