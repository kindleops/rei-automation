import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * QUEUE COMMAND MOBILE — visual capture matrix.
 *
 * READ ONLY. Every non-GET API call is aborted, so no row can be retried,
 * cancelled, approved or rescheduled from a proof run. Supabase realtime and
 * direct REST reads (GET) are untouched.
 *
 * States are reached through what the surface renders: segment tabs
 * (`[data-queue-segment]`, falls back to the legacy stat tiles), the first
 * row card, the filter trigger and the detail sheet.
 *
 *   node scripts/proof/mobile/queue-elite-capture.mjs --label=before
 *   node scripts/proof/mobile/queue-elite-capture.mjs --label=after --width=393 --theme=dark
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const LABEL = arg('label', 'after')
const SIZES = { 375: 812, 390: 844, 393: 852, 430: 932 }
const WIDTHS = arg('width', '375,390,393,430').split(',').map(Number)
const THEMES = arg('theme', 'dark,light,true_black,red_ops').split(',')
const ONLY = arg('states', '') ? new Set(arg('states', '').split(',')) : null
const OUT = path.resolve(arg('out', `artifacts/queue-elite/${LABEL}`))
await fs.mkdir(OUT, { recursive: true })

// segment key → legacy stat label (BEFORE build) for the same bucket
const SEGMENTS = [
  ['ready', /^queued$/i],
  ['scheduled', /scheduled/i],
  ['sending', /^sending$/i],
  ['attention', /^failed$/i],
  ['history', null],
]

