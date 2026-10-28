import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['scripts/**/*.test.mjs', 'test/**/*.test.ts'],
    // The stdio tests start the built server as a separate process.
    testTimeout: 20_000,
  },
})
