import { defineConfig } from 'vitest/config';

const full = { branches: 100, functions: 100, lines: 100, statements: 100 };

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      // CLAUDE.md: 100% branch coverage on money/tax/split. Everything that decides prices or
      // validates a selection is held to the same bar; the CSV import planner (a large
      // data-shuffling module with many defensive branches) to a high-but-not-absolute one.
      thresholds: {
        'src/money.ts': full,
        'src/menu/price.ts': full,
        'src/menu/modifiers.ts': full,
        'src/menu/deals.ts': full,
        'src/menu/categories.ts': full,
        'src/allocate.ts': full,
        'src/orders/line.ts': full,
        'src/orders/state.ts': full,
        'src/billing/bill.ts': full,
        'src/billing/tender.ts': full,
        'src/billing/refund.ts': full,
        'src/billing/tax.ts': full,
        'src/inventory/stock.ts': full,
        'src/cash/drawer.ts': full,
        'src/khata/ledger.ts': full,
        'src/menu/import.ts': { branches: 85, functions: 95, lines: 95, statements: 95 },
      },
    },
  },
});
