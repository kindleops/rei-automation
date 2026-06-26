import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/ui',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  outputDir: 'test-results/playwright',
  reporter: [['list']],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5173',
    viewport: { width: 1720, height: 1180 },
    trace: 'retain-on-failure',
    screenshot: 'off',
  },
})