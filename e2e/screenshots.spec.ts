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
  await expect(page.getByRole('heading', { name: 'Tables' })).toBeVisible();
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
  await page.getByRole('button', { name: 'English' }).click();
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.getByRole('button', { name: /T1/ }).click();
  await expect(page.locator('aside')).toContainText('Rs');
  await page.screenshot({ path: `${OUT}/07-order-tablet-portrait.png` });
});
