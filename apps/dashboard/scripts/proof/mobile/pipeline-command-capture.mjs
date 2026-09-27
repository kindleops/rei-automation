import { chromium } from 'playwright'
/**
 * Pipeline command center proof — overview, flow, lanes, exceptions, movement,
 * feed, stage drill, deal inspector (story), filter sheet, deep link + back.
 * Read-only: every non-GET /api request is aborted.
 */
const OUT = 'artifacts/pipeline-v2'
const THEME = process.argv.find((a) => a.startsWith('--theme='))?.slice(8) ?? 'dark'
const W = Number(process.argv.find((a) => a.startsWith('--w='))?.slice(4) ?? 390)
const QUICK = process.argv.includes('--quick')
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: W, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
await ctx.addInitScript((t) => { const cur = JSON.parse(localStorage.getItem('nexus-settings') || '{}'); localStorage.setItem('nexus-settings', JSON.stringify({ ...cur, nexusTheme: t })) }, THEME)
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
await page.route('**/api/**', (r) => (['GET', 'OPTIONS'].includes(r.request().method()) ? r.continue() : r.abort()))
const shot = async (name) => { await page.screenshot({ path: `${OUT}/${THEME}-${W}-${name}.png` }); console.log('shot', name) }
const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
const scroller = page.locator('.plc__scroll')

await page.goto('http://localhost:5173/pipeline', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.plc-card:not(.is-ghost)', { timeout: 90000 }).catch(() => {})
await page.waitForTimeout(3500)
await shot('01-overview')
const R = { overflow: await overflow(), cards: await page.locator('.plc-card:not(.is-ghost)').count(), stages: await page.locator('.plc-col').count(), exceptions: await page.locator('.plc-exception').count(), moves: await page.locator('.plc-move').count() }
await scroller.evaluate((el) => { el.scrollTop = 620 }); await page.waitForTimeout(700); await shot('02-scrolled')
await scroller.evaluate((el) => { el.scrollTop = 1400 }); await page.waitForTimeout(700); await shot('03-feed')
if (!QUICK) {
  await scroller.evaluate((el) => { el.scrollTop = 0 })
  // Stage drill: S5
  await page.locator('.plc-col').nth(4).evaluate((e) => e.click()); await page.waitForTimeout(2600); await shot('04-stage-s5')
  R.s5 = await page.locator('.plc-feedhead__bar').innerText().catch(() => null)
  // Open the first deal
  await page.locator('.plc-card:not(.is-ghost)').first().evaluate((e) => e.click()); await page.waitForTimeout(4500); await shot('05-inspector')
  R.url = page.url()
  const body = page.locator('.pli [class*="scroll"], .pli__body').first()
  if (await body.count()) { await body.evaluate((el) => { el.scrollTop = 700 }); await page.waitForTimeout(700); await shot('06-inspector-scroll'); await body.evaluate((el) => { el.scrollTop = 1600 }); await page.waitForTimeout(700); await shot('07-inspector-scroll-2') }
  await page.keyboard.press('Escape'); await page.waitForTimeout(700)
  R.closedUrl = page.url()
  // Filter sheet
  await page.locator('button[aria-label="Filters"]').evaluate((e) => e.click()); await page.waitForTimeout(900); await shot('08-filters')
  await page.keyboard.press('Escape'); await page.waitForTimeout(500)
  // Deep link straight to a deal
  await page.goto('http://localhost:5173/pipeline?opp=3d5c9437-0be0-4eb5-be60-77a181b769fe', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(8000); await shot('09-deeplink')
  R.deeplinkOpen = await page.locator('.pli').count()
}
await browser.close().catch(() => {})
console.log(JSON.stringify({ ...R, errors: errors.slice(0, 6) }))
