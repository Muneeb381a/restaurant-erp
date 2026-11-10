import { createServer, type Server } from 'node:net';
import { expect, request, test, type Page } from '@playwright/test';

// A fake counter printer that records every job (receipts, slips, drawer pulses).
const jobs: Buffer[] = [];
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
  await expect(page.getByRole('heading', { name: 'Tables' })).toBeVisible();
}

test.beforeAll(async () => {
  const api = await request.newContext();
  const t = await api.post(`${API}/auth/login`, {
    data: { username: 'owner', password: PASSWORD },
  });
  const auth = { Authorization: `Bearer ${(await t.json()).accessToken}` };

  // retire the counter printers of earlier specs (their fake servers are gone), then add ours
  const existing = (await (await api.get(`${API}/printers`, { headers: auth })).json()).items as {
    id: string;
    kind: string;
  }[];
  for (const p of existing.filter((x) => x.kind === 'RECEIPT'))
    await api.patch(`${API}/printers/${p.id}`, { headers: auth, data: { is_active: false } });

  printer = createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on('data', (c) => chunks.push(c));
    socket.on('close', () => jobs.push(Buffer.concat(chunks)));
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => printer.listen(0, '127.0.0.1', resolve));
  const r = await api.post(`${API}/printers`, {
    headers: auth,
    data: {
      name: 'Shift slip printer',
      kind: 'RECEIPT',
      conn_type: 'NETWORK',
      host: '127.0.0.1',
      port: (printer.address() as { port: number }).port,
      paper_mm: 80,
    },
  });
  expect(r.ok(), await r.text()).toBe(true);
  await api.dispose();
});

test.afterAll(async () => {
  await new Promise((resolve) => printer.close(resolve));
});

const text = (b: Buffer): string => b.toString('latin1');

test('cashier records a paid-out, opens the drawer with no sale, and closes the shift with a variance note', async ({
  page,
}) => {
  await login(page, 'cashier');
  await expect(page.getByText('Shift ✓')).toBeVisible();

  // ── paid-out: needs a reason; more than the drawer holds is refused
  await page.getByRole('button', { name: 'Cash drawer' }).click();
  await page.getByRole('button', { name: 'Paid out / cash in / drop' }).click();
  await page.getByLabel('Amount (Rs)').fill('9999999');
  await page.getByLabel('Reason', { exact: true }).fill('Vegetables');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('There is not that much cash in the drawer')).toBeVisible();
  await page.getByLabel('Amount (Rs)').fill('50');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved')).toBeVisible();

  // ── no sale: opens the drawer, a pulse reaches the printer
  await page.getByRole('button', { name: 'No sale (open drawer)' }).click();
  await page.getByLabel('Reason', { exact: true }).fill('Change for a guest');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Drawer opened')).toBeVisible();
  await expect
    .poll(() => jobs.some((j) => j.includes(Buffer.from([0x1b, 0x70]))), { timeout: 15_000 })
    .toBe(true);

  // ── close: a wrong count needs an explanation (blind: the expected cash is not shown)
  await page.getByRole('button', { name: 'Close shift' }).click();
  await expect(page.getByText('Expected')).toHaveCount(0);
  await page.getByLabel('Counted cash (Rs)').fill('1');
  await page.getByRole('button', { name: 'Close shift' }).last().click();
  await expect(page.getByText(/The drawer does not match the system/)).toBeVisible();
  await page.getByLabel(/^Note/).fill('Counted in a hurry');
  await page.getByRole('button', { name: 'Close shift' }).last().click();

  await expect(page.getByRole('heading', { name: 'Shift closed' })).toBeVisible();
  await expect(page.getByTestId('variance')).toContainText('Short');
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  // the slip is printed, and the top bar offers to open a new shift
  await expect
    .poll(() => jobs.some((j) => text(j).includes('SHIFT CLOSE')), { timeout: 15_000 })
    .toBe(true);
  await expect(page.getByRole('button', { name: 'Open shift' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cash drawer' })).toHaveCount(0);
});

test('a manager cannot close the day while orders are still open; cashiers have no such button', async ({
  page,
  browser,
}) => {
  const cashierPage = await (await browser.newContext()).newPage();
  await login(cashierPage, 'cashier');
  await expect(cashierPage.getByRole('button', { name: 'Close day' })).toHaveCount(0);
  await cashierPage.context().close();

  await login(page, 'manager');
  await page.getByRole('button', { name: 'Close day' }).click();
  await expect(page.getByText('This ends the trading day')).toBeVisible();
  await page.getByRole('button', { name: 'Close day' }).last().click();
  // the server lists exactly what is blocking, nothing is abandoned silently
  await expect(page.getByText(/These orders are not settled or cancelled: #\d+/)).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText(/Business day:/)).toBeVisible(); // still open
});
