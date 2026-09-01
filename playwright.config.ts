import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  // Real Electron launches own the fixed 127.0.0.1:11434 arbitration port —
  // one app instance per run, tests serial, one worker (also serialises the
  // console-error/request ledgers across the narrative smoke).
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  // Electron cold start + tray + arbitration need more headroom than 30s.
  timeout: 90_000,
  expect: { timeout: 10_000 },
  // Build out/ from the CURRENT source before the suite launches the app.
  globalSetup: './tests/e2e/global-setup.ts',
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
