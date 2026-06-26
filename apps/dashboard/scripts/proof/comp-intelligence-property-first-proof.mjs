import { chromium } from 'playwright'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const proofDir = path.join(root, 'proof')
fs.mkdirSync(proofDir, { recursive: true })

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5175'
const LAKE_WORTH = '234334277'

async function gotoWorkspace(page, propertyId) {
  await page.goto(`${BASE}/comp-intelligence?property_id=${propertyId}`, { waitUntil: 'domcontentloaded' })
  const workspace = page.locator('[data-comp-intelligence="true"]')
  await workspace.waitFor({ state: 'visible', timeout: 45000 })
  await workspace.locator('.ci-subject-header--property').waitFor({ state: 'visible', timeout: 45000 })
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-comp-intelligence="true"]')
    const count = Number(el?.getAttribute('data-evidence-count') || '0')
    return count > 0
  }, null, { timeout: 60000 })
  await page.locator('.ci-property-comp-card').first().waitFor({ state: 'visible', timeout: 60000 })
  await page.waitForTimeout(1200)
  return workspace
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

try {
  await gotoWorkspace(page, LAKE_WORTH)
  await page.screenshot({ path: path.join(proofDir, 'ci-01-subject-card.png'), fullPage: false })
  await page.screenshot({ path: path.join(proofDir, 'ci-02-map-and-cards.png'), fullPage: true })

  await page.locator('.ci-property-comp-card').first().click()
  await page.waitForTimeout(800)
  await page.screenshot({ path: path.join(proofDir, 'ci-03-comparison-expanded.png'), fullPage: true })

  const pin = page.locator('.ci-comp-pin').first()
  if (await pin.isVisible().catch(() => false)) {
    await pin.click()
    await page.waitForTimeout(600)
    await page.screenshot({ path: path.join(proofDir, 'ci-04-selected-preview.png'), fullPage: false })
  }

  await page.locator('.ci-map-ctrl-btn', { hasText: '0.25 mi' }).click()
  await page.waitForTimeout(2500)
  const count025 = await page.locator('[data-comp-intelligence="true"]').getAttribute('data-evidence-count')
  await page.screenshot({ path: path.join(proofDir, 'ci-05-radius-0.25.png'), fullPage: true })

  await page.locator('.ci-map-ctrl-btn', { hasText: '3 mi' }).click()
  await page.waitForTimeout(2500)
  const count3 = await page.locator('[data-comp-intelligence="true"]').getAttribute('data-evidence-count')
  await page.screenshot({ path: path.join(proofDir, 'ci-06-radius-3mi.png'), fullPage: true })

  await page.locator('.ci-find-more-btn').click()
  await page.waitForTimeout(3000)
  await page.screenshot({ path: path.join(proofDir, 'ci-07-find-more-comps.png'), fullPage: true })

  await page.evaluate(() => document.documentElement.setAttribute('data-nexus-theme', 'light'))
  await page.waitForTimeout(400)
  await page.screenshot({ path: path.join(proofDir, 'ci-08-light-theme.png'), fullPage: true })

  await page.evaluate(() => document.documentElement.setAttribute('data-nexus-theme', 'red_ops'))
  await page.waitForTimeout(400)
  await page.screenshot({ path: path.join(proofDir, 'ci-09-red-ops-theme.png'), fullPage: true })

  await page.setViewportSize({ width: 900, height: 900 })
  await page.waitForTimeout(400)
  await page.screenshot({ path: path.join(proofDir, 'ci-10-narrow-layout.png'), fullPage: true })

  console.log(JSON.stringify({
    ok: true,
    radiusCounts: { '0.25': count025, '3': count3 },
    screenshots: fs.readdirSync(proofDir).filter((f) => f.startsWith('ci-')),
  }, null, 2))
} finally {
  await browser.close()
}