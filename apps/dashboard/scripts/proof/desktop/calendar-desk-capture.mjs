import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * CALENDAR 3.0 — desktop capture (READ ONLY: every non-GET /api request is
 * aborted and counted).
 *
 *   record  one live pass over /calendar (Today, Month) that records every
 *           GET /api response into a HAR
 *   replay  every capture re-serves those real responses from the HAR
 *           (entries with status <= 0 dropped); ?demo=1 captures use the
 *           labelled fixture data (closing + running workflow timer, which
 *           production does not hold today)
 *
 *   node scripts/proof/desktop/calendar-desk-capture.mjs --phase=record
 *   node scripts/proof/desktop/calendar-desk-capture.mjs --phase=replay [--only=substring]
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/calendar-desk'))
const HAR = path.join(OUT, 'calendar-desk.har')
const PHASE = arg('phase', 'replay')
const ONLY = arg('only', '')
const TZ = 'America/Chicago'
await fs.mkdir(OUT, { recursive: true })

async function context(browser, { width, height, theme, har = null, record = false }) {
  const ctx = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: 1, timezoneId: TZ,
    ...(record ? { recordHar: { path: HAR, urlFilter: '**/api/**', content: 'embed', mode: 'full' } } : {}),
  })
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
      localStorage.removeItem('nexus.desktop.split')
      localStorage.removeItem('nexus.calendar.inspector')
      const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
      localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
    } catch { /* ignore */ }
  }, theme)
  const blocked = []
  await ctx.route('**/api/**', async (route) => {
    const m = route.request().method()
    if (!['GET', 'OPTIONS', 'HEAD'].includes(m)) { blocked.push(`${m} ${new URL(route.request().url()).pathname}`); return route.abort() }
    return route.fallback()
  })
  if (har) await ctx.routeFromHAR(har, { url: '**/api/**', notFound: 'fallback', update: false })
  return { ctx, blocked }
}

async function ready(page) {
  await page.waitForSelector('.cal3', { timeout: 120_000 })
  await page.waitForSelector('.cal3 .c3-main > :not(.c3-skel)', { timeout: 240_000 })
  await page.waitForFunction(() => !document.querySelector('.cal3.is-refreshing'), null, { timeout: 60_000 }).catch(() => {})
  await page.waitForTimeout(1200)
}
function measure() {
  const root = document.querySelector('.cal3')
  const txt = root?.textContent || ''
  const leaves = root ? [...root.querySelectorAll('*')].filter((e) => e.children.length === 0 && (e.textContent || '').trim()) : []
  const tiny = new Set()
  for (const el of leaves) { const fs = parseFloat(getComputedStyle(el).fontSize); if (fs && fs < 9.5 && el.getClientRects().length) tiny.add(`${fs}px:${el.textContent.trim().slice(0, 20)}`) }
  const main = document.querySelector('.c3-main')
  return {
    garbage: (txt.match(/\bNaN\b|\bundefined\b|\[object Object\]|Infinity|Invalid Date/g) || []).slice(0, 5),
    overflowX: main ? main.scrollWidth - main.clientWidth : null,
    rootOverflowX: root ? root.scrollWidth - root.clientWidth : null,
    tiny: [...tiny].slice(0, 6),
    inspector: Boolean(document.querySelector('.c3-insp')),
    header: document.querySelector('.c3-head')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 140) || null,
    tele: [...document.querySelectorAll('.c3-tele__cell')].map((c) => c.textContent?.replace(/\s+/g, ' ').trim()).slice(0, 6),
    crashed: /Something went wrong|crashed/i.test(document.body.textContent || ''),
  }
}
const shot = async (page, name, results) => {
  if (ONLY && !name.includes(ONLY)) return
  results[name] = await page.evaluate(measure)
  await page.screenshot({ path: path.join(OUT, `${name}.png`) })
  const m = results[name]
  console.log(name.padEnd(46), m.garbage.length || m.overflowX > 1 || m.crashed ? `FLAG ${JSON.stringify({ g: m.garbage, ox: m.overflowX, c: m.crashed })}` : 'ok', m.tiny.length ? `tiny:${m.tiny.join('|')}` : '')
}
const pick = async (page, selector) => {
  const el = page.locator(selector).first()
  if (!(await el.count())) return false
  await el.scrollIntoViewIfNeeded().catch(() => {})
  await el.click()
  await page.waitForTimeout(500)
  return true
}
const key = async (page, k) => { await page.keyboard.press(k); await page.waitForTimeout(700) }

const browser = await chromium.launch()
const results = {}
let blockedAll = []

