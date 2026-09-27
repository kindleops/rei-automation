import { chromium } from 'playwright'
import fs from 'node:fs/promises'
/**
 * Entity Graph console proof: landing → largest network → focus property →
 * inspector → select portfolio → dock → related owner hop → search → list mode.
 * READ ONLY: every non-GET /api call is aborted; the campaign sheet is opened
 * but never submitted.
 */
const OUT = 'artifacts/eg-v2'
await fs.mkdir(OUT, { recursive: true })
const THEME = process.argv.find((a) => a.startsWith('--theme='))?.slice(8) ?? 'dark'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
await ctx.addInitScript((t) => { const cur = JSON.parse(localStorage.getItem('nexus-settings') || '{}'); localStorage.setItem('nexus-settings', JSON.stringify({ ...cur, nexusTheme: t })) }, THEME)
const page = await ctx.newPage()
const blocked = []
await page.route('**/api/**', (r) => (['GET', 'OPTIONS'].includes(r.request().method()) ? r.continue() : (blocked.push(r.request().method() + ' ' + new URL(r.request().url()).pathname), r.abort())))
const errs = []; page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)))
const R = {}
const shot = (n) => page.screenshot({ path: `${OUT}/${THEME}-${n}.png` })
await page.goto('http://localhost:5173/entity-graph', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.egx-net', { timeout: 60000 }).catch(() => {})
await page.waitForTimeout(1200)
R.landingNets = await page.locator('.egx-net').count()
await shot('1-landing')

// Largest network
await page.locator('.egx-net').first().tap()
await page.waitForSelector('.egx-node.is-hub', { timeout: 30000 })
await page.waitForTimeout(2200)
R.nodes = await page.locator('.egx-node').count()
R.edges = await page.locator('.egx-edge').count()
R.types = await page.locator('.egx-node').evaluateAll((els) => els.reduce((m, e) => { const t = e.getAttribute('data-egx-type'); m[t] = (m[t] || 0) + 1; return m }, {}))
await shot('2-network')

// Expand the cluster
if (await page.locator('.egx-node.is-cluster').count()) {
  await page.locator('.egx-node.is-cluster').dispatchEvent('pointerdown'); await page.locator('.egx-node.is-cluster').dispatchEvent('pointerup')
  await page.waitForTimeout(1800)
  R.expandedNodes = await page.locator('.egx-node').count()
  await shot('3-expanded')
}

// Inspector: drag up by tapping the sheet handle area → use snap via scrolling isn't reliable; tap a property node.
const pt = await page.evaluate(() => {
  const sheetTop = document.querySelector('.egx-sheet')?.getBoundingClientRect().top ?? 600
  for (const el of document.querySelectorAll('.egx-node.is-property:not(.is-cluster)')) {
    const r = el.getBoundingClientRect()
    if (r.top > 200 && r.bottom < sheetTop - 6 && r.left > 10 && r.right < 330) return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }
  return null
})
R.propPoint = pt
if (pt) await page.touchscreen.tap(pt.x, pt.y)
await page.waitForTimeout(1400)
R.focusSheet = await page.locator('.egx-insp.is-property').count()
await shot('4-focus-property')

// Back to the network summary (tap empty stage), select all portfolio from the sheet.
await page.locator('[aria-label="Fit the network"]').tap()
await page.waitForTimeout(900)
await page.locator('.egx-sheet .nx-mobile-bottom-sheet__handle').click()
await page.waitForTimeout(700)
R.summaryShown = await page.locator('.egx-insp.is-network').count()
const selAll = page.locator('.egx-sec .egx-link', { hasText: 'Select all' }).first()
if (await selAll.count()) { await selAll.tap(); await page.waitForTimeout(800) }
R.dock = await page.locator('.egx-dock').textContent().catch(() => null)
await shot('5-selected')
await page.locator('[data-egx-action="campaign"]').tap().catch(() => {})
await page.waitForTimeout(1500)
R.campaignSheet = await page.locator('.egc-mode__count, [class*="egc-"]').count()
await shot('6-campaign-sheet')
await page.keyboard.press('Escape').catch(() => {})
await page.goBack().catch(() => {})

// Related owner hop on a household network
await page.goto('http://localhost:5173/entity-graph/owner/mo_1e70bcee1e5f0e3c8f2764b4', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.egx-node.is-hub', { timeout: 60000 }).catch(() => {})
await page.waitForTimeout(2400)
R.hhTypes = await page.locator('.egx-node').evaluateAll((els) => els.reduce((m, e) => { const t = e.getAttribute('data-egx-type'); m[t] = (m[t] || 0) + 1; return m }, {}))
await shot('7-llc-network')

// Property arrival with a conversation
await page.goto('http://localhost:5173/entity-graph/property/278470735', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.egx-node.is-hub', { timeout: 60000 }).catch(() => {})
await page.waitForTimeout(2600)
R.propTypes = await page.locator('.egx-node').evaluateAll((els) => els.map((e) => e.getAttribute('data-egx-type')))
await shot('8-property-arrival')

// Search
await page.locator('.egx-top-bar [aria-label="Search"]').tap()
await page.locator('.egx-search__field input').fill('trust')
await page.waitForSelector('.egx-result', { timeout: 20000 }).catch(() => {})
await page.waitForTimeout(800)
R.results = await page.locator('.egx-result').count()
await shot('9-search')

console.log(JSON.stringify({ R, blocked, errs }, null, 1))
await browser.close()
