import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * QUEUE SECTIONS (Events · Failures · Markets · Senders · Templates) — capture.
 *
 * READ ONLY: every non-GET API call is aborted. Reaches each section through
 * the view rail (`[data-queue-view]`) or, on the pre-redesign build, through
 * the views sheet; opens the first row's detail sheet.
 *
 *   node scripts/proof/mobile/queue-sections-capture.mjs --label=before --width=393 --theme=dark
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const LABEL = arg('label', 'after')
const SIZES = { 375: 812, 390: 844, 393: 852, 430: 932 }
const WIDTHS = arg('width', '375,390,393,430').split(',').map(Number)
const THEMES = arg('theme', 'dark,light,true_black,red_ops').split(',')
const SECTIONS = arg('sections', 'events,failures,market,senders,templates').split(',')
const OUT = path.resolve(arg('out', `artifacts/queue-sections/${LABEL}`))
await fs.mkdir(OUT, { recursive: true })

const LABELS = { events: 'Events', failures: 'Failures', market: 'Markets', senders: 'Senders', templates: 'Templates' }
const ROW = '[data-section-row], .qm-evtrow, .qm-failrow, .qm-fleetrow, .qm-tplrow'
const SHEET = '.qx-sheet, .qm-fail-sheet, .qm-fleet-sheet, .qm-tpl-sheet, .qms-sheet, .nx-bottom-sheet'

const settle = (page) => page.evaluate(async () => {
  const deadline = Date.now() + 25000
  let last = '', since = Date.now()
  while (Date.now() < deadline) {
    const n = document.querySelectorAll('[data-section-row], .qm-evtrow, .qm-failrow, .qm-fleetrow, .qm-tplrow, .qx-card').length
    const busy = document.querySelectorAll('.qx-skel, .is-busy').length
    const key = `${n}:${busy}:${document.body.scrollHeight}`
    if (key !== last) { last = key; since = Date.now() }
    else if (Date.now() - since > 1600 && !busy) return key
    await new Promise((r) => setTimeout(r, 150))
  }
  return last
})

const results = []
const browser = await chromium.launch()
for (const width of WIDTHS) {
  for (const theme of THEMES) {
    const cell = `${width}-${theme}`
    const ctx = await browser.newContext({ viewport: { width, height: SIZES[width] ?? 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
    await ctx.addInitScript((t) => {
      try {
        const cur = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
        localStorage.setItem('nexus-settings', JSON.stringify({ ...cur, nexusTheme: t }))
      } catch {}
    }, theme)
    const page = await ctx.newPage()
    let writes = 0
    await page.route('**/api/**', (r) => (['GET', 'OPTIONS'].includes(r.request().method()) ? r.continue() : (writes++, r.abort())))
    const errs = []; page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 120)))
    const done = []; const missed = []
    await page.goto(`${BASE}/queue`, { waitUntil: 'domcontentloaded', timeout: 180000 })
    await page.addStyleTag({ content: ':root{--nx-mobile-safe-bottom:34px !important}' })
    await page.waitForSelector('[data-queue-segment], .qm-row, .qm-empty', { timeout: 120000 }).catch(() => {})
    await settle(page)

    for (const key of SECTIONS) {
      try {
        const rail = page.locator(`[data-queue-view="${key}"]`)
        if (await rail.count()) await rail.first().tap()
        else {
          await page.locator('[data-queue-views]').first().tap()
          await page.locator('.qx-view').filter({ hasText: LABELS[key] }).first().tap()
        }
        await page.waitForTimeout(500); await settle(page)
        await page.screenshot({ path: `${OUT}/${cell}-${key}.png` }); done.push(key)
        const row = page.locator(ROW).first()
        if (await row.count()) {
          await row.tap()
          await page.waitForSelector(SHEET, { timeout: 12000 })
          await page.waitForTimeout(900)
          await page.screenshot({ path: `${OUT}/${cell}-${key}-detail.png` }); done.push(`${key}-detail`)
          await page.keyboard.press('Escape').catch(() => {})
          const close = page.locator('.qx-sheet [data-close], .qms-chrome__btn.is-close, [aria-label="Close"]').first()
          if (await close.count()) await close.tap().catch(() => {})
          await page.waitForTimeout(500)
        } else missed.push(`${key}-detail: no row`)
        // return to dispatch so the next section starts from the same place
        const back = page.locator('[data-queue-view="dispatch"], .qm-rail__tab').first()
        if (await back.count()) { await back.tap().catch(() => {}); await page.waitForTimeout(300) }
      } catch (e) { missed.push(`${key}: ${String(e.message).split('\n')[0].slice(0, 90)}`) }
    }
    const geo = await page.evaluate(() => ({ overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth }))
    results.push({ cell, done, missed, writes, errs, geo })
    console.log(cell, 'shots', done.length, 'missed', missed.length ? missed : '-', 'overflowX', geo.overflowX, 'writes', writes, errs.length ? errs : '')
    await ctx.close()
  }
}
await browser.close()
await fs.writeFile(`${OUT}/results.json`, JSON.stringify(results, null, 1))