const settle = (page) => page.evaluate(async () => {
  const deadline = Date.now() + 25000
  let last = '', since = Date.now()
  while (Date.now() < deadline) {
    const rows = document.querySelectorAll('.qm-row, .qx-card').length
    const busy = document.querySelectorAll('.qx-skel, .qm-head__sync, .is-busy').length
    const key = `${rows}:${busy}:${document.body.scrollHeight}`
    if (key !== last) { last = key; since = Date.now() }
    else if (Date.now() - since > 1500 && !busy) return key
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
    const writes = []
    await page.route('**/api/**', (r) => (['GET', 'OPTIONS'].includes(r.request().method()) ? r.continue() : (writes.push(r.request().method()), r.abort())))
    await page.addStyleTag({ content: '' }).catch(() => {})
    const errs = []; page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 120)))
    const done = []; const missed = []
    const want = (s) => !ONLY || ONLY.has(s)
    const shot = async (state) => { await page.screenshot({ path: `${OUT}/${cell}-${state}.png` }); done.push(state) }
    const step = async (state, fn) => {
      if (!want(state)) return
      try { await fn() } catch (e) { missed.push(`${state}: ${String(e.message).split('\n')[0].slice(0, 90)}`) }
    }
    const safeArea = () => page.addStyleTag({ content: ':root{--nx-mobile-safe-bottom:34px !important}' })

    await page.goto(`${BASE}/queue`, { waitUntil: 'domcontentloaded', timeout: 180000 })
    await safeArea()
    await page.waitForSelector('.qm-row, .qx-card, .qm-empty, .qx-empty', { timeout: 120000 }).catch(() => {})
    await settle(page)

    await step('default', async () => { await shot('default') })

    for (const [key, legacy] of SEGMENTS) {
      await step(key, async () => {
        const seg = page.locator(`[data-queue-segment="${key}"]`)
        if (await seg.count()) await seg.first().tap()
        else if (legacy) {
          const btn = page.locator('.qm-stat, .qm-health__more-btn').filter({ hasText: legacy })
          if (!(await btn.count())) throw new Error('no legacy control')
          await btn.first().tap()
        } else throw new Error('no control')
        await page.waitForTimeout(400); await settle(page)
        await page.evaluate(() => window.scrollTo(0, 0))
        await shot(key)
        // leave legacy filters toggled off again
        if (!(await seg.count()) && legacy) await page.locator('.qm-stat, .qm-health__more-btn').filter({ hasText: legacy }).first().tap().catch(() => {})
        await page.waitForTimeout(300); await settle(page)
      })
    }
    // back to the default segment for the remaining states
    const first = page.locator('[data-queue-segment="attention"]')
    if (await first.count()) { await first.first().tap(); await settle(page) }

    await step('recovered', async () => {
      // a recovered / corrected communication: scheduled first (template corrected), then history
      for (const seg of ['scheduled', 'history']) {
        const t = page.locator(`[data-queue-segment="${seg}"]`)
        if (await t.count()) { await t.first().tap(); await page.waitForTimeout(300); await settle(page) }
        if (await page.locator('.qx-card[data-recovery]').count()) break
      }
      const rec = page.locator('.qx-card[data-recovery]')
      if (!(await rec.count())) throw new Error('no recovered row in range')
      await rec.first().scrollIntoViewIfNeeded(); await shot('recovered')
    })

    await step('detail', async () => {
      const sched = page.locator('[data-queue-segment="scheduled"]')
      if (await sched.count()) { await sched.first().tap(); await page.waitForTimeout(300); await settle(page) }
      const row = page.locator('.qx-card:not(.is-skeleton), .qm-row').first()
      await row.tap()
      await page.waitForSelector('.qms-sheet, .qx-sheet', { timeout: 10000 })
      await page.waitForTimeout(700)
      await shot('detail')
      const sheet = page.locator('.qx-sheet__scroll, .qms-sheet .nx-bottom-sheet__body, .qms-sheet [data-sheet-scroll]').first()
      if (await sheet.count()) {
        await sheet.evaluate((n) => { n.scrollTop = n.scrollHeight })
        await page.waitForTimeout(400)
        await shot('actions')
      }
      await page.keyboard.press('Escape').catch(() => {})
      const close = page.locator('.qx-sheet [data-close], .qms-chrome__btn.is-close').first()
      if (await close.count()) await close.tap().catch(() => {})
      await page.waitForTimeout(500)
    })

    await step('filters', async () => {
      const trig = page.locator('[data-queue-filters], .qm-bar__filters').first()
      await trig.tap()
      await page.waitForSelector('.qm-filter-sheet, .qx-filter-sheet', { timeout: 10000 })
      await page.waitForTimeout(600)
      await shot('filters')
      const close = page.locator('.qx-filter-sheet [data-close], .qm-filter-sheet .qms-chrome__btn.is-close').first()
      if (await close.count()) await close.tap().catch(() => {})
      await page.waitForTimeout(400)
    })

    await step('search', async () => {
      const input = page.locator('[data-queue-search] input, .qx-search input').first()
      if (!(await input.count())) throw new Error('no inline search')
      await input.tap(); await input.fill('a'); await page.waitForTimeout(700); await settle(page)
      await shot('search'); await input.fill(''); await page.waitForTimeout(400)
    })

    // geometry: horizontal overflow and dock clearance of the last row
    const geo = await page.evaluate(() => {
      const doc = document.documentElement
      const cards = [...document.querySelectorAll('.qx-card, .qm-row')]
      const small = [...document.querySelectorAll('.qx-root button, .qx-root [role="tab"], .occ-root button')]
        .filter((b) => b.offsetParent)
        .map((b) => { const r = b.getBoundingClientRect(); const a = getComputedStyle(b, '::after'); return { h: r.height, w: r.width, pseudo: a.content !== 'none' && a.position === 'absolute', t: (b.textContent || b.getAttribute('aria-label') || '').trim().slice(0, 18) } })
        .filter((b) => (b.h < 44 || b.w < 44) && !b.pseudo)
      return { overflowX: doc.scrollWidth - doc.clientWidth, cards: cards.length, smallTargets: small.slice(0, 8) }
    })
    results.push({ cell, done, missed, writes: writes.length, errs, geo })
    console.log(cell, 'shots', done.length, 'missed', missed.length ? missed : '-', 'overflowX', geo.overflowX, 'cards', geo.cards, 'small', geo.smallTargets.length, errs.length ? errs : '')
    await ctx.close()
  }
}
await browser.close()
await fs.writeFile(`${OUT}/results.json`, JSON.stringify(results, null, 1))
