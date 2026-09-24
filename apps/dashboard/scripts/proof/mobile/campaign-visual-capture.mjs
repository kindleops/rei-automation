/**
 * CAMPAIGN COMMAND MOBILE — VISUAL CAPTURE.
 *
 * Not a gate. This exists so the screens can actually be LOOKED at: Chrome on
 * macOS will not render an interactive window below ~860 CSS px, and the app
 * picks its mobile branch from a measured pane width, so nothing short of a
 * real narrow viewport shows the real layout.
 *
 * Captures each campaign screen at a given width/theme and writes PNGs. Waits
 * on `:not(.is-skeleton)` rows because the list renders four empty loading
 * skeletons first, and a naive wait photographs those.
 *
 *   node scripts/proof/mobile/campaign-visual-capture.mjs --width 390 --theme dark
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const BASE = arg('base', 'http://localhost:5173')
const WIDTH = Number(arg('width', '390'))
const HEIGHT = Number(arg('height', '844'))
const THEME = arg('theme', 'dark')
const TAG = arg('tag', 'before')
const OUT = path.resolve(process.cwd(), `.screenshots/campaign-visual/${TAG}-${WIDTH}-${THEME}`)

const setTheme = (t) => {
  try {
    const raw = localStorage.getItem('nexus-settings')
    const parsed = raw ? JSON.parse(raw) : {}
    localStorage.setItem('nexus-settings', JSON.stringify({ ...parsed, nexusTheme: t }))
  } catch { /* first run, no settings yet */ }
}

const shot = async (page, name) => {
  const file = path.join(OUT, `${name}.png`)
  await page.screenshot({ path: file, fullPage: false })
  console.log(`  captured ${name}`)
  return file
}

const run = async () => {
  await fs.mkdir(OUT, { recursive: true })
  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  })
  await context.addInitScript(setTheme, THEME)
  const page = await context.newPage()
  page.on('console', (m) => { if (m.type() === 'error') console.log(`  [console.error] ${m.text().slice(0, 160)}`) })

  console.log(`\n── campaign capture ${WIDTH}x${HEIGHT} / ${THEME} → ${OUT}`)
  await page.goto(`${BASE}/campaign-command`, { waitUntil: 'domcontentloaded', timeout: 180_000 })

  // Real rows, not the four aria-hidden skeletons.
  await page.waitForSelector('.cmc__hit', { timeout: 120_000 }).catch(() => {
    console.log('  (no campaign rows matched the expected selector — capturing whatever rendered)')
  })
  await page.waitForTimeout(2500)
  await shot(page, '01-index-top')

  await page.evaluate(() => window.scrollTo(0, 600))
  await page.waitForTimeout(700)
  await shot(page, '02-index-scrolled')

  // Open the first real campaign.
  //
  // Scroll back to the top FIRST. Tapping a row while the list is scrolled
  // leaves the detail mounted at the inherited scroll offset, which photographs
  // as an empty screen and reads exactly like a blank-render bug. It is not one.
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForTimeout(400)
  const row = page.locator('.cmc__hit').first()
  if (await row.count()) {
    await row.click({ timeout: 15_000 }).catch(() => {})
    await page.waitForTimeout(3000)
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.waitForTimeout(500)
    await shot(page, '03-detail-top')
    await page.evaluate(() => window.scrollTo(0, 700))
    await page.waitForTimeout(700)
    await shot(page, '04-detail-scrolled')
    await page.evaluate(() => window.scrollTo(0, 1600))
    await page.waitForTimeout(700)
    await shot(page, '05-detail-lower')
  } else {
    console.log('  no campaign row to open')
  }

  // Whatever tab strip exists on detail.
  const tabs = page.locator('.ccc-detail-tabbar button, .cdm__tab, .cdx__tab')
  const tabCount = await tabs.count()
  console.log(`  detail tabs found: ${tabCount}`)
  for (let i = 1; i < Math.min(tabCount, 6); i += 1) {
    const label = (await tabs.nth(i).textContent().catch(() => '')) || `tab${i}`
    await tabs.nth(i).click({ timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(1800)
    await shot(page, `06-tab-${i}-${label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}`)
  }

  await browser.close()
  console.log(`\ndone → ${OUT}\n`)
}

run().catch((e) => { console.error(e); process.exit(1) })
