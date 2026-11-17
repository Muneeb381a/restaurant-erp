import { expect, test, type Page } from '@playwright/test';

// Runs after the earlier specs (menu and a business day exist).
test.describe.configure({ mode: 'serial' });

async function login(page: Page, username: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill(username);
  for (const digit of '1234') await page.getByRole('button', { name: digit, exact: true }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Tables' })).toBeVisible();
}

test('a waiter finds a dish by any words, adds a note in one tap, and repeats it with one tap', async ({
  page,
}) => {
  await login(page, 'cashier');
  await page.getByRole('button', { name: 'New takeaway' }).click();
  await expect(page).toHaveURL(/\/order\//);
  const search = page.getByPlaceholder('Search');

  // words in any order, even one the dish name only has in a different position
  await search.fill('karahi chicken');
  await expect(page.getByRole('button', { name: /^Chicken Karahi/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Chicken Tikka/ })).toHaveCount(0);

  // typed with the Arabic look-alike letters (ك ي ه) a phone keyboard can produce
  await search.fill('كڑاهي');
  await expect(page.getByRole('button', { name: /Karahi/ }).first()).toBeVisible();
  await search.fill('');

  // the sheet: a size, a one-tap note, add
  await page.getByRole('button', { name: /^Chicken Karahi/ }).click();
  await page.getByRole('button', { name: /Full.*Rs 2,400/ }).click();
  await page.getByRole('button', { name: 'Less spicy' }).click();
  await page.getByRole('button', { name: 'Serve hot' }).click();
  await expect(page.getByLabel('Note', { exact: true })).toHaveValue('Less spicy, Serve hot');
  await page.getByRole('button', { name: 'Serve hot' }).click(); // tapping again takes it off
  await expect(page.getByLabel('Note', { exact: true })).toHaveValue('Less spicy');
  await page.getByRole('button', { name: /^Add/ }).click();
  await expect(page.locator('aside')).toContainText('Less spicy');

  // once it is in the kitchen, "One more" repeats it with the same size and note
  await page.getByRole('button', { name: 'Send to kitchen' }).click();
  await expect(page.locator('aside')).toContainText('In kitchen');
  await page
    .locator('aside')
    .getByRole('button', { name: /^One more/ })
    .click();
  await expect(page.locator('aside').getByText('Not sent', { exact: true })).toBeVisible();
  await expect(page.locator('aside')).toContainText('Rs 4,800'); // two Full karahi
  await expect(page.locator('aside').getByText('“Less spicy”')).toHaveCount(2);
});
