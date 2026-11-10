import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLES, startApp, type RoleCode, type TestApp } from './app-harness';

/**
 * The intended grants, written out independently of the migration so a wrong seed fails here.
 * (Q21 in docs/OPEN-QUESTIONS.md: confirm role mapping with the owner.)
 */
const ALL_PERMISSIONS = [
  'day.open',
  'order.create',
  'order.transfer',
  'order.cancel',
  'kot.void',
  'kot.reprint',
  'bill.create',
  'bill.discount',
  'bill.discount.unlimited',
  'bill.settle',
  'bill.reprint',
  'bill.refund',
  'bill.void',
  'price.override',
  'shift.open',
  'shift.close',
  'shift.reopen',
  'day.close',
  'cash.paid_out',
  'drawer.open',
  'menu.manage',
  'menu.availability',
  'tax.manage',
  'user.manage',
  'report.view',
  'report.financial',
  'audit.view',
  'stock.manage',
  'settings.manage',
  'device.manage',
  'khata.collect',
  'customer.manage',
];
const NOT_MANAGER = ['user.manage', 'tax.manage', 'settings.manage', 'device.manage'];

const GRANTS: Record<RoleCode, string[]> = {
  OWNER: ALL_PERMISSIONS,
  MANAGER: ALL_PERMISSIONS.filter((p) => !NOT_MANAGER.includes(p)),
  CASHIER: [
    'day.open',
    'order.create',
    'order.transfer',
    'kot.reprint',
    'bill.create',
    'bill.discount',
    'bill.settle',
    'bill.reprint',
    'shift.open',
    'shift.close',
    'cash.paid_out',
    'drawer.open',
    'menu.availability',
    'report.view',
    'khata.collect',
  ],
  CAPTAIN: ['order.create', 'order.transfer', 'kot.reprint', 'bill.create'],
  KITCHEN: ['menu.availability'],
  STORE: ['stock.manage', 'report.view'],
  ACCOUNTANT: ['report.view', 'report.financial', 'audit.view'],
};

const uuid = (): string => randomUUID();

/**
 * Each probe is a request that is harmless for an authorised caller: the permission check runs
 * before validation/lookup, so allowed → 400/404/2xx, denied → 403 PERMISSION_DENIED.
 */
