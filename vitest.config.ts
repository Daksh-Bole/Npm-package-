import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Tests assert on real wall-clock timing in a few places; keep them isolated.
    pool: 'forks',
  },
})
