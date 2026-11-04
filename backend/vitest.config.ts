import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts'],
    globalSetup: './test/global-setup.ts',
    // All suites share one test database.
    fileParallelism: false,
    restoreMocks: true,
    hookTimeout: 60_000,
  },
});