interface Probe {
  name: string;
  perm: string;
  call: (api: ReturnType<TestApp['as']>) => ReturnType<ReturnType<TestApp['as']>['get']>;
}
const probes: Probe[] = [
  { name: 'GET /users', perm: 'user.manage', call: (a) => a.get('/users') },
  { name: 'POST /users', perm: 'user.manage', call: (a) => a.post('/users', {}) },
  {
    name: 'PATCH /users/:id',
    perm: 'user.manage',
    call: (a) => a.patch(`/users/${uuid()}`, { isActive: true }),
  },
  {
    name: 'POST /users/:id/credentials',
    perm: 'user.manage',
    call: (a) => a.post(`/users/${uuid()}/credentials`, {}),
  },
  {
    name: 'POST /users/:id/unlock',
    perm: 'user.manage',
    call: (a) => a.post(`/users/${uuid()}/unlock`),
  },
  { name: 'GET /roles', perm: 'user.manage', call: (a) => a.get('/roles') },
  { name: 'GET /permissions', perm: 'user.manage', call: (a) => a.get('/permissions') },
  { name: 'POST /roles', perm: 'user.manage', call: (a) => a.post('/roles', {}) },
  {
    name: 'PUT /roles/:id/permissions',
    perm: 'user.manage',
    call: (a) => a.put(`/roles/${uuid()}/permissions`, { permissions: [] }),
  },
  { name: 'POST /areas', perm: 'settings.manage', call: (a) => a.post('/areas', {}) },
  {
    name: 'PATCH /areas/:id',
    perm: 'settings.manage',
    call: (a) => a.patch(`/areas/${uuid()}`, { name: 'x' }),
  },
  { name: 'POST /tables', perm: 'settings.manage', call: (a) => a.post('/tables', {}) },
  { name: 'POST /stations', perm: 'settings.manage', call: (a) => a.post('/stations', {}) },
  {
    name: 'PUT /stations/:id/printers',
    perm: 'settings.manage',
    call: (a) => a.put(`/stations/${uuid()}/printers`, { printerIds: [] }),
  },
  { name: 'POST /printers', perm: 'settings.manage', call: (a) => a.post('/printers', {}) },
  {
    name: 'POST /payment-methods',
    perm: 'settings.manage',
    call: (a) => a.post('/payment-methods', {}),
  },
  { name: 'POST /price-lists', perm: 'settings.manage', call: (a) => a.post('/price-lists', {}) },
  { name: 'PATCH /branch', perm: 'settings.manage', call: (a) => a.patch('/branch', {}) },
  {
    name: 'PUT /settings/billing.round_to_rupee',
    perm: 'settings.manage',
    call: (a) => a.put('/settings/billing.round_to_rupee', { value: true }),
  },
  {
    name: 'PUT /settings/tax.mixed_tender_policy',
    perm: 'tax.manage',
    call: (a) =>
      a.put('/settings/tax.mixed_tender_policy', { value: 'HIGHEST_RATE_IF_ANY_NON_DIGITAL' }),
  },
  { name: 'GET /devices', perm: 'device.manage', call: (a) => a.get('/devices') },
  { name: 'POST /devices', perm: 'device.manage', call: (a) => a.post('/devices', {}) },
  { name: 'GET /audit-log', perm: 'audit.view', call: (a) => a.get('/audit-log') },
  // ── menu (M2)
  { name: 'POST /categories', perm: 'menu.manage', call: (a) => a.post('/categories', {}) },
  {
    name: 'PATCH /categories/:id',
    perm: 'menu.manage',
    call: (a) => a.patch(`/categories/${uuid()}`, { name: 'x' }),
  },
  { name: 'POST /items', perm: 'menu.manage', call: (a) => a.post('/items', {}) },
  {
    name: 'PATCH /items/:id',
    perm: 'menu.manage',
    call: (a) => a.patch(`/items/${uuid()}`, { name: 'x' }),
  },
  {
    name: 'PATCH /items/:id/availability',
    perm: 'menu.availability',
    call: (a) => a.patch(`/items/${uuid()}/availability`, { isAvailable: true }),
  },
  {
    name: 'POST /items/:id/variants',
    perm: 'menu.manage',
    call: (a) => a.post(`/items/${uuid()}/variants`, { name: 'x' }),
  },
  {
    name: 'PATCH /variants/:id',
    perm: 'menu.manage',
    call: (a) => a.patch(`/variants/${uuid()}`, { name: 'x' }),
  },
  {
    name: 'PUT /variants/:id/prices/:list',
    perm: 'menu.manage',
    call: (a) => a.put(`/variants/${uuid()}/prices/${uuid()}`, { pricePaisa: 1 }),
  },
  {
    name: 'POST /modifier-groups',
    perm: 'menu.manage',
    call: (a) => a.post('/modifier-groups', {}),
  },
  {
    name: 'POST /modifier-groups/:id/modifiers',
    perm: 'menu.manage',
    call: (a) => a.post(`/modifier-groups/${uuid()}/modifiers`, {}),
  },
  {
    name: 'PATCH /modifiers/:id',
    perm: 'menu.manage',
    call: (a) => a.patch(`/modifiers/${uuid()}`, { name: 'x' }),
  },
  {
    name: 'PUT /items/:id/modifier-groups',
    perm: 'menu.manage',
    call: (a) => a.put(`/items/${uuid()}/modifier-groups`, { groupIds: [] }),
  },
  {
    name: 'PUT /items/:id/deal',
    perm: 'menu.manage',
    call: (a) => a.put(`/items/${uuid()}/deal`, { slots: [] }),
  },
  { name: 'GET /menu/warnings', perm: 'menu.manage', call: (a) => a.get('/menu/warnings') },
  { name: 'GET /menu/export.csv', perm: 'menu.manage', call: (a) => a.get('/menu/export.csv') },
  { name: 'POST /menu/import', perm: 'menu.manage', call: (a) => a.post('/menu/import', {}) },
  // ── floor & orders (M3)
  {
    name: 'POST /business-days/open',
    perm: 'day.open',
    call: (a) => a.post('/business-days/open', { businessDate: 'bad' }),
  },
  { name: 'POST /shifts/open', perm: 'shift.open', call: (a) => a.post('/shifts/open', {}) },
  { name: 'POST /orders', perm: 'order.create', call: (a) => a.post('/orders', {}) },
  {
    name: 'PATCH /orders/:id',
    perm: 'order.create',
    call: (a) => a.patch(`/orders/${uuid()}`, { guests: 2 }),
  },
  {
    name: 'POST /orders/:id/hold',
    perm: 'order.create',
    call: (a) => a.post(`/orders/${uuid()}/hold`),
  },
  {
    name: 'POST /orders/:id/resume',
    perm: 'order.create',
    call: (a) => a.post(`/orders/${uuid()}/resume`),
  },
  {
    name: 'POST /orders/:id/items',
    perm: 'order.create',
    call: (a) => a.post(`/orders/${uuid()}/items`, {}),
  },
  {
    name: 'PATCH /orders/:id/items/:line',
    perm: 'order.create',
    call: (a) => a.patch(`/orders/${uuid()}/items/${uuid()}`, { qty: 2 }),
  },
  {
    name: 'POST /orders/:id/items/:line/void',
    perm: 'order.create',
    call: (a) => a.post(`/orders/${uuid()}/items/${uuid()}/void`, {}),
  },
  {
    name: 'POST /orders/:id/transfer',
    perm: 'order.transfer',
    call: (a) => a.post(`/orders/${uuid()}/transfer`, {}),
  },
  {
    name: 'POST /orders/:id/merge',
    perm: 'order.transfer',
    call: (a) => a.post(`/orders/${uuid()}/merge`, {}),
  },
  {
    name: 'POST /orders/:id/cancel',
    perm: 'order.cancel',
    call: (a) => a.post(`/orders/${uuid()}/cancel`, {}),
  },
  // ── kitchen & printing (M4)
  {
    name: 'POST /orders/:id/send',
    perm: 'order.create',
    call: (a) => a.post(`/orders/${uuid()}/send`, { course: 0 }),
  },
  {
    name: 'POST /kots/:id/reprint',
    perm: 'kot.reprint',
    call: (a) => a.post(`/kots/${uuid()}/reprint`, {}),
  },
  {
    name: 'GET /print-jobs',
    perm: 'settings.manage',
    call: (a) => a.get('/print-jobs?status=BOGUS'),
  },
  {
    name: 'POST /print-jobs/:id/retry',
    perm: 'settings.manage',
    call: (a) => a.post(`/print-jobs/${uuid()}/retry`),
  },
  // ── billing & payments (M6a)
  {
    name: 'POST /orders/:id/bill',
    perm: 'bill.create',
    call: (a) => a.post(`/orders/${uuid()}/bill`),
  },
  {
    name: 'POST /bills/:id/discount',
    perm: 'bill.discount',
    call: (a) => a.post(`/bills/${uuid()}/discount`, { percentBps: 100, reason: 'probe' }),
  },
  {
    name: 'POST /bills/:id/settle',
    perm: 'bill.settle',
    call: (a) =>
      a.post(`/bills/${uuid()}/settle`, { tenders: [] }).set('Idempotency-Key', 'probe-key-0001'),
  },
  {
    name: 'POST /bills/:id/void',
    perm: 'bill.void',
    call: (a) => a.post(`/bills/${uuid()}/void`, { reason: 'probe' }),
  },
  {
    name: 'POST /bills/:id/reprint',
    perm: 'bill.reprint',
    call: (a) => a.post(`/bills/${uuid()}/reprint`, { reason: 'probe' }),
  },
  // ── shifts, cash and day close (M6b)
  {
    name: 'POST /shifts/:id/close',
    perm: 'shift.close',
    call: (a) => a.post(`/shifts/${uuid()}/close`, { countedCashPaisa: 0 }),
  },
  {
    name: 'POST /shifts/:id/reopen',
    perm: 'shift.reopen',
    call: (a) => a.post(`/shifts/${uuid()}/reopen`, { reason: 'probe' }),
  },
  {
    name: 'POST /cash-movements',
    perm: 'cash.paid_out',
    call: (a) =>
      a
        .post('/cash-movements', { kind: 'DROP', amountPaisa: 1, reason: 'probe' })
        .set('Idempotency-Key', 'probe-key-0002'),
  },
  {
    name: 'POST /drawer/open',
    perm: 'drawer.open',
    call: (a) =>
      a.post('/drawer/open', { reason: 'probe' }).set('Idempotency-Key', 'probe-key-0003'),
  },
  {
    name: 'POST /business-days/close',
    perm: 'day.close',
    call: (a) => a.post('/business-days/close'),
  },
  { name: 'GET /business-days', perm: 'report.financial', call: (a) => a.get('/business-days') },
  {
    name: 'GET /business-days/:id/report',
    perm: 'report.financial',
    call: (a) => a.get(`/business-days/${uuid()}/report`),
  },
  {
    name: 'POST /reports/reprint (day)',
    perm: 'day.close',
    call: (a) => a.post('/reports/reprint', { dayId: uuid(), reason: 'probe' }),
  },
  // ── khata (M6c)
  { name: 'GET /khata/accounts', perm: 'khata.collect', call: (a) => a.get('/khata/accounts') },
  {
    name: 'GET /khata/accounts/:id',
    perm: 'khata.collect',
    call: (a) => a.get(`/khata/accounts/${uuid()}`),
  },
  {
    name: 'POST /khata/accounts',
    perm: 'customer.manage',
    call: (a) => a.post('/khata/accounts', { name: 'Probe', creditLimitPaisa: 0 }),
  },
  {
    name: 'PATCH /khata/accounts/:id',
    perm: 'customer.manage',
    call: (a) => a.patch(`/khata/accounts/${uuid()}`, { isActive: false }),
  },
  {
    name: 'POST /khata/accounts/:id/payments',
    perm: 'khata.collect',
    call: (a) =>
      a
        .post(`/khata/accounts/${uuid()}/payments`, { methodId: uuid(), amountPaisa: 1 })
        .set('Idempotency-Key', 'probe-key-0004'),
  },
  {
    name: 'POST /khata/accounts/:id/adjustments',
    perm: 'customer.manage',
    call: (a) =>
      a.post(`/khata/accounts/${uuid()}/adjustments`, {
        direction: 'UP',
        amountPaisa: 1,
        reason: 'probe',
      }),
  },
  // ── credit notes (M6d)
  { name: 'GET /bills', perm: 'report.view', call: (a) => a.get('/bills') },
  {
    name: 'GET /bills/:id/refundable',
    perm: 'bill.refund',
    call: (a) => a.get(`/bills/${uuid()}/refundable`),
  },
  {
    name: 'POST /bills/:id/credit-notes',
    perm: 'bill.refund',
    call: (a) =>
      a
        .post(`/bills/${uuid()}/credit-notes`, { all: true, methodId: uuid(), reason: 'probe' })
        .set('Idempotency-Key', 'probe-key-0005'),
  },
  // ── tax (M5)
  { name: 'GET /tax/categories', perm: 'tax.manage', call: (a) => a.get('/tax/categories') },
  {
    name: 'POST /tax/categories',
    perm: 'tax.manage',
    call: (a) => a.post('/tax/categories', { code: 'PROBE_CAT', name: 'probe' }),
  },
  { name: 'GET /tax/rules', perm: 'tax.manage', call: (a) => a.get('/tax/rules') },
  {
    name: 'POST /tax/rules',
    perm: 'tax.manage',
    call: (a) => a.post('/tax/rules', { authority: 'PRA' }),
  },
  {
    name: 'PATCH /tax/rules/:id',
    perm: 'tax.manage',
    call: (a) => a.patch(`/tax/rules/${uuid()}`, { verifiedBy: 'x' }),
  },
  { name: 'GET /tax/readiness', perm: 'tax.manage', call: (a) => a.get('/tax/readiness') },
  // ── fiscal (M7)
  { name: 'GET /fiscal/summary', perm: 'report.financial', call: (a) => a.get('/fiscal/summary') },
  { name: 'GET /fiscal/jobs', perm: 'report.financial', call: (a) => a.get('/fiscal/jobs') },
  {
    name: 'GET /fiscal/reconciliation',
    perm: 'report.financial',
    call: (a) => a.get('/fiscal/reconciliation?businessDate=2020-01-01'),
  },
  {
    name: 'POST /fiscal/jobs/:id/retry',
    perm: 'tax.manage',
    call: (a) => a.post(`/fiscal/jobs/${uuid()}/retry`),
  },
];

