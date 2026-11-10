import { defineConfig, devices } from '@playwright/test';

// End-to-end tests run against their OWN database (erp_e2e) and their own ports, so they never
// touch dev data. The API server starts from a freshly reset + seeded database every run.
const API_PORT = 18081;
const WEB_PORT = 15174;
const DB_URL =
  process.env.E2E_DATABASE_URL ?? 'postgres://erp:erp_dev_password@localhost:15432/erp_e2e';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    viewport: { width: 1100, height: 760 }, // counter tablet / small PC
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
      // reset + migrate + seed the e2e database, then serve the API
      command: 'pnpm db:up && pnpm --filter @erp/api db:reset && pnpm --filter @erp/api start',
      env: { DATABASE_URL: DB_URL, PORT: String(API_PORT) },
      url: `http://127.0.0.1:${API_PORT}/health`,
      timeout: 180_000,
      reuseExistingServer: false,
    },
    {
      command: 'pnpm --filter @erp/web dev',
      env: { WEB_PORT: String(WEB_PORT), PORT: String(API_PORT) },
      url: `http://127.0.0.1:${WEB_PORT}`,
      timeout: 60_000,
      reuseExistingServer: false,
    },
  ],
});
