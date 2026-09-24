/**
 * CAMPAIGN COMMAND MOBILE — FULL SURFACE AUDIT CAPTURE.
 *
 * Walks every Campaign mobile surface an operator can reach and photographs it,
 * so design decisions are made from what actually renders:
 *
 *   index · builder BUILD / category sheet / REACH / LAUNCH · detail hero ·
 *   detail scrolled · section switcher sheet · each section · action overflow
 *
 * SAFETY. The local dev API writes to the PRODUCTION database. Reaching LAUNCH
 * with a non-empty campaign name auto-creates a draft campaign and builds its
 * target snapshots. This script therefore NEVER types a campaign name. REACH
 * runs a read-only count preview, which is safe.
 *
 * Inner scrollers: detail content scrolls inside `.ccc__detail-body`, not the
 * window, so `window.scrollTo` is a no-op there. Scrolling targets the largest
 * scrollable element on screen instead.
 *
 *   node scripts/proof/mobile/campaign-surface-audit.mjs --width 390 --theme dark --tag before
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const BASE = arg('base', 'http://localhost:5173')
const WIDTH = Number(arg('width', '390'))
const HEIGHT = Number(arg('height', '844'))
const THEME = arg('theme', 'dark')
const TAG = arg('tag', 'audit')
const ONLY = arg('only', '')
const OUT = path.resolve(process.cwd(), `.screenshots/campaign-audit/${TAG}-${WIDTH}-${THEME}`)

const setTheme = (t) => {
  try {
    const raw = localStorage.getItem('nexus-settings')
    const parsed = raw ? JSON.parse(raw) : {}
    localStorage.setItem('nexus-settings', JSON.stringify({ ...parsed, nexusTheme: t }))
  } catch { /* first run */ }
}

const log = (...a) => console.log('  ', ...a)
const wants = (k) => !ONLY || ONLY.split(',').includes(k)

let n = 0
const shot = async (page, name) => {
  n += 1
  const file = path.join(OUT, `${String(n).padStart(2, '0')}-${name}.png`)
  await page.screenshot({ path: file })
  log(`captured ${path.basename(file)}`)
}

/** Scroll the largest scrollable element (or the window) to a fraction of its range. */
const scrollMain = async (page, fraction) => page.evaluate((f) => {
  const els = [...document.querySelectorAll('*')].filter((e) => {
    const cs = getComputedStyle(e)
    return ['auto', 'scroll'].includes(cs.overflowY) && e.scrollHeight > e.clientHeight + 40
  }).sort((a, b) => (b.clientHeight * b.clientWidth) - (a.clientHeight * a.clientWidth))
  const el = els[0]
  if (el) { el.scrollTop = (el.scrollHeight - el.clientHeight) * f; return String(el.className).slice(0, 50) }
  window.scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * f)
  return 'window'
}, fraction)

/** Text of what is actually visible, so the log records what each shot contains. */
const visibleSummary = async (page) => page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160))

const tapText = async (page, re, { scope = 'button, [role="button"], a, [role="tab"], [role="menuitem"], li' } = {}) => {
  const loc = page.locator(scope).filter({ hasText: re }).first()
  if (!(await loc.count())) return false
  await loc.click({ timeout: 8000 }).catch(() => {})
  return true
}

