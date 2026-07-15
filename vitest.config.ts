import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Emulator-backed integration tests: generous timeouts, and run test files
    // sequentially so they don't contend on the single Firestore/Auth emulator.
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});
