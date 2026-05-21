import { chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const BASE_URL = process.env.NEXUS_URL || 'http://localhost:5173'
const route = process.env.NEXUS_ROUTE || '/inbox'

const outDir = path.resolve('proof/inbox')
fs.mkdirSync(outDir, { recursive: true })

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const screenshotPath = path.join(outDir, `inbox-light-${stamp}.png`)

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({
  viewport: { width: 1728, height: 1117 },
  deviceScaleFactor: 1,
})

await page.goto(`${BASE_URL}${route}`, { waitUntil: 'networkidle', timeout: 60_000 })
await page.waitForTimeout(2000)

// Toggle light mode
await page.evaluate(() => {
  const root = document.getElementById('nx-inbox-root')
  if (root) {
    root.classList.add('is-light-mode')
    root.classList.remove('is-dark-mode')
  }
});
await page.waitForTimeout(1000)

await page.screenshot({ path: screenshotPath, fullPage: true })
console.log(`✅ Light mode inbox screenshot saved: ${screenshotPath}`)

// Copilot
const avatarMenu = await page.$('.nx-avatar-menu')
if (avatarMenu) {
  await avatarMenu.click()
  await page.waitForTimeout(600)
  const aiMenuItem = await page.$('.nx-avatar-popover button:has-text("AI Assistant")')
  if (aiMenuItem) await aiMenuItem.click()
}
await page.waitForTimeout(1500)
const copilotScreenshotPath = path.join(outDir, `inbox-light-copilot-${stamp}.png`)
await page.screenshot({ path: copilotScreenshotPath, fullPage: true })

await browser.close()
