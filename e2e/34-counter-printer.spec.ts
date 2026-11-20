import { createServer, type Server } from 'node:net';
import { expect, request, test, type Page } from '@playwright/test';

/**
 * ONE printer at the counter: kitchen tickets and bills come out of the same machine. The owner flips one switch;
 * an order then prints a single ticket with the token on top, the bill is printed before payment, and the
 * counter finds the order again from the token number alone.
 */
const received: string[] = [];
let printer: Server;

const API = 'http://127.0.0.1:18081/api/v1';
const PASSWORD = 'Dev#Passw0rd';
const PIN = '1234';

test.describe.configure({ mode: 'serial' });

async function login(page: Page, username: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Username').fill(username);
  for (const digit of PIN) await page.getByRole('button', { name: digit, exact: true }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Tables', exact: true })).toBeVisible();
}

test.beforeAll(async () => {
  const api = await request.newContext();
  const t = await api.post(`${API}/auth/login`, {
    data: { username: 'owner', password: PASSWORD },
  });
  const auth = { Authorization: `Bearer ${(await t.json()).accessToken}` };

  printer = createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on('data', (c) => chunks.push(c));
    socket.on('close', () => received.push(Buffer.concat(chunks).toString('latin1')));
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => printer.listen(0, '127.0.0.1', resolve));
  const port = (printer.address() as { port: number }).port;
  const mk = async (name: string, kind: 'KOT' | 'RECEIPT'): Promise<string> => {
    const r = await api.post(`${API}/printers`, {
      headers: auth,
      data: { name, kind, conn_type: 'NETWORK', host: '127.0.0.1', port, paper_mm: 80 },
    });
    expect(r.ok(), await r.text()).toBe(true);
    return (await r.json()).id as string;
  };
  const kot = await mk('Counter printer (kitchen)', 'KOT');
  await mk('Counter printer (receipts)', 'RECEIPT');
  const stations = (await (await api.get(`${API}/stations`, { headers: auth })).json()).items as {
    id: string;
    code: string;
  }[];
  for (const code of ['BBQ', 'KARAHI']) {
    const st = stations.find((s) => s.code === code)!;
    const cur = (await (
      await api.get(`${API}/stations/${st.id}/printers`, { headers: auth })
    ).json()) as {
      printerIds?: string[];
    };
    await api.put(`${API}/stations/${st.id}/printers`, {
      headers: auth,
      data: { printerIds: [...new Set([...(cur.printerIds ?? []), kot])] },
    });
  }
  await api.dispose();
});
test.afterAll(async () => {
  await new Promise((resolve) => printer.close(resolve));
});

