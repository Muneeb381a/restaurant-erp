import { createServer, type Server } from 'node:net';
import { expect, request, test, type Page } from '@playwright/test';

// A fake counter printer: records every receipt it is sent.
const receipts: string[] = [];
let receiptPrinter: Server;
const kot: string[] = [];
let kitchenPrinter: Server;

const API = 'http://127.0.0.1:18081/api/v1';
const PASSWORD = 'Dev#Passw0rd';
const PIN = '1234';

test.describe.configure({ mode: 'serial' });

const listen = async (sink: string[]): Promise<Server> => {
  const server = createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on('data', (c) => chunks.push(c));
    socket.on('close', () => sink.push(Buffer.concat(chunks).toString('latin1')));
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
};
const portOf = (s: Server): number => (s.address() as { port: number }).port;

async function login(page: Page, username: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill(username);
  for (const digit of PIN) await page.getByRole('button', { name: digit, exact: true }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Tables' })).toBeVisible();
}

test.beforeAll(async () => {
  const api = await request.newContext();
  const t = await api.post(`${API}/auth/login`, {
    data: { username: 'owner', password: PASSWORD },
  });
  const auth = { Authorization: `Bearer ${(await t.json()).accessToken}` };

  receiptPrinter = await listen(receipts);
  kitchenPrinter = await listen(kot);
  const mk = async (name: string, kind: 'RECEIPT' | 'KOT', port: number): Promise<string> => {
    const r = await api.post(`${API}/printers`, {
      headers: auth,
      data: { name, kind, conn_type: 'NETWORK', host: '127.0.0.1', port, paper_mm: 80 },
    });
    expect(r.ok(), await r.text()).toBe(true);
    return (await r.json()).id as string;
  };
  await mk('Counter receipt printer', 'RECEIPT', portOf(receiptPrinter));
  const kitchen = await mk('Kitchen 2', 'KOT', portOf(kitchenPrinter));
  const stations = (await (await api.get(`${API}/stations`, { headers: auth })).json()).items as {
    id: string;
    code: string;
  }[];
  // BBQ already prints to the 01-pos printer; add this one too so the test owns its tickets
  const bbq = stations.find((s) => s.code === 'BBQ')!;
  const current = (await (
    await api.get(`${API}/stations/${bbq.id}/printers`, { headers: auth })
  ).json()) as {
    printerIds?: string[];
  };
  await api.put(`${API}/stations/${bbq.id}/printers`, {
    headers: auth,
    data: { printerIds: [...new Set([...(current.printerIds ?? []), kitchen])] },
  });
  await api.dispose();
});

test.afterAll(async () => {
  await Promise.all(
    [receiptPrinter, kitchenPrinter].map((s) => new Promise((resolve) => s.close(resolve))),
  );
});

/** Opens the table, orders one Chicken Tikka (Rs 400), sends it, and goes to the payment screen. */
async function orderAndBill(page: Page, table: string): Promise<void> {
  // the shift status loads asynchronously: wait for it instead of guessing from the first paint
  const hasShift = await page
    .getByText('Shift ✓')
    .waitFor({ timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (!hasShift) {
    await page.getByRole('button', { name: 'Open shift' }).click();
    await page.getByRole('textbox').fill('5000');
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByText('Shift ✓')).toBeVisible();
  }
  await page.getByRole('button', { name: new RegExp(table) }).click();
  await page.getByRole('button', { name: /Chicken Tikka \(Leg\)/ }).click();
  await expect(page.locator('aside')).toContainText('Rs 400');

  // billing is refused until everything is in the kitchen
  await expect(page.getByRole('button', { name: 'Bill', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Send to kitchen' }).click();
  await expect(page.locator('aside')).toContainText('Sent to the kitchen');
  await page.getByRole('button', { name: 'Bill', exact: true }).click();
  await expect(page).toHaveURL(/\/pay$/);
  await expect(page.getByTestId('bill-total')).toContainText('Rs 400');
}

test('cash payment with a 10% discount: change is shown, the receipt prints and kicks the drawer', async ({
  page,
}) => {
  await login(page, 'cashier');
  await orderAndBill(page, 'T3');

  // 10% is within the cashier's limit: no manager needed, but a reason is
  await page.getByRole('button', { name: /10%/ }).click();
  await expect(page.getByRole('button', { name: 'Apply' })).toBeDisabled();
  await page.getByPlaceholder('Reason (required)').fill('Regular guest');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByTestId('bill-total')).toContainText('Rs 360');

  await page.getByRole('button', { name: '+ Cash', exact: true }).click();
  await expect(page.getByTestId('remaining')).toContainText('Rs 0');
  await expect(page.getByRole('button', { name: 'Settle bill' })).toBeEnabled();

  // cash received below the amount keeps the button disabled
  await page.getByLabel('Cash received').fill('100');
  await expect(page.getByRole('button', { name: 'Settle bill' })).toBeDisabled();
  await page.getByRole('button', { name: /^\W*500\W*$/ }).click(); // quick amount 500, not 5000
  await page.getByRole('button', { name: 'Settle bill' }).click();

  await expect(page.getByText('✓ Paid')).toBeVisible();
  await expect(page.getByTestId('change-due')).toContainText('Rs 140'); // 500 − 360

  await expect.poll(() => receipts.length, { timeout: 15_000 }).toBe(1);
  expect(receipts[0]).toContain('TOTAL');
  expect(receipts[0]).toContain('Rs 360');
  expect(receipts[0]).toContain('Change');
  expect(receipts[0]).toContain('\x1bp'); // ESC p: open the cash drawer

  // a reprint is marked as a duplicate and does not kick the drawer
  await page.getByRole('button', { name: 'Reprint receipt' }).click();
  await expect(page.getByText('Receipt sent to printer')).toBeVisible();
  await expect.poll(() => receipts.length, { timeout: 15_000 }).toBe(2);
  expect(receipts[1]).toContain('DUPLICATE #1');
  expect(receipts[1]).not.toContain('\x1bp');

  await page.getByRole('link', { name: 'Done' }).click();
  await expect(page.getByRole('button', { name: /T3/ })).toContainText('Free');
});

test('a 20% discount needs a manager PIN; the bill is then split between cash and card', async ({
  page,
}) => {
  await login(page, 'cashier');
  await orderAndBill(page, 'T4');

  await page.getByRole('button', { name: /20%/ }).click();
  await page.getByPlaceholder('Reason (required)').fill('Birthday');
  await page.getByRole('button', { name: 'Apply' }).click();

  // above the cashier's limit → manager approval dialog; a wrong PIN is refused
  await expect(page.getByText('Manager approval needed')).toBeVisible();
  await page.getByPlaceholder('Manager username').fill('manager');
  await page.getByPlaceholder('Manager PIN').fill('9999');
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText('Approver username or PIN is wrong')).toBeVisible();
  await page.getByPlaceholder('Manager PIN').fill(PIN);
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByTestId('bill-total')).toContainText('Rs 320'); // 400 − 20%

  // Rs 100 cash + the rest on card (card needs a reference)
  await page.getByRole('button', { name: '+ Cash', exact: true }).click();
  await page.getByLabel('Cash Amount').fill('100');
  await expect(page.getByTestId('remaining')).toContainText('Rs 220');
  await page.getByRole('button', { name: '+ Debit/Credit Card' }).click();
  await expect(page.getByTestId('remaining')).toContainText('Rs 0');
  await expect(page.getByRole('button', { name: 'Settle bill' })).toBeDisabled(); // reference missing
  await page.getByLabel(/Reference/).fill('RRN-481516');
  await page.getByRole('button', { name: 'Settle bill' }).click();

  await expect(page.getByText('✓ Paid')).toBeVisible();
  await expect(page.getByTestId('change-due')).toContainText('No change');
  await expect.poll(() => receipts.length, { timeout: 15_000 }).toBe(3);
  expect(receipts[2]).toContain('Rs 320');
  expect(receipts[2]).toContain('Cash');
  expect(receipts[2]).toContain('Debit/Credit Card');
});

test('cancelling a bill reopens the order for changes (manager only)', async ({ page }) => {
  await login(page, 'manager');
  await page.getByRole('button', { name: /T3/ }).click();
  await page.getByRole('button', { name: /Chicken Tikka \(Leg\)/ }).click();
  await page.getByRole('button', { name: 'Send to kitchen' }).click();
  await expect(page.locator('aside')).toContainText('Sent to the kitchen');
  await page.getByRole('button', { name: 'Bill', exact: true }).click();
  await expect(page).toHaveURL(/\/pay$/);

  await page.getByRole('button', { name: 'Cancel bill' }).click();
  await page.getByPlaceholder('Why is the bill cancelled?').fill('Guest wants more food');
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page).toHaveURL(/\/order\/[^/]+$/);
  await expect(page.getByRole('button', { name: 'Bill', exact: true })).toBeVisible(); // editable again
});