const run = async () => {
  await fs.mkdir(OUT, { recursive: true })
  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  })
  await context.addInitScript(setTheme, THEME)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))

  console.log(`\n── campaign surface audit ${WIDTH}x${HEIGHT} / ${THEME} → ${OUT}`)
  await page.goto(`${BASE}/campaign-command`, { waitUntil: 'domcontentloaded', timeout: 180_000 })
  await page.waitForSelector('.cmc__hit', { timeout: 120_000 }).catch(() => log('no campaign cards'))
  await page.waitForTimeout(2200)

  // ── INDEX ───────────────────────────────────────────────────────────────
  if (wants('index')) {
    await shot(page, 'index-top')
    await scrollMain(page, 0.35); await page.waitForTimeout(600)
    await shot(page, 'index-mid')
    await scrollMain(page, 0); await page.waitForTimeout(400)
  }

  // ── BUILDER ─────────────────────────────────────────────────────────────
  if (wants('builder')) {
    const newBtn = page.locator('button[aria-label="New campaign"]').first()
    if (await newBtn.count()) {
      await newBtn.click().catch(() => {})
      await page.waitForTimeout(3500)
      log('builder:', await visibleSummary(page))
      await shot(page, 'build-top')
      await scrollMain(page, 1); await page.waitForTimeout(600)
      await shot(page, 'build-bottom')
      await scrollMain(page, 0); await page.waitForTimeout(400)

      // A targeting category opens its field sheet.
      const cat = page.locator('.cbx__cat').first()
      if (await cat.count()) {
        const label = (await cat.textContent())?.trim().slice(0, 24)
        await cat.click().catch(() => {})
        await page.waitForTimeout(1800)
        log('category sheet for:', label)
        await shot(page, 'build-category-sheet')
        await scrollMain(page, 1); await page.waitForTimeout(500)
        await shot(page, 'build-category-sheet-bottom')
        // close the sheet
        const closed = await tapText(page, /^(Done|Close|Back|Cancel)$/i)
          || (await page.locator('[aria-label*="lose"], [aria-label*="ack"]').first().click().then(() => true).catch(() => false))
        log('sheet closed:', closed)
        await page.waitForTimeout(1200)
      }

      // REACH — read-only preview.
      const stages = page.locator('.csr__stage')
      log('stage buttons:', await stages.count())
      if (await stages.count() >= 2 && (await stages.nth(1).click({ timeout: 8000 }).then(() => true).catch(() => false))) {
        await page.waitForTimeout(9000) // preview costs seconds
        log('reach:', await visibleSummary(page))
        await shot(page, 'reach-top')
        await scrollMain(page, 0.5); await page.waitForTimeout(500)
        await shot(page, 'reach-mid')
        await scrollMain(page, 1); await page.waitForTimeout(500)
        await shot(page, 'reach-bottom')
        await scrollMain(page, 0); await page.waitForTimeout(400)
      }

      // LAUNCH — unnamed, so nothing persists.
      if (await stages.count() >= 3 && (await stages.nth(2).click({ timeout: 8000 }).then(() => true).catch(() => false))) {
        await page.waitForTimeout(3000)
        log('launch:', await visibleSummary(page))
        await shot(page, 'launch-top')
        await scrollMain(page, 1); await page.waitForTimeout(500)
        await shot(page, 'launch-bottom')
      }

      // Close the builder.
      const close = page.locator('.cmp-studio [aria-label*="lose"], .cmp-studio [aria-label*="ancel"], .cmp-studio-mobile-close, .cbm__close').first()
      if (await close.count()) await close.click().catch(() => {})
      else await page.keyboard.press('Escape').catch(() => {})
      await page.waitForTimeout(1500)
    } else log('no New campaign button')
  }

  // ── DETAIL ──────────────────────────────────────────────────────────────
  if (wants('detail')) {
    await page.goto(`${BASE}/campaign-command`, { waitUntil: 'domcontentloaded', timeout: 180_000 })
    await page.waitForSelector('.cmc__hit', { timeout: 120_000 })
    await page.waitForTimeout(1500)

    // Prefer a campaign that has actually sent, so sections have content.
    const pick = arg('campaign', '')
    const card = pick
      ? page.locator('.cmc__hit').filter({ hasText: new RegExp(pick, 'i') }).first()
      : page.locator('.cmc__hit').first()
    const name = (await card.locator('.cmc__name').textContent().catch(() => ''))?.trim()
    await card.click().catch(() => {})
    await page.waitForTimeout(3500)
    log('detail for:', name)
    await shot(page, 'detail-top')
    await scrollMain(page, 0.33); await page.waitForTimeout(500)
    await shot(page, 'detail-33')
    await scrollMain(page, 0.66); await page.waitForTimeout(500)
    await shot(page, 'detail-66')
    await scrollMain(page, 1); await page.waitForTimeout(500)
    await shot(page, 'detail-bottom')
    await scrollMain(page, 0); await page.waitForTimeout(400)

    // Section switcher.
    const switcher = page.locator('.ccc__detail-tabs--mobile button, .occ-liquid-filter__trigger').first()
    if (await switcher.count()) {
      await switcher.click().catch(() => {})
      await page.waitForTimeout(1400)
      await shot(page, 'section-switcher')
      const options = await page.locator('[role="option"], [role="menuitem"], .occ-liquid-filter__option').allTextContents().catch(() => [])
      log('sections:', options.map((o) => o.trim()).filter(Boolean).join(' | '))
      await page.keyboard.press('Escape').catch(() => {})
      await page.waitForTimeout(600)

      for (const label of options.map((o) => o.trim()).filter(Boolean).slice(0, 8)) {
        await switcher.click().catch(() => {})
        await page.waitForTimeout(900)
        const opt = page.locator('[role="option"], [role="menuitem"], .occ-liquid-filter__option').filter({ hasText: label }).first()
        if (!(await opt.count())) continue
        await opt.click().catch(() => {})
        await page.waitForTimeout(2200)
        const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20)
        await shot(page, `section-${slug}`)
        await scrollMain(page, 1); await page.waitForTimeout(500)
        await shot(page, `section-${slug}-bottom`)
        await scrollMain(page, 0); await page.waitForTimeout(300)
      }
    } else log('no section switcher found')

    // Overflow / more actions in the sticky bar.
    const more = page.locator('.ccc-mobile-action-dock button, .cma-dock button, [class*="action-dock"] button').filter({ hasText: /^(…|···|\.\.\.)$/ }).first()
    const moreAlt = page.locator('button[aria-label*="ore action"], button[aria-label*="More"]').first()
    const target = (await more.count()) ? more : moreAlt
    if (await target.count()) {
      await target.click().catch(() => {})
      await page.waitForTimeout(1200)
      await shot(page, 'detail-more-actions')
      await page.keyboard.press('Escape').catch(() => {})
    } else log('no overflow action button found')
  }

  if (errors.length) { console.log('\npage errors:'); errors.forEach((e) => log(e)) }
  await browser.close()
  console.log(`\ndone → ${OUT}\n`)
}

run().catch((e) => { console.error(e); process.exit(1) })