test('the owner switches on "One printer at the counter" with one tap', async ({ page }) => {
  await login(page, 'owner');
  await page.goto('/admin/settings');
  const one = page.getByRole('switch', { name: 'One printer at the counter' });
  await expect(one).toHaveAttribute('aria-checked', 'false');
  await one.click();
  await expect(one).toHaveAttribute('aria-checked', 'true');
  // it set both detailed switches: one ticket per order, and no second print after payment
  await expect(
    page.getByRole('switch', { name: 'One kitchen ticket for the whole order' }),
  ).toHaveAttribute('aria-checked', 'true');
  await expect(
    page.getByRole('switch', { name: 'Print the receipt by itself after payment' }),
  ).toHaveAttribute('aria-checked', 'false');
  // and it hid the Kitchen screen
  await expect(page.getByRole('switch', { name: 'Show the Kitchen screen' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
});

test('an order prints ONE ticket with the token; the bill is printed before payment; paying prints nothing more; the token finds the order', async ({
  page,
}) => {
  await login(page, 'cashier');
  // the day and a shift are open from the earlier specs; open them if this spec runs alone
  const hasShift = await page
    .getByText('Shift open')
    .waitFor({ timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (!hasShift) {
    await page.getByRole('button', { name: /^Day / }).click();
    await page.getByRole('button', { name: 'Open shift' }).first().click();
    await page.getByRole('dialog').getByRole('textbox').fill('5000');
    await page.getByRole('button', { name: 'Open shift' }).last().click();
    await expect(page.getByText('Shift open')).toBeVisible();
  }

  await page.getByRole('button', { name: 'New takeaway' }).click();
  await expect(page).toHaveURL(/\/order\//);
  const header = page.locator('h1').filter({ hasText: /Token\s*\D{0,3}\d+/ });
  await expect(header).toBeVisible();
  const token = ((await header.innerText()).match(/Token\s*\D{0,3}(\d+)/) ?? [])[1];
  expect(token, 'the order header shows its token').toBeTruthy();

  await page.getByRole('button', { name: /^Chicken Tikka \(Leg\)/ }).click(); // station BBQ
  await expect(page.locator('aside')).toContainText('Rs 360');
  await page.getByRole('button', { name: /^Chicken Karahi/ }).click(); // station KARAHI
  await page.getByRole('button', { name: /Full.*Rs 2,400/ }).click();
  await page.getByRole('button', { name: /^Add/ }).click();
  // counter mode: no "Send to kitchen" button; a KOT button and a separate token button instead
  await expect(page.getByRole('button', { name: 'Send to kitchen' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Print token' }).click();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: /Token \d+ printed/ })
      .first(),
  ).toBeVisible();
  await expect
    .poll(
      () => received.some((r) => r.includes('Show it when you pay.') && r.includes(String(token))),
      {
        timeout: 20_000,
      },
    )
    .toBe(true);

  await page.getByRole('button', { name: 'Print KOT' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'KOT printed' }).first()).toBeVisible();

  // ONE ticket for both stations, the token on top
  await expect
    .poll(() => received.filter((r) => r.includes('KARAHI')).length, { timeout: 20_000 })
    .toBe(1);
  const ticket = received.find((r) => r.includes('KARAHI'))!;
  expect(ticket).toContain(`TOKEN ${token}`);
  expect(ticket).toContain('BBQ');
  expect(ticket).toContain('1 x Chicken Tikka (Leg)');
  expect(ticket).toContain('1 x Chicken Karahi (Full)');

  // the bill: its header carries the token; "Print bill" sends it to the same printer, not paid
  await page.getByRole('button', { name: /^Bill/ }).click();
  await expect(page).toHaveURL(/\/pay$/);
  await expect(page.getByTestId('token')).toContainText(new RegExp(`Token\\s*\\D{0,3}${token}`));
  const before = received.length;
  await page.getByRole('button', { name: 'Print bill' }).click();
  await expect.poll(() => received.length, { timeout: 20_000 }).toBe(before + 1);
  const bill = received[received.length - 1]!;
  expect(bill).toContain('BILL - NOT PAID');
  expect(bill).toContain(`TOKEN ${token}`);
  expect(bill).toContain('Rs 2,760');
  expect(bill).not.toContain('\x1bp'); // the drawer does not open for a bill that is not paid

  // take the money: nothing more comes out of the printer, but the paid screen shows the token
  await page.getByRole('button', { name: 'Cash', exact: true }).click();
  await page.getByRole('button', { name: /^\W*5,?000\W*$/ }).click();
  await page.getByRole('button', { name: /^Take payment/ }).click();
  await expect(page.getByRole('heading', { name: 'Paid' })).toBeVisible();
  await page.waitForTimeout(4000); // longer than the print worker's polling
  expect(received.length).toBe(before + 1);
  await expect(page.getByRole('button', { name: 'Print receipt', exact: true })).toBeVisible(); // still available on request

  // the customer comes back with the token: type it at the counter and land on that order
  await page.goto('/');
  await page.getByLabel('Find token').fill(String(token));
  await page.getByRole('button', { name: 'Find token' }).click();
  await expect(page).toHaveURL(/\/order\/.+\/pay$/);
  await expect(page.getByRole('heading', { name: 'Paid' })).toBeVisible();

  // an unknown token says so
  await page.goto('/');
  await page.getByLabel('Find token').fill('9999');
  await page.getByRole('button', { name: 'Find token' }).click();
  await expect(page.getByText('No order with that token today')).toBeVisible();
});

test('a table: send prints the ticket, one tap on the table prints the bill, paying later frees the table; the Kitchen screen is hidden', async ({
  page,
}) => {
  await login(page, 'cashier');
  // the owner's preset hid the Kitchen screen: no link, and the address goes back to the tables
  await expect(page.getByRole('link', { name: 'Kitchen' })).toHaveCount(0);
  await page.goto('/kitchen');
  await expect(page.getByRole('heading', { name: 'Tables', exact: true })).toBeVisible();

  // table T2: order, send (the ticket prints with the token)
  await page.getByRole('button', { name: /T2/ }).click();
  await expect(page).toHaveURL(/\/order\//);
  await page.getByRole('button', { name: /^Chicken Tikka \(Leg\)/ }).click();
  await page.getByRole('button', { name: 'Print KOT' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'KOT printed' }).first()).toContainText(
    'Token',
  );
  const afterSend = received.length;

  // back on the floor: ONE tap on the table's "Print bill" prints it for the customer
  await page.getByRole('link', { name: 'Tables' }).first().click();
  await expect(page.getByRole('button', { name: /T2/ })).toBeVisible();
  await page
    .getByRole('button', { name: /^T2 / })
    .locator('xpath=following-sibling::div//button[contains(., "Print bill")]')
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Bill printed for T2' }).first(),
  ).toBeVisible();
  void afterSend;
  await expect
    .poll(() => received.some((r) => r.includes('BILL - NOT PAID') && r.includes('Table T2')), {
      timeout: 20_000,
    })
    .toBe(true);
  await expect(page.getByRole('button', { name: /^T2 / })).toContainText('Bill ready');

  // the customer pays later: the table shows "Take payment", then the table is free again
  await page
    .getByRole('button', { name: /^T2 / })
    .locator('xpath=following-sibling::div//button[contains(., "Take payment")]')
    .click();
  await expect(page).toHaveURL(/\/pay$/);
  await page.getByRole('button', { name: 'Cash', exact: true }).click();
  await page
    .getByRole('button', { name: /^\W*5,?00\W*$/ })
    .first()
    .click();
  await page.getByRole('button', { name: /^Take payment/ }).click();
  await expect(page.getByRole('heading', { name: 'Paid' })).toBeVisible();
  await expect(page.getByTestId('table-free')).toContainText('T2');
  await page.getByRole('link', { name: 'Done' }).click();
  await expect(page.getByRole('button', { name: /^T2 / })).toContainText('Free');
});
