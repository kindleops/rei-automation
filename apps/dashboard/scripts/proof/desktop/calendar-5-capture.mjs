import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * CALENDAR 5.0 — desktop capture (READ ONLY). Every non-GET to /api or
 * Supabase is aborted and counted; nothing here clicks Create, Reschedule,
 * Cancel, Activate or Send.
 *
 *   real     the live production read through the local API (/calendar)
 *   fixture  the capture fixture (apps/api/scripts/gen-calendar-demo.mjs —
 *            scenario rows run through the REAL read model) served for the
 *            calendar route only, with the browser clock fixed to the
 *            fixture's "now": the states production does not hold today
 *            (a live window with queued sends, a running workflow timer,
 *            closings, a message you scheduled). Named fixture-*.
 *
 *   node scripts/proof/desktop/calendar-5-capture.mjs --phase=real --themes=dark,light --size=1440x900 --out=/abs/dir
 *   node scripts/proof/desktop/calendar-5-capture.mjs --phase=fixture --fixture=/abs/fixture.json --out=/abs/dir
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/calendar-5'))
const PHASE = arg('phase', 'real')
const THEMES = arg('themes', 'dark').split(',')
const SIZES = arg('size', '1440x900').split(',').map((s) => s.split('x').map(Number))
const ONLY = arg('only', '')
const FIXTURE = arg('fixture', '')
const QUICK = process.argv.includes('--quick')
const VIEWS = arg('views', 'timeline,week,month,attention').split(',').filter(Boolean)
const TZ = 'America/Chicago'
await fs.mkdir(OUT, { recursive: true })
const fixture = PHASE === 'fixture' ? JSON.parse(await fs.readFile(FIXTURE, 'utf8')) : null

const watchdog = setTimeout(() => { console.log('WATCHDOG — capture exceeded 24 minutes'); process.exit(2) }, 24 * 60_000)
const browser = await chromium.launch()
const blocked = []
const results = []

async function newPage(theme, [w, h]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, timezoneId: TZ })
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
      localStorage.removeItem('nexus.desktop.split')
      localStorage.removeItem('lc.workspace.session.v1')
      const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
      localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
    } catch { /* ignore */ }
  }, theme)
  await ctx.route('**/*', (route) => {
    const req = route.request()
    const u = new URL(req.url())
    if ((u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method())) {
      blocked.push(`${req.method()} ${u.pathname}`)
      return route.abort()
    }
    if (fixture && u.pathname === '/api/cockpit/calendar/timeline') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: fixture }) })
    }
    return route.continue()
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 220)))
  page.on('console', (m) => { if (m.type() === 'error' && /calendar|tcc|Temporal/i.test(m.text())) errors.push(m.text().slice(0, 220)) })
  if (fixture) await page.clock.setFixedTime(new Date(fixture.range.now))
  return { ctx, page, errors }
}

async function ready(page) {
  await page.waitForSelector('.tcc', { timeout: 120_000 })
  await page.waitForFunction(() => {
    const stage = document.querySelector('.tcc-stage')
    return stage && stage.getAttribute('aria-busy') === 'false'
  }, null, { timeout: Number(arg('wait', '240000')) })
  await page.waitForTimeout(1400)
}

const shot = async (page, name) => {
  if (ONLY && !name.includes(ONLY)) return
  const file = path.join(OUT, `${name}.png`)
  await page.screenshot({ path: file })
  results.push(file)
}

function measure() {
  const root = document.querySelector('.tcc')
  if (!root) return { missing: true }
  const r = root.getBoundingClientRect()
  const over = [...root.querySelectorAll('.tcc-band__name, .tcc-mark__label, .tcc-sum__what, .tcc-brief__line, .tcc-attn__what b')].filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow !== 'ellipsis').length
  const outside = [...root.querySelectorAll('.tcc-band, .tcc-mark, .tcc-cluster')].filter((el) => { const b = el.getBoundingClientRect(); return b.right > r.right + 2 || b.left < r.left - 2 }).length
  return {
    width: Math.round(r.width),
    lanes: [...root.querySelectorAll('.tcc-lane')].map((l) => l.getAttribute('data-lane')),
    bands: root.querySelectorAll('.tcc-band').length,
    marks: root.querySelectorAll('.tcc-mark').length,
    clusters: root.querySelectorAll('.tcc-cluster').length,
    summary: [...root.querySelectorAll('.tcc-sum__seg')].map((s) => s.textContent?.replace(/\s+/g, ' ').trim()),
    headline: root.querySelector('.tcc-brief__head h2')?.textContent,
    overflowText: over,
    outside,
    svg: [...root.querySelectorAll('.tcc-scrub__density, .tcc-load__svg')].map((el) => {
      const cs = getComputedStyle(el)
      const rules = []
      if (el.getBoundingClientRect().width < 100) {
        for (const sh of document.styleSheets) { let rs = []; try { rs = [...sh.cssRules] } catch { continue } for (const r of rs) { try { if (r.selectorText && el.matches(r.selectorText) && /width/.test(r.cssText)) rules.push(r.cssText.slice(0, 160)) } catch { /* ignore */ } } }
      }
      return { cls: el.getAttribute('class'), w: Math.round(el.getBoundingClientRect().width), cssW: cs.width, rules: rules.slice(0, 4) }
    }),
  }
}

