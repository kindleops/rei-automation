import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * NOTIFICATION CENTER 2.0 capture (READ ONLY): every non-GET to /api or
 * Supabase is aborted — no read / resolve / action can be written. Opens the
 * plane from the Command Deck bell on real production stories and shots each
 * lens (Needs you / Now / Resolved / System) with a story's event chain open.
 *   node scripts/proof/desktop/notification-plane-capture.mjs --out=/tmp/ncp \
 *     --themes=dark,light,true_black,red_ops --sizes=1440x900,1280x800,1920x1080,5120x1440
 * The first size gets every lens; the other sizes get the opening state + one chain.
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/notification-plane'))
const THEMES = arg('themes', 'dark').split(',')
const SIZES = arg('sizes', '1440x900').split(',').map((s) => s.split('x').map(Number))
await fs.mkdir(OUT, { recursive: true })
const watchdog = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 1_500_000)
const browser = await chromium.launch()
const report = []

for (const theme of THEMES) {
  const [W0, H0] = SIZES[0]
  const ctx = await browser.newContext({ viewport: { width: W0, height: H0 } })
  await ctx.addInitScript((t) => {
    try {
      const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
      localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
      localStorage.removeItem('nexus.desktop.split')
      localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
    } catch { /* ignore */ }
  }, theme)
  const page = await ctx.newPage()
  const errors = []
  const blocked = []
  const reads = []
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
  page.on('response', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/cockpit/notifications/stories')) reads.push(`${r.status()} ${u.pathname}${u.search.includes('since') ? '?since' : ''}`) })
  await page.route('**/*', (r) => {
    const req = r.request()
    const u = new URL(req.url())
    if ((u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method())) { blocked.push(`${req.method()} ${u.pathname}`); return r.abort() }
    return r.continue()
  })
  await page.goto(`${BASE}/pipeline`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.cd-machine', { timeout: 120000 })
  await page.waitForTimeout(1200)

  const open = async () => {
    if (!(await page.locator('.ncp').count())) await page.locator('button.cd-btn[aria-label^="Notifications"]').first().click()
    await page.waitForSelector('.ncp', { timeout: 30000 })
    await page.waitForFunction(() => { const p = document.querySelector('.ncp'); return p && !p.querySelector('.lc-skeleton') }, null, { timeout: 180000 }).catch(() => console.log('note: stories still loading'))
    await page.waitForTimeout(600)
  }
  const lens = async (label) => {
    await page.locator('.ncp__lenses button', { hasText: label }).first().click()
    await page.waitForTimeout(450)
  }
  const expandFirst = async (pick) => {
    const rows = page.locator('.ncp__list .ncs')
    const n = await rows.count()
    if (!n) return null
    let idx = 0
    if (pick) for (let i = 0; i < n; i++) { const t = await rows.nth(i).innerText(); if (pick(t)) { idx = i; break } }
    await rows.nth(idx).locator('.ncs__toggle').click()
    await page.waitForTimeout(450)
    return rows.nth(idx).innerText()
  }
  const collapse = async () => { const o = page.locator('.ncs.is-open .ncs__toggle'); if (await o.count()) { await o.first().click(); await page.waitForTimeout(250) } }

  for (let si = 0; si < SIZES.length; si++) {
    const [W, H] = SIZES[si]
    await page.setViewportSize({ width: W, height: H })
    await page.waitForTimeout(700)
    await open()
    const shot = (name) => page.screenshot({ path: path.join(OUT, `${theme}-${W}-${name}.png`) })
    const badge = await page.locator('button.cd-btn[aria-label^="Notifications"] .cd-btn__count').innerText().catch(() => '')
    await shot('open')
    if (si === 0) {
      const sections = {}
      for (const [label, key, pick] of [
        ['Needs you', 'needs-you', (t) => /Held for your review|Wants a call/.test(t)],
        ['Now', 'now', (t) => /replied/.test(t)],
        ['Resolved', 'resolved', (t) => /Response sent|You replied|Resumed|Completed|Restored/.test(t)],
        ['System', 'system', null],
      ]) {
        await lens(label)
        await shot(key)
        const text = await expandFirst(pick)
        if (text) await shot(`${key}-chain`)
        sections[key] = { count: await page.locator('.ncp__list .ncs').count(), first: text ? text.split('\n').slice(0, 6).join(' | ') : (await page.locator('.ncp .lc-empty').innerText().catch(() => '')).replace(/\n/g, ' | ') }
        await collapse()
      }
      // scroll into history: arrivals are held behind "N new" (no scroll jerk)
      await lens('Resolved')
      await page.locator('.ncp__scroll').evaluate((el) => { el.scrollTop = 400 })
      await page.waitForTimeout(400)
      await shot('resolved-scrolled')
      const planeText = await page.locator('.ncp').innerText()
      report.push({ theme, size: `${W}x${H}`, badge, sections, undefinedText: /undefined|NaN|\[object/.test(planeText) })
    } else {
      await lens('Needs you')
      const text = await expandFirst((t) => /Held for your review|Wants a call|replied/.test(t))
      await shot('needs-you-chain')
      report.push({ theme, size: `${W}x${H}`, badge, first: text ? text.split('\n').slice(0, 4).join(' | ') : null })
      await collapse()
    }
  }
  report.push({ theme, errors: errors.slice(0, 5), blocked: [...new Set(blocked)], reads: [...new Set(reads)] })
  await ctx.close()
}
clearTimeout(watchdog)
console.log(JSON.stringify(report, null, 1))
await browser.close()
