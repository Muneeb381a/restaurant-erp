import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// Documentation screenshots (docs/screenshots). Not part of the normal run:
//   SCREENSHOTS=1 pnpm test:e2e         (runs after pos.spec.ts, which leaves a day, a shift and T1 open)
test.skip(!process.env.SCREENSHOTS, 'set SCREENSHOTS=1 to capture docs/screenshots');

const OUT = 'docs/screenshots';

async function login(page: Page, username: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill(username);
  for (const digit of '1234') await page.getByRole('button', { name: digit, exact: true }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Tables', exact: true })).toBeVisible();
}

test('capture the main screens', async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await page.goto('/login');
  await page.getByLabel('Username').fill('cashier');
  await page.getByRole('button', { name: '1', exact: true }).click();
  await page.getByRole('button', { name: '2', exact: true }).click();
  await page.screenshot({ path: `${OUT}/01-login.png` });

  await login(page, 'cashier');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/02-floor.png` });

  await page.getByRole('button', { name: /T1/ }).click();
  await expect(page.locator('aside')).toContainText('Rs');
  await page.screenshot({ path: `${OUT}/03-order.png` });

  await page.getByRole('button', { name: /^Chicken White Karahi/ }).click();
  await page.screenshot({ path: `${OUT}/04-item-sheet.png` });
  await page.getByRole('button', { name: 'Close' }).click();

  await page.getByRole('button', { name: 'اردو' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/05-order-urdu.png` });
  await page.getByRole('link', { name: /واپس/ }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/06-floor-urdu.png` });

  // tablet portrait
  await page.getByRole('button', { name: 'اکاؤنٹ', exact: true }).click();
  await page.getByRole('menuitem', { name: 'English' }).click();
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.getByRole('button', { name: /T1/ }).click();
  await expect(page.locator('aside')).toContainText('Rs');
  await page.screenshot({ path: `${OUT}/07-order-tablet-portrait.png` });
});

test('capture the admin screens', async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await login(page, 'owner');
  await page.goto('/admin/menu');
  await expect(page.getByRole('row').filter({ hasText: 'Chicken Tikka (Leg)' })).toBeVisible();
  await page.screenshot({ path: `${OUT}/08-admin-menu.png` });

  await page.getByRole('button', { name: /New item/ }).click();
  await page.getByLabel('Name', { exact: true }).fill('Chicken Seekh');
  await page.getByLabel('price DINE_IN').fill('300');
  await page.screenshot({ path: `${OUT}/09-admin-new-item.png` });
  await page.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('button', { name: 'Import CSV' }).click();
  await page.getByLabel('Choose a CSV file').setInputFiles({
    name: 'menu.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'item_code,item_name,price_dine_in\nOK1,Fine item,100\nBAD1,Bad price,12.345\n,No code,5\n',
    ),
  });
  await page.getByRole('button', { name: 'Check file' }).click();
  await expect(page.getByText('Problems found')).toBeVisible();
  await page.screenshot({ path: `${OUT}/10-admin-import.png` });
  await page.getByRole('button', { name: 'Cancel' }).click();

  await page.goto('/admin/printers');
  await expect(page.getByRole('heading', { name: 'Printers' })).toBeVisible();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/11-admin-printers.png` });

  await page.goto('/admin/users');
  await expect(page.getByRole('row').filter({ hasText: 'cashier' }).first()).toBeVisible();
  await page.screenshot({ path: `${OUT}/12-admin-users.png` });

  await page.goto('/admin/menu');
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('menuitem', { name: 'اردو' }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/13-admin-menu-urdu.png` });
});
