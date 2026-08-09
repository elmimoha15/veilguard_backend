import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Force the console (capturing) email transport for every test — never send
    // real mail even when a real RESEND_API_KEY is present in .env (Vitest loads it).
    setupFiles: ['./test/setup.ts'],
    // Emulator-backed integration tests: generous timeouts, and run test files
    // sequentially so they don't contend on the single Firestore/Auth emulator.
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});
