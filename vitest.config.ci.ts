import { defineConfig } from 'vitest/config'

// CI hosted runners:
// - exclude native-sensitive suites (better-sqlite3 / electron Tray) ? they abort the
//   vitest fork during import on hosted images (pass locally); they run isolated in the
//   dedicated 'test-native' diagnostic job (see ci.yml) until root-caused.
// - serialize files: memory spikes + shared userData dirs across tests.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'tests/**/*.{test,spec}.{ts,tsx}'],
    exclude: [
      'node_modules',
      'out',
      'dist',
      'tests/e2e/**',
      '**/main/storage/**/*.test.*',
      '**/main/tray/**/*.test.*',
    ],
    globals: false,
    fileParallelism: false,
  },
})
