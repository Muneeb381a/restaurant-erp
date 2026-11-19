import { expect, test, type Page } from '@playwright/test';

// Runs after the earlier specs (menu, tables, a day and some sales exist).
test.describe.configure({ mode: 'serial' });

async function loginOwner(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill('owner');
  for (const digit of '1234') await page.getByRole('button', { name: digit, exact: true }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Tables', exact: true })).toBeVisible();
}

test('a table can be edited and deleted; one with an open order is refused, one with only old orders is removed', async ({
  page,
}) => {
  await loginOwner(page);
  await page.goto('/admin/tables');

  // add, edit, delete a table nobody has used
  await page.getByRole('button', { name: 'New table' }).click();
  await page.getByRole('dialog').getByLabel('Code').fill('Z9');
  await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
  const row = (name: string) => page.getByRole('row').filter({ hasText: name });
  await expect(row('Z9')).toBeVisible();

  await page.getByRole('button', { name: 'Edit Z9' }).click();
  await page.getByRole('dialog').getByLabel('Code').fill('Z10');
  await page.getByRole('dialog').getByLabel('Seats').fill('6');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(row('Z10')).toContainText('6');
  await expect(row('Z9')).toHaveCount(0);

  await page.getByRole('button', { name: 'Delete Z10' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(row('Z10')).toHaveCount(0);

  // a table with an OPEN order cannot be deleted, and the dialog says why
  const token = await page.evaluate(() => {
    const raw = localStorage.getItem('erp-auth');
    return raw ? (JSON.parse(raw).state.tokens.accessToken as string) : '';
  });
  const headers = { authorization: `Bearer ${token}` };
  const makeTable = async (code: string): Promise<string> => {
    const res = await page.request.post('/api/v1/tables', { headers, data: { code, seats: 2 } });
    return (await res.json()).id as string;
  };
  const openOrder = async (tableId: string): Promise<string> => {
    const res = await page.request.post('/api/v1/orders', {
      headers,
      data: { type: 'DINE_IN', tableId },
    });
    return (await res.json()).id as string;
  };
  const cancel = async (orderId: string): Promise<void> => {
    const cur = await (await page.request.get(`/api/v1/orders/${orderId}`, { headers })).json();
    await page.request.post(`/api/v1/orders/${orderId}/cancel`, {
      headers: { ...headers, 'if-match': String(cur.version) },
      data: { reason: 'e2e' },
    });
  };
  const busy = await makeTable('Z11');
  const order = await openOrder(busy);
  await page.reload();
  await page.getByRole('button', { name: 'Delete Z11' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('open order');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

  // once the order is over the table had history, yet it can be deleted: it disappears for good
  await cancel(order);
  await page.reload();
  await page.getByRole('button', { name: 'Delete Z11' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(row('Z11')).toHaveCount(0);
  await page.reload();
  await expect(row('Z11')).toHaveCount(0);
});

test('an area can be renamed and deleted once it is empty', async ({ page }) => {
  await loginOwner(page);
  await page.goto('/admin/tables');
  await page.getByRole('button', { name: 'New area' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Rooftop');
  await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
  await page.getByRole('button', { name: 'Edit area: Rooftop' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Roof');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: 'Edit area: Roof' })).toBeVisible();

  await page.getByRole('button', { name: 'Edit area: Roof' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit area: Roof' })).toHaveCount(0);
});

test('categories and stations are managed in the menu screen and chosen for a new dish', async ({
  page,
}) => {
  await loginOwner(page);
  await page.goto('/admin/menu');

  // create a category and a station from the menu screen
  await page.getByRole('button', { name: 'Categories', exact: true }).click();
  await page.getByRole('button', { name: 'New category' }).click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).last().fill('Sweets');
  await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('dialog').getByText('Sweets')).toBeVisible();
  await page.getByRole('tab', { name: 'Stations' }).click();
  await page.getByRole('button', { name: 'New station' }).click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).last().fill('Mithai');
  await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('dialog').getByText('MITHAI', { exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).last().click();

  // a new dish can now choose them
  await page.getByRole('button', { name: 'New item' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).first().fill('Test Barfi');
  await dialog.getByLabel('Category').selectOption({ label: 'Sweets' });
  await dialog.getByLabel('Station').selectOption({ label: 'MITHAI' });
  await dialog
    .getByRole('button', { name: /Create|Save/ })
    .last()
    .click();
  await expect(page.getByRole('row').filter({ hasText: 'Test Barfi' })).toContainText('Sweets');
});

test('a dish that was never sold is deleted, and a category that still has dishes asks where they go', async ({
  page,
}) => {
  await loginOwner(page);
  await page.goto('/admin/menu');

  // delete lives inside the edit dialog (keeps the table row short)
  await page
    .getByRole('row')
    .filter({ hasText: 'Test Barfi' })
    .getByRole('button', { name: 'Edit' })
    .first()
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Test Barfi' })).toHaveCount(0);

  // a category with dishes is not deleted blindly: it asks where the dishes should go
  await page.getByRole('button', { name: 'Categories', exact: true }).click();
  const used = page
    .getByRole('dialog')
    .getByRole('button', { name: /^Delete /i })
    .first();
  await used.click();
  const ask = page.getByRole('dialog').last();
  await expect(ask.getByText('Move the dishes to')).toBeVisible();
  await expect(ask.getByRole('button', { name: 'Move and delete' })).toBeVisible();
  await ask.getByRole('button', { name: 'Cancel' }).click(); // nothing was deleted
});

test('a user and an ingredient can be edited from their screens', async ({ page }) => {
  await loginOwner(page);

  await page.goto('/admin/users');
  await page.getByRole('button', { name: 'Edit captain' }).click();
  await page.getByRole('dialog').getByLabel('Full name').fill('Captain Bilal');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Captain Bilal')).toBeVisible();

  await page.goto('/admin/stock');
  const edit = page.getByRole('button', { name: /^Edit / }).first();
  await expect(edit).toBeVisible();
  await edit.click();
  await page
    .getByRole('dialog')
    .getByLabel(/Reorder level/)
    .fill('750');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
