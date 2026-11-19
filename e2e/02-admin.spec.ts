import { createServer, type Server } from 'node:net';
import { expect, test, type Page } from '@playwright/test';

// Runs after 01-pos.spec.ts, which seeded the menu, tables and a business day.
test.describe.configure({ mode: 'serial' });

const tickets: string[] = [];
let printer: Server;

async function login(page: Page, username: string, pin = '1234'): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Username').fill(username);
  for (const digit of pin) await page.getByRole('button', { name: digit, exact: true }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Tables', exact: true })).toBeVisible();
}

test.beforeAll(async () => {
  printer = createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on('data', (c) => chunks.push(c));
    socket.on('close', () => tickets.push(Buffer.concat(chunks).toString('latin1')));
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => printer.listen(0, '127.0.0.1', resolve));
});
test.afterAll(async () => {
  await new Promise((resolve) => printer.close(resolve));
});

test('the owner edits prices and creates an item in the menu admin', async ({ page }) => {
  await login(page, 'owner');
  await page.getByRole('link', { name: 'Admin' }).click();
  await expect(page).toHaveURL(/\/admin\/menu$/);
  const row = (name: string) => page.getByRole('row').filter({ hasText: name });

  // inline price edit → saved on Enter, still there after a reload
  await expect(row('Chicken Tikka (Leg)')).toBeVisible();
  const dine = row('Chicken Tikka (Leg)').getByLabel(/^DINE_IN/);
  await expect(dine).toHaveValue('360.00');
  await dine.fill('400');
  await dine.press('Enter');
  await page.waitForTimeout(500);
  await page.reload();
  await expect(row('Chicken Tikka (Leg)').getByLabel(/^DINE_IN/)).toHaveValue('400.00');

  // an invalid amount is flagged and not sent
  const takeaway = row('Chicken Tikka (Leg)').getByLabel(/^TAKEAWAY/);
  await takeaway.fill('12.345');
  await takeaway.press('Enter');
  await expect(takeaway).toHaveClass(/border-rose-500/);

  // the 86 toggle
  const available = page.getByRole('switch', { name: /Available Chicken Tikka \(Leg\)/ });
  await expect(available).toHaveAttribute('aria-checked', 'true');
  await available.click();
  await expect(available).toHaveAttribute('aria-checked', 'false');
  await available.click();

  // new item with prices
  await page.getByRole('button', { name: /New item/ }).click();
  const dialog = page.getByRole('dialog', { name: 'New item' });
  await dialog.getByLabel('Name', { exact: true }).fill('E2E Special Dish');
  await dialog.getByLabel('Station').selectOption({ label: 'BBQ' });
  await dialog.getByLabel('price DINE_IN').fill('777');
  await dialog.getByLabel('price TAKEAWAY').fill('777');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(row('E2E Special Dish')).toBeVisible();
  await expect(row('E2E Special Dish').getByLabel(/^DINE_IN/)).toHaveValue('777.00');
  await expect(row('E2E Special Dish').getByLabel(/^DELIVERY/)).toHaveValue(''); // not sold for delivery

  // the POS menu follows immediately
  await page.goto('/');
  await page.getByRole('button', { name: /T4/ }).click();
  await expect(page.getByRole('button', { name: /E2E Special Dish/ })).toBeVisible();
});

test('CSV import in the UI: problems are listed by line, a good file is checked then applied', async ({
  page,
}) => {
  await login(page, 'owner');
  await page.goto('/admin/menu');
  await page.getByRole('button', { name: 'Import CSV' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import menu from CSV' });

  await dialog.getByLabel('Choose a CSV file').setInputFiles({
    name: 'bad.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('item_code,item_name,price_dine_in\nBAD1,Bad item,12.345\n'),
  });
  await dialog.getByRole('button', { name: 'Check file' }).click();
  await expect(dialog).toContainText('Problems found');
  await expect(dialog).toContainText('Line 2');
  await expect(dialog.getByRole('button', { name: 'Apply import' })).toBeDisabled();

  const good =
    'category,item_code,item_name,item_name_ur,station,price_dine_in,price_takeaway,price_delivery\nBBQ,E2E-BOTI,E2E Boti,ای ٹو ای بوٹی,BBQ,500,500,550\n';
  await dialog
    .getByLabel('Choose a CSV file')
    .setInputFiles({ name: 'good.csv', mimeType: 'text/csv', buffer: Buffer.from(good, 'utf8') });
  await dialog.getByRole('button', { name: 'Check file' }).click();
  await expect(dialog).toContainText('items +1');
  await dialog.getByRole('button', { name: 'Apply import' }).click();
  await expect(dialog.getByRole('status')).toContainText('Import applied');
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(page.getByRole('row').filter({ hasText: 'E2E Boti' })).toBeVisible();
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: 'E2E Boti' })
      .getByLabel(/^DELIVERY/),
  ).toHaveValue('550.00');
});

