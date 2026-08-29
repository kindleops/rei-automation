import { defineConfig } from '@playwright/test'

/**
 * Lane G — responsive + accessibility gate (constitution §15/§16/§17).
 *
 * Deliberately has NO `webServer`: the dashboard dev server and the API are
 * long-lived shared processes in this workspace, and starting a second one is
 * how ports and caches get corrupted. Point the gate at a running server:
 *
 *   npm run gate:a11y                                   # 127.0.0.1:5188
 *   LC_BASE_URL=http://127.0.0.1:4173 npm run gate:a11y # preview build
 *   LC_A11Y_ROUTES=all npm run gate:a11y                # all 16 routes
 */
export default defineConfig({
  testDir: './tests/a11y',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  outputDir: 'test-results/a11y',
  reporter: [['list']],
  workers: process.env.CI ? 2 : 3,
  retries: 0,
  use: {
    baseURL: process.env.LC_BASE_URL || 'http://127.0.0.1:5188',
    colorScheme: 'dark',
    trace: 'retain-on-failure',
    video: 'off',
    screenshot: 'only-on-failure',
  },
})