let t: TestApp;
const tokens = new Map<RoleCode, string>();

beforeAll(async () => {
  t = await startApp();
  for (const role of ROLES) tokens.set(role, (await t.login(role)).token);
}, 180_000);
afterAll(async () => {
  await t.stop();
});

describe('seeded permission grants', () => {
  it.each(ROLES)('%s has exactly the intended permissions', async (role) => {
    const me = await t.as(tokens.get(role)!).get('/auth/me');
    expect([...me.body.permissions].sort()).toEqual([...GRANTS[role]].sort());
  });

  it('every permission is granted to OWNER (guards future migrations that add permissions)', async () => {
    const all = await t.kdb.selectFrom('permissions').select('code').execute();
    expect(all.map((p) => p.code).sort()).toEqual([...ALL_PERMISSIONS].sort());
  });
});

describe('permission matrix: role × sensitive endpoint', () => {
  for (const role of ROLES) {
    describe(role, () => {
      for (const probe of probes) {
        const allowed = GRANTS[role].includes(probe.perm);
        it(`${probe.name} → ${allowed ? 'allowed' : '403'}`, async () => {
          const res = await probe.call(t.as(tokens.get(role)!));
          if (allowed) {
            expect([401, 403], `${probe.name}: ${JSON.stringify(res.body)}`).not.toContain(
              res.status,
            );
          } else {
            expect(res.status).toBe(403);
            expect(res.body.code).toBe('PERMISSION_DENIED');
            expect(res.body.permission).toBe(probe.perm);
          }
        });
      }
    });
  }
});