test('printers: add one, send a test page to it, and map a station', async ({ page }) => {
  const port = (printer.address() as { port: number }).port;
  await login(page, 'owner');
  await page.goto('/admin/printers');
  await page.getByRole('button', { name: /Add printer/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Add printer' });
  await dialog.getByLabel('Name', { exact: true }).fill('E2E bar printer');
  await dialog.getByLabel('IP address').fill('127.0.0.1');
  await dialog.getByLabel('Port', { exact: true }).fill(String(port));
  await dialog.getByRole('button', { name: 'Save' }).click();

  // the printers table row (the station-mapping header also mentions the name)
  const row = page
    .getByRole('row')
    .filter({ hasText: 'E2E bar printer' })
    .filter({ has: page.getByRole('button', { name: /Test page/ }) });
  await expect(row).toContainText('Not used yet');
  await row.getByRole('button', { name: /Test page/ }).click();
  await expect(page.getByRole('status')).toContainText('Test page queued');
  await expect.poll(() => tickets.length, { timeout: 15_000 }).toBeGreaterThan(0);
  expect(tickets.join('\n')).toContain('TEST PAGE');
  expect(tickets.join('\n')).toContain('E2E bar printer');
  await expect(row).toContainText('OK', { timeout: 15_000 });

  await page.getByRole('checkbox', { name: 'DRINKS → E2E bar printer' }).check();
  await page.reload();
  await expect(page.getByRole('checkbox', { name: 'DRINKS → E2E bar printer' })).toBeChecked();
});

test('tables: new area and table appear on the floor', async ({ page }) => {
  await login(page, 'owner');
  await page.goto('/admin/tables');
  await page.getByRole('button', { name: /New area/ }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Terrace');
  await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
  await page.getByRole('button', { name: /New table/ }).click();
  const dialog = page.getByRole('dialog', { name: 'New table' });
  await dialog.getByLabel('Code').fill('E9');
  await dialog.getByLabel('Area').selectOption({ label: 'Terrace' });
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'E9' })).toContainText('Terrace');

  await page.goto('/');
  await expect(page.getByRole('button', { name: /E9/ })).toContainText('Free');
});

test('users: create a captain, reset the PIN, and the new PIN signs in; captains see no admin', async ({
  page,
}) => {
  await login(page, 'owner');
  await page.goto('/admin/users');
  await page.getByRole('button', { name: /New user/ }).click();
  const dialog = page.getByRole('dialog', { name: 'New user' });
  await dialog.getByLabel('Full name').fill('E2E Captain');
  await dialog.getByLabel('Username').fill('e2e.captain');
  await dialog.getByLabel('Role').selectOption({ label: 'Captain / Waiter' });
  await dialog.getByLabel('PIN (4-8 digits)').fill('5555');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'e2e.captain' })).toContainText('Captain');

  await page.getByRole('button', { name: 'Reset PIN e2e.captain' }).click();
  await page.getByRole('dialog').getByLabel('New PIN').fill('6666');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();

  await login(page, 'e2e.captain', '6666');
  await expect(page.getByRole('link', { name: 'Admin' })).toHaveCount(0);
  await page.goto('/admin/users');
  await expect(page).toHaveURL(/\/$/); // no permission: sent back to the floor
});

test('the admin area works in Urdu (right-to-left)', async ({ page }) => {
  await login(page, 'owner');
  await page.goto('/admin/menu');
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('menuitem', { name: 'اردو' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('link', { name: 'مینو', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /نیا آئٹم/ })).toBeVisible();
});
