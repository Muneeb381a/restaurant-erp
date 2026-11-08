import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    // Testcontainers start/stop is slow on first run (image pull).
    testTimeout: 30_000,
    hookTimeout: 180_000,
    // One Postgres container per test file; keep files sequential to limit load.
    fileParallelism: false,
  },
});