describe('authentication is required everywhere', () => {
  it.each(probes.map((p) => [p.name, p] as const))(
    '%s → 401 without a token',
    async (_n, probe) => {
      // reuse the helper but strip the header by calling with an invalid token
      const res = await probe.call(t.as('invalid-token'));
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHENTICATED');
    },
  );
});

describe('reads that POS staff need are open to any authenticated user', () => {
  it.each([
    '/areas',
    '/tables',
    '/stations',
    '/printers',
    '/payment-methods',
    '/price-lists',
    '/branch',
    '/settings',
  ])('CAPTAIN can GET %s', async (path) => {
    expect((await t.as(tokens.get('CAPTAIN')!).get(path)).status).toBe(200);
  });
});

describe('permission changes take effect immediately', () => {
  it('revoking a permission from a role blocks the next request', async () => {
    const cashier = tokens.get('CASHIER')!;
    expect((await t.as(cashier).get('/auth/me')).body.permissions).toContain('drawer.open');
    const roleId = await t.roleId('CASHIER');
    const without = GRANTS.CASHIER.filter((p) => p !== 'drawer.open');
    const res = await t
      .as(tokens.get('OWNER')!)
      .put(`/roles/${roleId}/permissions`, { permissions: without });
    expect(res.status).toBe(200);
    expect((await t.as(cashier).get('/auth/me')).body.permissions).not.toContain('drawer.open');
    // restore
    await t
      .as(tokens.get('OWNER')!)
      .put(`/roles/${roleId}/permissions`, { permissions: GRANTS.CASHIER });
  });
});
