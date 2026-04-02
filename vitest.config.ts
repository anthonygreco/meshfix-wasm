import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 30000,
    include: ['__tests__/**/*.test.ts'],
  },
});