for (const theme of THEMES) {
  for (const size of SIZES) {
    const tag = `${PHASE === 'fixture' ? 'fixture-' : ''}${theme}-${size[0]}`
    const { ctx, page, errors } = await newPage(theme, size)
    const t0 = Date.now()
    await page.goto(`${BASE}/calendar`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await ready(page)
    const loadMs = Date.now() - t0
    await shot(page, `${tag}-today`)
    const today = await page.evaluate(measure)

    // event detail: the first band (a campaign window) or the first mark
    const first = page.locator('.tcc-band, .tcc-mark, .tcc-dayfact').first()
    if (await first.count()) {
      await first.click()
      await page.waitForTimeout(700)
      await shot(page, `${tag}-detail`)
      await page.keyboard.press('Escape')
      await page.waitForTimeout(400)
    }
    if (PHASE === 'fixture') {
      // the message YOU scheduled: the authority section (never pressed)
      const mine = page.locator('.tcc-mark.is-movable').first()
      if (await mine.count()) { await mine.click(); await page.waitForTimeout(700); await shot(page, `${tag}-detail-yours`); await page.keyboard.press('Escape'); await page.waitForTimeout(300) }
      const cluster = page.locator('.tcc-cluster').first()
      if (await cluster.count()) { await cluster.click(); await page.waitForTimeout(500); await shot(page, `${tag}-cluster`); await page.keyboard.press('Escape'); await page.waitForTimeout(300) }
    }
    if (QUICK) { results.push({ tag, loadMs, today, errors: errors.slice(0, 6) }); await ctx.close(); continue }
    // scrubbing: pointer down and drag across the ribbon (preview, not yet resolved)
    const track = page.locator('.tcc-scrub__track')
    if (await track.count()) {
      const b = await track.boundingBox()
      if (b) {
        await page.mouse.move(b.x + b.width * 0.45, b.y + b.height / 2)
        await page.mouse.down()
        await page.mouse.move(b.x + b.width * 0.62, b.y + b.height / 2, { steps: 8 })
        await page.waitForTimeout(300)
        await shot(page, `${tag}-scrubbing`)
        await page.mouse.move(b.x + b.width * 0.45, b.y + b.height / 2, { steps: 6 })
        await page.mouse.up()
        await page.waitForTimeout(500)
      }
    }
    // filters plane
    const filt = page.locator('.tcc-strip__bar button', { hasText: 'Filters' }).first()
    if (await filt.count()) { await filt.click(); await page.waitForTimeout(600); await shot(page, `${tag}-filters`); await page.keyboard.press('Escape'); await page.waitForTimeout(300) }

    for (const view of VIEWS) {
      // switch modes in place (the canvas keeps its read; month re-reads its own range)
      await page.locator('.tcc-modes [role="tab"]', { hasText: new RegExp(`^${view}`, 'i') }).first().click()
      await page.waitForTimeout(600)
      await ready(page)
      await shot(page, `${tag}-${view}`)
      if (view === 'attention') {
        const row = page.locator('.tcc-attn__row').first()
        if (await row.count()) { await row.click(); await page.waitForTimeout(700); await shot(page, `${tag}-attention-detail`) }
      }
    }
    results.push({ tag, loadMs, today, errors: errors.slice(0, 6) })
    await ctx.close()
  }
}
clearTimeout(watchdog)
await browser.close()
console.log(JSON.stringify({ blocked, results: results.filter((r) => typeof r !== 'string') }, null, 1))
console.log(`shots: ${results.filter((r) => typeof r === 'string').length} → ${OUT}`)
