import { deflateSync, crc32 } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';

// Runs after the earlier specs: an owner, a business day and the settings screen exist.
test.describe.configure({ mode: 'serial' });

/** A small valid PNG (a black ring on white), so the browser can decode it. */
function png(width: number, height: number): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3, 255);
    row[0] = 0; // no filter
    for (let x = 0; x < width; x++) {
      const dx = x - width / 2;
      const dy = (y - height / 2) * 2;
      const d = Math.sqrt(dx * dx + dy * dy);
      const black = d > width * 0.25 && d < width * 0.4;
      if (black) row.fill(0, 1 + x * 3, 1 + x * 3 + 3);
    }
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function loginOwner(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill('owner');
  for (const digit of '1234') await page.getByRole('button', { name: digit, exact: true }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Tables' })).toBeVisible();
}

test('the owner uploads the restaurant logo: it shows in the top bar and can be removed', async ({
  page,
}) => {
  await loginOwner(page);
  await page.goto('/admin/settings');
  await expect(page.getByText('No logo yet')).toBeVisible();

  await page.getByLabel('Upload logo').setInputFiles({
    name: 'logo.png',
    mimeType: 'image/png',
    buffer: png(240, 120),
  });
  // the preview shows what the printer will print, before anything is saved
  await expect(page.getByRole('img', { name: 'How it prints' })).toBeVisible();
  await page.getByRole('button', { name: 'Save logo' }).click();

  await expect(page.getByRole('img', { name: 'Your logo' })).toBeVisible();
  // the top bar now carries the logo instead of the app mark
  await expect(page.locator('header img').first()).toBeVisible();

  await page.getByRole('button', { name: 'Remove logo' }).click();
  await expect(page.getByText('No logo yet')).toBeVisible();
});

test('a person sets and removes their own photo from the account menu', async ({ page }) => {
  await loginOwner(page);
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: 'Change photo' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();

  await page.getByLabel('Choose or take a photo').setInputFiles({
    name: 'me.png',
    mimeType: 'image/png',
    buffer: png(200, 200),
  });
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // the badge in the top bar is now their picture, not initials
  await expect(page.getByRole('button', { name: 'Account' }).locator('img')).toBeVisible();

  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: 'Change photo' }).click();
  await page.getByRole('button', { name: 'Remove photo' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Account' }).locator('img')).toHaveCount(0);
});
