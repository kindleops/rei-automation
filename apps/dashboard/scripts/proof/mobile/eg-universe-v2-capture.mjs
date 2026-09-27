import { chromium } from 'playwright'
/**
 * Entity Graph universe v2 proof — list, composition, All overview, buyers,
 * buyer inspector, filters/presets, property dossier, network with records.
 * Read-only: every non-GET /api request is aborted.
 */
const OUT = 'artifacts/eg-v2'
const THEME = process.argv.find((a) => a.startsWith('--theme='))?.slice(8) ?? 'dark'
const W = Number(process.argv.find((a) => a.startsWith('--w='))?.slice(4) ?? 390)
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: W, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
await ctx.addInitScript((t) => { const cur = JSON.parse(localStorage.getItem('nexus-settings') || '{}'); localStorage.setItem('nexus-settings', JSON.stringify({ ...cur, nexusTheme: t })) }, THEME)
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
await page.route('**/api/**', (r) => (['GET', 'OPTIONS'].includes(r.request().method()) ? r.continue() : r.abort()))
const shot = async (name) => { await page.screenshot({ path: `${OUT}/${THEME}-${W}-${name}.png` }); console.log('shot', name) }
const overflow = async () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)

await page.goto('http://localhost:5173/entity-graph', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.egm-row', { timeout: 60000 }).catch(() => {})
await page.waitForTimeout(6000)
await shot('01-list'); await page.locator('.egm-list').evaluate((el) => { el.scrollTop = 620 }); await page.waitForTimeout(900); await shot('01b-rows'); await page.locator('.egm-list').evaluate((el) => { el.scrollTop = 0 })
const R = { overflowList: await overflow(), rows: await page.locator('.egm-row').count(), chart: await page.locator('.egq__bar, .egq__col').count() }

// Composition: pick Equity
const equity = page.locator('.egq__chip', { hasText: 'Equity' }).first()
if (await equity.count()) { await equity.tap(); await page.waitForTimeout(5000); await shot('02-equity') }
const distress = page.locator('.egq__chip', { hasText: 'Distress signals' }).first()
if (await distress.count()) { await distress.tap(); await page.waitForTimeout(6000); await shot('03-distress') }
// Tap the Probate bar -> filter
const probate = page.locator('.egq__bar', { hasText: 'Probate' }).first()
if (await probate.count()) { await probate.tap(); await page.waitForTimeout(7000); await shot('04-probate-filtered'); R.probateTotal = await page.locator('.egm-toolbar__count').innerText().catch(() => null) }

// All overview
await page.locator('.egm-scope.is-all').first().tap(); await page.waitForTimeout(7000); await shot('05-all')
R.insights = await page.locator('.egu__insight').count()

// Buyers universe
await page.locator('.egm-scope.is-buyers').first().tap(); await page.waitForSelector('.egm-row', { timeout: 30000 }).catch(() => {}); await page.waitForTimeout(5000); await shot('06-buyers')
R.buyerRows = await page.locator('.egm-row').count()
await page.locator('.egm-row').first().tap(); await page.waitForTimeout(6000); await shot('07-buyer-inspector')
const sheetBody = page.locator('.egb [class*="scroll"], .egb__body, .egb__scroll').first()
if (await sheetBody.count()) { await sheetBody.evaluate((el) => { el.scrollTop = 900 }); await page.waitForTimeout(900); await shot('08-buyer-scrolled'); await sheetBody.evaluate((el) => { el.scrollTop = 2200 }); await page.waitForTimeout(900); await shot('09-buyer-scrolled-2') }
await page.keyboard.press('Escape'); await page.waitForTimeout(800)

// Properties + filter sheet
await page.locator('.egm-scope.is-properties').first().tap(); await page.waitForTimeout(4000)
await page.locator('.egm-tool', { hasText: 'Filter' }).first().tap(); await page.waitForTimeout(2500); await shot('10-filters')

await browser.close().catch(() => {})
console.log(JSON.stringify({ ...R, errors: errors.slice(0, 6) }))
