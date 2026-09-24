import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
// Read-only interaction proof for the mobile Campaign index: search, the
// attention path, the card action sheet, empty states, and tab/scroll/search
// state across a round trip into a campaign. Non-GET requests are aborted.
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const WIDTHS = (arg('width', '375,390,393,430')).split(',').map(Number)
const THEME = arg('theme', 'dark')
const HEIGHTS = { 375: 812, 390: 844, 393: 852, 430: 932 }
const OUT = path.resolve(arg('out', 'artifacts/campaign-dashboard/interactions'))
await fs.mkdir(OUT, { recursive: true })

const b = await chromium.launch()
const findings = []
for (const width of WIDTHS) {
  const ctx = await b.newContext({ viewport: { width, height: HEIGHTS[width] ?? 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const p = await ctx.newPage()
  const writes = []
  await p.route('**/api/**', (r) => {
    if (['GET', 'OPTIONS'].includes(r.request().method())) return r.continue()
    writes.push(`${r.request().method()} ${r.request().url()}`)
    return r.abort()
  })
  await p.addInitScript((t) => { try { localStorage.setItem('nexus-settings', JSON.stringify({ nexusTheme: t })); sessionStorage.clear() } catch {} }, THEME)
  const errs = []; p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 140)))
  const shot = (name) => p.screenshot({ path: `${OUT}/${width}-${THEME}-${name}.png` })
  const note = (ok, what) => { if (!ok) findings.push(`${width}: ${what}`) }

  await p.goto(`${BASE}/campaign-command`, { waitUntil: 'domcontentloaded', timeout: 180000 })
  await p.waitForSelector('[data-campaign-card]', { timeout: 120000 }); await p.waitForTimeout(2500)

  // Every tab filters, none silently returns the whole book.
  const total = await p.evaluate(() => document.querySelectorAll('.cxi__seg-tab').length)
  const perTab = {}
  for (let i = 0; i < total; i += 1) {
    await p.locator('.cxi__seg-tab').nth(i).click(); await p.waitForTimeout(450)
    const label = (await p.locator('.cxi__seg-tab').nth(i).textContent()).replace(/\d+$/, '').trim()
    perTab[label] = await p.locator('[data-campaign-card]').count()
    if (perTab[label] === 0) await shot(`empty-${label.toLowerCase()}`)
  }
  // indicator sits under the selected tab
  const ink = await p.evaluate(() => {
    const on = document.querySelector('.cxi__seg-tab[aria-selected="true"]')?.getBoundingClientRect()
    const bar = document.querySelector('.cxi__seg-blob')?.getBoundingClientRect()
    return on && bar ? Math.abs(on.left - bar.left) + Math.abs(on.width - bar.width) : -1
  })
  note(ink >= 0 && ink < 3, `segment indicator off by ${ink}px`)
  await p.locator('.cxi__seg-tab').first().click(); await p.waitForTimeout(400)

  // Attention path
  const alert = p.locator('.cxi__alert')
  if (await alert.count()) {
    await alert.click(); await p.waitForTimeout(500)
    const kinds = await p.locator('[data-campaign-card]').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')))
    note(kinds.length > 0 && kinds.every((k) => k === 'attention' || k === 'hold'), `attention path shows ${kinds.join(',')}`)
    await shot('attention')
    await p.locator('.cxi__search-done').click(); await p.waitForTimeout(400)
  }

  // Search
  await p.locator('[aria-label="Search campaigns"]').first().click(); await p.waitForTimeout(400)
  await p.locator('.cxi__search-field input').fill('miami'); await p.waitForTimeout(500)
  const found = await p.locator('.cxc__name').allTextContents()
  note(found.length >= 1 && found.every((t) => /miami/i.test(t)), `search miami -> ${found.join(' | ')}`)
  await shot('search')
  await p.locator('.cxi__search-field input').fill('zzzz-nothing'); await p.waitForTimeout(400)
  await shot('search-empty')
  await p.locator('.cxi__search-done').click(); await p.waitForTimeout(400)

  // Card action sheet (read only — Cancel)
  await p.locator('.cxc__more').first().click(); await p.waitForTimeout(450)
  const items = await p.locator('.cxs__item').allTextContents()
  note(items.length > 0, 'action sheet empty')
  await shot('menu')
  await p.locator('.cxs__cancel').click(); await p.waitForTimeout(350)
  note(await p.locator('.cxs').count() === 0, 'sheet did not close')

  // Round trip: Drafts, scrolled, into a campaign and back
  await p.locator('.cxi__seg-tab', { hasText: /^Drafts/ }).click(); await p.waitForTimeout(450)
  await p.evaluate(() => { document.querySelector('.cxi__scroll').scrollTop = 600 }); await p.waitForTimeout(300)
  const before = await p.evaluate(() => document.querySelector('.cxi__scroll').scrollTop)
  const t0 = Date.now()
  await p.locator('.cxc__hit').nth(2).click()
  await p.waitForSelector('.cdm2, .ccc--mobile-campaign-detail', { timeout: 60000 })
  const openMs = Date.now() - t0
  await p.waitForTimeout(800)
  const back = p.locator('.cdb2 button').first()
  const t1 = Date.now()
  await back.click()
  await p.waitForSelector('.cxi', { timeout: 30000 })
  const backMs = Date.now() - t1
  await p.waitForTimeout(400)
  const after = await p.evaluate(() => ({
    tab: document.querySelector('.cxi__seg-tab[aria-selected="true"]')?.textContent,
    scroll: document.querySelector('.cxi__scroll')?.scrollTop,
  }))
  note(/^Drafts/.test(after.tab || ''), `tab after round trip: ${after.tab}`)
  note(Math.abs((after.scroll ?? 0) - before) < 4, `scroll ${before} -> ${after.scroll}`)

  // Last card clears the dock
  await p.locator('.cxi__seg-tab').first().click(); await p.waitForTimeout(400)
  await p.evaluate(() => { const s = document.querySelector('.cxi__scroll'); s.scrollTop = s.scrollHeight })
  await p.waitForTimeout(400)
  const dock = await p.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-campaign-card]')]
    const last = cards.at(-1)?.getBoundingClientRect()
    const dockEl = document.querySelector('.nx-pinned-app-dock, [class*="pinned-app-dock"]')
    const d = dockEl?.getBoundingClientRect()
    return { lastBottom: last ? Math.round(last.bottom) : null, dockTop: d ? Math.round(d.top) : null }
  })
  note(dock.lastBottom != null && dock.dockTop != null && dock.lastBottom <= dock.dockTop, `last card ${dock.lastBottom} vs dock ${dock.dockTop}`)
  await shot('bottom')

  // L · a real background refresh (the index polls every 45s) must leave the
  // tab, the scroll position and the cards alone — no entrance replay.
  if (arg('realtime', '') === String(width)) {
    await p.locator('.cxi__seg-tab', { hasText: /^Drafts/ }).click(); await p.waitForTimeout(400)
    await p.evaluate(() => { document.querySelector('.cxi__scroll').scrollTop = 500 })
    await p.waitForTimeout(300)
    const pre = await p.evaluate(() => ({ tab: document.querySelector('.cxi__seg-tab[aria-selected="true"]')?.textContent, scroll: document.querySelector('.cxi__scroll').scrollTop }))
    const refreshed = await p.waitForResponse((r) => /\/api\/cockpit\/campaigns(\?|$)/.test(r.url()) && r.request().method() === 'GET', { timeout: 70000 }).then(() => true, () => false)
    await p.waitForTimeout(1500)
    const post = await p.evaluate(() => ({
      tab: document.querySelector('.cxi__seg-tab[aria-selected="true"]')?.textContent,
      scroll: document.querySelector('.cxi__scroll').scrollTop,
      entering: document.querySelectorAll('.cxc.is-entering').length,
    }))
    note(refreshed, 'no background refresh observed within 70s')
    note(post.tab === pre.tab && Math.abs(post.scroll - pre.scroll) < 4 && post.entering === 0, `refresh moved state ${JSON.stringify(pre)} -> ${JSON.stringify(post)}`)
    console.log(JSON.stringify({ realtime: { refreshed, pre, post } }))
  }

  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  note(overflow === 0, `overflow ${overflow}`)
  note(writes.length === 0, `non-GET attempted: ${writes.join(', ')}`)
  note(errs.length === 0, `page errors: ${errs.join(' | ')}`)
  console.log(JSON.stringify({ width, perTab, sheet: items, openMs, backMs, dock, overflow }))
  await ctx.close()
}
await b.close()
console.log(findings.length ? `FINDINGS:\n  ${findings.join('\n  ')}` : 'ALL CHECKS PASSED')
