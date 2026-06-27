import { chromium } from 'playwright'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const proofDir = path.join(root, 'proof/shell-review')
fs.mkdirSync(proofDir, { recursive: true })

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5175'
const PROPERTY_ID = '238384554'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1512, height: 900 } })

try {
  await page.goto(`${BASE}/comp-intelligence?property_id=${PROPERTY_ID}`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => {
    document.querySelector('[data-testid="dev-runtime-banner"]')?.remove()
  }).catch(() => {})
  const workspace = page.locator('[data-comp-intelligence="true"]')
  await workspace.waitFor({ state: 'visible', timeout: 60000 })
  await workspace.locator('.ci-subject-header--hero').waitFor({ state: 'visible', timeout: 60000 })
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-comp-intelligence="true"]')
    return Number(el?.getAttribute('data-evidence-count') || '0') > 0
  }, null, { timeout: 90000 })
  await page.locator('.ci-evidence-card').first().waitFor({ state: 'visible', timeout: 60000 })
  await page.waitForTimeout(1500)
  await page.evaluate(() => {
    document.querySelector('.ci-panel')?.scrollTo({ top: 0 })
    document.querySelector('.ci-workspace')?.scrollTo?.({ top: 0 })
  })
  await page.waitForTimeout(400)

  const measurements = await page.evaluate(() => {
    const ws = document.querySelector('[data-comp-intelligence="true"]')
    const map = document.querySelector('.ci-workspace__map-col')
    const panel = document.querySelector('.ci-panel')
    const parent = ws?.parentElement
    const wsRect = ws?.getBoundingClientRect()
    const parentRect = parent?.getBoundingClientRect()
    const mapRect = map?.getBoundingClientRect()
    const panelRect = panel?.getBoundingClientRect()
    const unusedRight = parentRect && wsRect ? Math.max(0, Math.round(parentRect.right - wsRect.right)) : null
    return {
      viewportWidth: window.innerWidth,
      parentWidth: parentRect ? Math.round(parentRect.width) : null,
      workspaceWidth: wsRect ? Math.round(wsRect.width) : null,
      mapWidth: mapRect ? Math.round(mapRect.width) : null,
      panelWidth: panelRect ? Math.round(panelRect.width) : null,
      unusedRightPixels: unusedRight,
      evidenceCount: ws?.getAttribute('data-evidence-count'),
    }
  })

  await page.screenshot({ path: path.join(proofDir, 'stage1-full-workspace.png'), fullPage: false })
  await page.locator('.ci-panel').screenshot({ path: path.join(proofDir, 'stage1-right-panel.png') })

  const cards = page.locator('.ci-evidence-card')
  const count = await cards.count()
  if (count >= 1) await cards.nth(0).screenshot({ path: path.join(proofDir, 'stage2-comp-card-1.png') })
  if (count >= 2) await cards.nth(1).screenshot({ path: path.join(proofDir, 'stage2-comp-card-2.png') })

  if (count >= 1) {
    await cards.nth(0).click()
    await page.waitForTimeout(800)
    await page.screenshot({ path: path.join(proofDir, 'stage2-comparison-expanded.png'), fullPage: false })
    const pin = page.locator('.ci-comp-pin').first()
    if (await pin.isVisible().catch(() => false)) {
      await pin.click({ force: true })
      await page.waitForTimeout(500)
      await page.screenshot({ path: path.join(proofDir, 'stage2-map-preview.png'), fullPage: false })
    }
  }

  await page.locator('.ci-subject-header--hero').screenshot({ path: path.join(proofDir, 'stage1-subject-hero.png') })

  console.log(JSON.stringify({ ok: true, propertyId: PROPERTY_ID, measurements, screenshots: fs.readdirSync(proofDir) }, null, 2))
} finally {
  await browser.close()
}