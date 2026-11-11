import { expect, test, type Page } from '@playwright/test';

const PIN = '1234';

test.describe.configure({ mode: 'serial' });

async function login(page: Page, username: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill(username);
  for (const digit of PIN) await page.getByRole('button', { name: digit, exact: true }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Tables' })).toBeVisible();
}
async function admin(page: Page, section: string): Promise<void> {
  await page.getByRole('link', { name: 'Admin' }).click();
  await page.getByRole('link', { name: 'Stock & costs' }).click(); // all the sections used here are in this area
  await page.getByRole('link', { name: section, exact: true }).click();
}

test('the owner adds an ingredient with opening stock and writes the Tikka recipe', async ({
  page,
}) => {
  await login(page, 'owner');
  await admin(page, 'Stock');
  await page.getByRole('button', { name: /New ingredient/ }).click();
  const d = page.getByRole('dialog', { name: 'New ingredient' });
  await d.getByLabel('Name', { exact: true }).fill('Mutton');
  await d.getByLabel('Opening quantity').fill('10');
  await d.getByLabel(/Opening price/).fill('1800');
  await d.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByTestId('ingredient-Mutton')).toContainText('10000 g');
  await expect(page.getByTestId('ingredient-Mutton')).toContainText('Rs 18,000'); // 10 kg at Rs 1,800

  await admin(page, 'Recipes');
  await expect(page.getByTestId('recipe-row-Chicken Tikka (Leg)')).toContainText('No recipe');
  await page.getByRole('button', { name: 'Recipe Chicken Tikka (Leg)' }).click();
  const r = page.getByRole('dialog', { name: /Recipe: Chicken Tikka/ });
  await r.getByLabel('Item 1').selectOption({ label: 'Mutton (g)' });
  await r.getByLabel('Qty (stored units) 1').fill('100');
  await r.getByRole('button', { name: 'Save recipe' }).click();
  // 100 g × Rs 1.80 = Rs 180 on a Rs 400 dish = 45 %
  await expect(page.getByTestId('recipe-row-Chicken Tikka (Leg)')).toContainText('Rs 180');
  await expect(page.getByTestId('recipe-row-Chicken Tikka (Leg)')).toContainText('45.0%');
});

test('selling two Tikka takes 200 g out of stock, with the cost kept', async ({ page }) => {
  await login(page, 'cashier');
  const hasShift = await page
    .getByText('Shift open')
    .waitFor({ timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (!hasShift) {
    await page.getByRole('button', { name: /^Day / }).click();
    await page.getByRole('button', { name: 'Open shift' }).first().click();
    await page.getByRole('textbox').fill('5000');
    await page.getByRole('button', { name: 'Open shift' }).last().click();
    await expect(page.getByText('Shift open')).toBeVisible();
  }
  await page.getByRole('button', { name: /L1/ }).click();
  await page.getByRole('button', { name: /^Chicken Tikka \(Leg\)/ }).click();
  await page.locator('aside').getByRole('button', { name: 'plus' }).first().click();
  await expect(page.locator('aside')).toContainText('Rs 800');
  await page.getByRole('button', { name: 'Send to kitchen' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Sent to the kitchen' }).first(),
  ).toContainText('Sent to the kitchen');
  await page.getByRole('button', { name: /^Bill/ }).click();
  await page.getByRole('button', { name: 'Cash', exact: true }).click();
  await page.getByRole('button', { name: /^Take payment/ }).click();
  await expect(page.getByRole('heading', { name: 'Paid' })).toBeVisible();
});

test('purchases raise stock, suppliers are paid later, wastage and expenses are recorded', async ({
  page,
}) => {
  await login(page, 'owner');
  await admin(page, 'Stock');
  await expect(page.getByTestId('ingredient-Mutton')).toContainText('9800 g'); // 10 kg − 2 × 100 g

  await admin(page, 'Purchases');
  await page.getByRole('button', { name: '+', exact: true }).click();
  const sd = page.getByRole('dialog', { name: 'New supplier' });
  await sd.getByLabel('Name').fill('Butcher Ali');
  await sd.getByRole('button', { name: 'Add' }).click();
  await page.getByLabel('Supplier', { exact: true }).selectOption({ label: 'Butcher Ali' });
  await page.getByLabel('Ingredient 1').selectOption({ label: 'Mutton (kg)' });
  await page.getByLabel('Qty 1').fill('5');
  await page.getByLabel('Price per unit (Rs) 1').fill('1900');
  await expect(page.getByTestId('purchase-total')).toContainText('Rs 9,500');
  await page.getByRole('button', { name: 'Post purchase' }).click();
  await expect(page.getByText('Purchase posted')).toBeVisible();
  await expect(page.getByTestId('supplier-Butcher Ali')).toContainText('Rs 9,500');

  await page.getByTestId('supplier-Butcher Ali').getByRole('button', { name: 'Pay' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Pay', exact: true }).click();
  await expect(page.getByTestId('supplier-Butcher Ali')).toContainText('Rs 0');

  await admin(page, 'Stock');
  await expect(page.getByTestId('ingredient-Mutton')).toContainText('14800 g'); // + 5 kg
  await page.getByRole('button', { name: 'Wastage / staff meal' }).click();
  const w = page.getByRole('dialog', { name: 'Wastage / staff meal' });
  await w.getByLabel('Ingredient').selectOption({ label: 'Mutton (g)' });
  await w.getByLabel(/Quantity/).fill('300');
  await w.getByRole('button', { name: 'Record' }).click();
  await expect(page.getByTestId('ingredient-Mutton')).toContainText('14500 g');

  await admin(page, 'Costs');
  await page.getByLabel('Category').fill('gas');
  await page.getByLabel('Amount (Rs)').fill('1200');
  await page.getByRole('button', { name: 'Add expense' }).click();
  await expect(page.getByText('Expense recorded')).toBeVisible();
  await expect(page.getByTestId('expense-total')).toContainText('Rs 1,200');
  // the Tikka sold earlier cost 2 × Rs 180 and the report knows it
  await expect(page.getByRole('row').filter({ hasText: 'Chicken Tikka (Leg)' })).toContainText(
    'Rs 360',
  );
  await expect(page.getByTestId('food-cost-totals')).toContainText('Food cost %');
});

test('a stocktake turns a count into an adjustment', async ({ page }) => {
  await login(page, 'owner');
  await admin(page, 'Stock');
  await page.getByRole('button', { name: 'Start a count' }).click();
  const input = page.getByLabel('Mutton Counted');
  await input.fill('14000');
  await input.blur();
  await expect(page.getByText('-500')).toBeVisible();
  await page.getByRole('button', { name: 'Post the count' }).click();
  await expect(page.getByText('Count posted')).toBeVisible();
  await expect(page.getByTestId('ingredient-Mutton')).toContainText('14000 g');
});
