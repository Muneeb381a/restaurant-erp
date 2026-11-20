import { defineConfig, devices } from '@playwright/test';

// The offline (PWA) tests run against the PRODUCTION build of the web app (the service worker is only registered
// there), on their own ports and database, so they never touch the normal e2e run.
const API_PORT = 18082;
const WEB_PORT = 15175;
const DB_URL =
  process.env.E2E_DATABASE_URL ?? 'postgres://erp:erp_dev_password@localhost:15432/erp_e2e';

export default defineConfig({
  testDir: './e2e-pwa',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    viewport: { width: 1100, height: 760 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1100, height: 760 } },
    },
  ],
  webServer: [
    {
      command: 'pnpm db:up && pnpm --filter @erp/api db:reset && pnpm --filter @erp/api start',
      env: { DATABASE_URL: DB_URL, PORT: String(API_PORT) },
      url: `http://127.0.0.1:${API_PORT}/health`,
      timeout: 180_000,
      reuseExistingServer: false,
    },
    {
      command:
        'pnpm --filter @erp/web build && pnpm --filter @erp/web exec vite preview --host 127.0.0.1 --port ' +
        WEB_PORT +
        ' --strictPort',
      env: { WEB_PORT: String(WEB_PORT), PORT: String(API_PORT) },
      url: `http://127.0.0.1:${WEB_PORT}`,
      timeout: 240_000,
      reuseExistingServer: false,
    },
  ],
});
