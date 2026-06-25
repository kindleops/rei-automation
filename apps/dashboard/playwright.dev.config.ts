import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/ui',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: 'test-results/playwright',
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    viewport: { width: 1720, height: 1180 },
    trace: 'retain-on-failure',
  },
})