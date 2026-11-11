import { expect, test, type Page } from '@playwright/test';

const PIN = '1234';

async function loginOwner(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill('owner');
  for (const digit of PIN) await page.getByRole('button', { name: digit, exact: true }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Tables' })).toBeVisible();
}

test('setup checklist follows what the owner fills in, and the day summary opens in WhatsApp', async ({
  page,
}) => {
  await loginOwner(page);
  await page.getByRole('link', { name: 'Admin' }).click();
  await page.getByRole('link', { name: 'Business' }).click();

  // restaurant details: add address and phone, and the step turns Done
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByLabel('Address').fill('Main Boulevard, Lahore');
  await page.getByLabel('Phone', { exact: true }).fill('042 1234567');
  await page.getByRole('button', { name: 'Save restaurant details' }).click();
  await expect(page.getByText('Saved').first()).toBeVisible();

  // the owner's WhatsApp number
  await page.getByLabel("Owner's WhatsApp number").fill('0300 1234567');
  await page.getByRole('button', { name: 'Save number' }).click();
  await expect(page.getByLabel("Owner's WhatsApp number")).toHaveValue('0300 1234567');

  await page.getByRole('link', { name: 'Setup' }).click();
  await expect(page.getByRole('heading', { name: 'Setup' })).toBeVisible();
  await expect(page.getByTestId('setup-restaurant')).toContainText('Done');
  await expect(page.getByTestId('setup-menu')).toContainText('Done'); // earlier specs built a menu
  await expect(page.getByTestId('setup-qrMenu')).toContainText('Optional');

  // share today's summary: the link goes to the owner's chat with the message typed in
  await page.getByRole('link', { name: 'Dashboard' }).click();
  await page.getByRole('button', { name: 'Share summary' }).click();
  const send = page.getByRole('link', { name: /Send to the owner's WhatsApp/ });
  await expect(send).toBeVisible();
  const href = (await send.getAttribute('href'))!;
  expect(href.startsWith('https://wa.me/923001234567?text=')).toBe(true);
  expect(decodeURIComponent(href)).toContain('*Sales*');
});
