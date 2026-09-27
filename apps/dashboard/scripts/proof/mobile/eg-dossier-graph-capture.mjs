import { chromium } from 'playwright'
/** Property dossier + network-with-records proof. Read-only (non-GET /api aborted). */
const OUT = 'artifacts/eg-v2'
const THEME = process.argv.find((a) => a.startsWith('--theme='))?.slice(8) ?? 'dark'
const PID = process.argv.find((a) => a.startsWith('--pid='))?.slice(6) ?? '273427495'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
await ctx.addInitScript((t) => { const cur = JSON.parse(localStorage.getItem('nexus-settings') || '{}'); localStorage.setItem('nexus-settings', JSON.stringify({ ...cur, nexusTheme: t })) }, THEME)
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
await page.route('**/api/**', (r) => (['GET', 'OPTIONS'].includes(r.request().method()) ? r.continue() : r.abort()))
const shot = async (name) => { await page.screenshot({ path: `${OUT}/${THEME}-${name}.png` }); console.log('shot', name) }

// Graph for the property (arrival with a subject opens the network)
await page.goto(`http://localhost:5173/entity-graph/property/${PID}`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.egx-node', { timeout: 60000 }).catch(() => {})
await page.waitForTimeout(6000)
await shot('20-graph')
const R = { nodeTypes: await page.evaluate(() => [...new Set([...document.querySelectorAll('.egx-node')].map((n) => [...n.classList].find((c) => c.startsWith('is-') && !['is-on', 'is-dim', 'is-focus', 'is-anchor', 'is-lit'].includes(c))))]) }
// focus a sale node and a buyer node
const sale = page.locator('.egx-node.is-sale').first()
if (await sale.count()) { await sale.evaluate((e) => e.click()); await page.waitForTimeout(2200); await shot('21-graph-sale') }
const buyer = page.locator('.egx-node.is-buyer').first()
if (await buyer.count()) { await buyer.evaluate((e) => e.click()); await page.waitForTimeout(2200); await shot('22-graph-buyer') }
const mort = page.locator('.egx-node.is-mortgage').first()
if (await mort.count()) { await mort.evaluate((e) => e.click()); await page.waitForTimeout(2200); await shot('23-graph-mortgage') }

// Back to the universe -> open the property's dossier from the list via search
await page.locator('[aria-label^="Back"], [aria-label="All networks"]').first().evaluate((e) => e.click()).catch(() => {})
R.backToUniverse = await page.waitForSelector('.egm-row', { timeout: 20000 }).then(() => true).catch(() => false)
if (!R.backToUniverse) { await page.goto('http://localhost:5173/entity-graph', { waitUntil: 'domcontentloaded' }); await page.waitForSelector('.egm-row', { timeout: 60000 }).catch(() => {}) }
await page.waitForTimeout(3000)
await shot('24-back-to-universe')
await page.locator('.egm-search input').fill(PID)
await page.waitForTimeout(4000)
await page.locator('.egm-row').first().tap()
await page.waitForTimeout(7000)
await shot('30-dossier')
const body = page.locator('.egm-sheet .nx-mobile-sheet__body, .egd').first()
for (const [i, y] of [[1, 700], [2, 1500], [3, 2400], [4, 3400]]) {
  await page.evaluate((top) => { const el = [...document.querySelectorAll('.nx-mobile-sheet__body, .egd, [class*="sheet__body"]')].find((e) => e.scrollHeight > e.clientHeight + 40); if (el) el.scrollTop = top }, y)
  await page.waitForTimeout(900)
  await shot(`3${i}-dossier-scroll`)
}
R.dossierSections = await page.evaluate(() => [...document.querySelectorAll('.egd h3, .egd [class*="section__title"], .egd h4')].map((h) => h.textContent?.trim()).filter(Boolean).slice(0, 20))
await browser.close().catch(() => {})
console.log(JSON.stringify({ ...R, errors: errors.slice(0, 6) }))
