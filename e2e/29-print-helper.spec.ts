import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

// Runs after the earlier specs. The helper program itself is replaced here by direct calls to its API.
test.describe.configure({ mode: 'serial' });

async function loginOwner(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill('owner');
  for (const digit of '1234') await page.getByRole('button', { name: digit, exact: true }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Tables', exact: true })).toBeVisible();
}

test('the owner sets up the print helper with one button; it is found, shown as connected and prints a test page', async ({
  page,
}) => {
  await loginOwner(page);
  await page.goto('/admin/settings');

  // one button downloads the installer, which carries this restaurant's address and a key
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Set up printing on this computer' }).click();
  const file = await (await downloading).path();
  const bat = await readFile(file!, 'utf8');
  const config = /\{"url":"([^"]+)","key":"([^"]+)"\}/.exec(bat);
  expect(config, 'the installer holds the address and key').not.toBeNull();
  const [, url, key] = config!;
  expect(url).toMatch(/\/api\/v1$/);
  expect(bat).toContain('Startup'); // starts with Windows

  await expect(page.getByText('Waiting for the helper to connect')).toBeVisible();

  // the helper starts on the counter computer and says which printers it found
  const hello = await page.request.post(
    `${url!.replace(/^https?:\/\/[^/]+/, '')}/print-agent/hello`,
    {
      headers: { 'x-print-key': key! },
      data: { computer: 'E2E-COUNTER', printers: [{ name: 'POS-80', isDefault: true }] },
    },
  );
  expect(hello.status()).toBe(200);
  await expect(page.getByText('Connected: printing is on')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('E2E-COUNTER')).toBeVisible();
  await expect(page.getByLabel('Printer used')).toHaveValue('POS-80');

  // a test page is queued for it and the helper receives it
  await page.getByRole('button', { name: 'Print a test page' }).click();
  await expect(page.getByText('Test page sent to the printer')).toBeVisible();
  const claim = await page.request.post(
    `${url!.replace(/^https?:\/\/[^/]+/, '')}/print-agent/claim`,
    {
      headers: { 'x-print-key': key! },
      data: {},
    },
  );
  const jobs = (await claim.json()).jobs as { printer: string; payloadBase64: string }[];
  expect(jobs).toHaveLength(1);
  expect(jobs[0]!.printer).toBe('POS-80');
  expect(Buffer.from(jobs[0]!.payloadBase64, 'base64').length).toBeGreaterThan(10);

  // it can be removed again
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Set up printing on this computer' }),
  ).toBeVisible();
});