if (PHASE === 'record') {
  const { ctx, blocked } = await context(browser, { width: 1440, height: 900, theme: 'dark', record: true })
  const page = await ctx.newPage()
  await page.goto(`${BASE}/calendar`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await ready(page)
  await key(page, '4') // month range
  await page.waitForSelector('.c3-month', { timeout: 240_000 })
  await page.waitForFunction(() => !document.querySelector('.cal3.is-refreshing'), null, { timeout: 240_000 }).catch(() => {})
  await page.waitForTimeout(1500)
  blockedAll = blocked
  await ctx.close()
  // A HAR entry with status <= 0 is an aborted request — never replay it.
  const har = JSON.parse(await fs.readFile(HAR, 'utf8'))
  const before = har.log.entries.length
  har.log.entries = har.log.entries.filter((e) => Number(e.response?.status) > 0)
  await fs.writeFile(HAR, JSON.stringify(har))
  console.log(`recorded ${har.log.entries.length} entries (${before - har.log.entries.length} dropped) · blocked writes: ${blockedAll.length}`)
} else {
  const SIZES = [[1440, 900], [1920, 1080], [5120, 1440]]
  const THEMES = ['dark', 'light', 'true_black', 'red_ops']
  for (const theme of THEMES) {
    for (const [W, H] of SIZES) {
      const tag = `${theme}-${W}`
      if (ONLY && !`${tag}`.includes(ONLY.split(':')[0]) && !ONLY.includes('-')) { /* fallthrough to per-shot filter */ }
      const { ctx, blocked } = await context(browser, { width: W, height: H, theme, har: HAR })
      const page = await ctx.newPage()
      await page.goto(`${BASE}/calendar`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
      await ready(page)
      await shot(page, `today-${tag}`, results)
      if (await pick(page, '.c3-today .c3-window')) await shot(page, `insp-window-${tag}`, results)
      await key(page, 'Escape')
      await key(page, '2')
      await page.waitForSelector('.c3-tl', { timeout: 60_000 })
      await page.waitForTimeout(600)
      await shot(page, `timeline-${tag}`, results)
      if (await pick(page, '.c3-tl [data-event^="thread:"], .c3-tl [data-event^="queue:"]')) await shot(page, `insp-followup-${tag}`, results)
      if (theme === 'dark' || theme === 'light') {
        if (W !== 5120) {
          await key(page, 'Escape'); await key(page, '3'); await page.waitForSelector('.c3-week'); await page.waitForTimeout(600); await shot(page, `week-${tag}`, results)
          await key(page, '5'); await page.waitForSelector('.c3-attn'); await page.waitForTimeout(500); await shot(page, `attention-${tag}`, results)
          await key(page, '6'); await page.waitForSelector('.c3-now'); await page.waitForTimeout(500); await shot(page, `now-${tag}`, results)
          await key(page, '4'); await page.waitForSelector('.c3-month'); await page.waitForFunction(() => !document.querySelector('.cal3.is-refreshing'), null, { timeout: 120_000 }).catch(() => {}); await page.waitForTimeout(800); await shot(page, `month-${tag}`, results)
        }
      }
      blockedAll = blockedAll.concat(blocked)
      await ctx.close()
    }
    // 1280: the inspector starts collapsed
    {
      const { ctx, blocked } = await context(browser, { width: 1280, height: 800, theme, har: HAR })
      const page = await ctx.newPage()
      await page.goto(`${BASE}/calendar`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
      await ready(page)
      await shot(page, `today-${theme}-1280-collapsed`, results)
      blockedAll = blockedAll.concat(blocked)
      await ctx.close()
    }
    // DEMO (labelled): closing milestone + running workflow timer
    for (const W of theme === 'dark' ? [1440, 1920] : [1440]) {
      const H = W === 1920 ? 1080 : 900
      const { ctx, blocked } = await context(browser, { width: W, height: H, theme, har: HAR })
      const page = await ctx.newPage()
      await page.goto(`${BASE}/calendar?demo=1`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
      await ready(page)
      await shot(page, `demo-today-${theme}-${W}`, results)
      if (await pick(page, '[data-event^="closing:"][data-event$=":closing_date"]')) await shot(page, `demo-insp-closing-${theme}-${W}`, results)
      if (await pick(page, '[data-event^="wf:"][data-event$=":wake"]')) await shot(page, `demo-insp-workflow-${theme}-${W}`, results)
      if (theme === 'dark' && W === 1440) {
        await key(page, 'Escape')
        await key(page, '2'); await page.waitForSelector('.c3-tl'); await page.waitForTimeout(500); await shot(page, `demo-timeline-${theme}-${W}`, results)
        await key(page, '3'); await page.waitForSelector('.c3-week'); await page.waitForTimeout(500); await shot(page, `demo-week-${theme}-${W}`, results)
      }
      blockedAll = blockedAll.concat(blocked)
      await ctx.close()
    }
  }
  await fs.writeFile(path.join(OUT, 'results.json'), JSON.stringify({ results, blocked: blockedAll }, null, 2))
  console.log(`\n${Object.keys(results).length} captures · blocked writes: ${blockedAll.length}${blockedAll.length ? ` ${[...new Set(blockedAll)].slice(0, 6).join(', ')}` : ''}`)
}
await browser.close()
