import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'tests/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'out', 'dist', 'tests/e2e/**'],
    globals: false,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
    },
  },
})
