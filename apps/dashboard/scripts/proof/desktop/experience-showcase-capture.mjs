import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * EXPERIENCE SYSTEM showcase capture (DEV route /dev/experience, READ ONLY).
 * The showcase renders sample data; the surrounding desktop shell still reads
 * live sources, so every non-GET to /api or Supabase is aborted and reported.
 * Captures the resting page plus the transient surfaces (menu, select,
 * combobox, tooltip, inspector, confirm) in each theme.
 *
 *   node scripts/proof/desktop/experience-showcase-capture.mjs --themes=dark,light --out=/tmp/lcx
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/experience'))
const SIZES = arg('sizes', '1440x900').split(',').map((s) => s.split('x').map(Number))
const THEMES = arg('themes', 'dark').split(',')
const ONLY = arg('only', '')
await fs.mkdir(OUT, { recursive: true })

const browser = await chromium.launch()
for (const theme of THEMES) {
  for (const [W, H] of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: W, height: H } })
    await ctx.addInitScript((t) => {
      try {
        localStorage.removeItem('nexus.desktop.split')
        localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
        const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
        localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
      } catch { /* ignore */ }
    }, theme)
    const page = await ctx.newPage()
    const blocked = []; const errors = []
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 220)))
    page.on('console', (m) => { if (m.type() === 'error' && !/ResizeObserver|favicon|ERR_ABORTED|Failed to load resource/i.test(m.text())) errors.push(m.text().slice(0, 220)) })
    await page.route('**/*', (r) => {
      const req = r.request(); const u = new URL(req.url()); const m = req.method()
      const guarded = u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)
      if (!guarded || ['GET', 'HEAD', 'OPTIONS'].includes(m)) return r.continue()
      blocked.push(`${m} ${u.hostname}${u.pathname}`)
      return r.abort()
    })
    const tag = `${theme}-${W}x${H}`
    const watchdog = setTimeout(() => { console.log(tag, 'WATCHDOG: capture exceeded 300 s'); process.exit(2) }, 300_000)
    await page.goto(`${BASE}/dev/experience`, { waitUntil: 'domcontentloaded', timeout: 120000 })
    await page.waitForSelector('.lcx', { timeout: 90000 })
    await page.waitForTimeout(1500)
    const shot = async (name, opts = {}) => page.screenshot({ path: path.join(OUT, `${tag}-${name}.png`), ...opts })
    const metrics = await page.evaluate(() => {
      const root = document.querySelector('.lcx')
      return { overflowX: root ? root.scrollWidth - root.clientWidth : null, scrollH: root?.scrollHeight ?? 0, clientH: root?.clientHeight ?? 0 }
    })
    if (!ONLY || ONLY === 'rest') {
      const n = Math.min(4, Math.ceil(metrics.scrollH / Math.max(1, metrics.clientH)))
      for (let i = 0; i < n; i += 1) {
        await page.evaluate((y) => { const r = document.querySelector('.lcx'); if (r) r.scrollTop = y }, i * metrics.clientH)
        await page.waitForTimeout(400)
        await shot(`rest-${i + 1}`)
      }
      await page.evaluate(() => { const r = document.querySelector('.lcx'); if (r) r.scrollTop = 0 })
    }
    if (!ONLY || ONLY === 'overlays') {
      // menu
      await page.getByRole('button', { name: 'Actions' }).first().click()
      await page.waitForTimeout(450)
      await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown')
      await page.waitForTimeout(250)
      await shot('menu')
      await page.keyboard.press('Escape')
      // select
      await page.getByRole('combobox', { name: 'Metric' }).first().click()
      await page.waitForTimeout(450)
      await shot('select')
      await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter')
      await page.waitForTimeout(600)
      await shot('select-after')
      // combobox
      const combo = page.locator('.lcx-card .lc-combo__input').first()
      await combo.click(); await combo.type('mi', { delay: 40 })
      await page.waitForTimeout(450)
      await shot('combobox')
      await page.keyboard.press('Escape'); await page.keyboard.press('Escape')
      // tooltip via keyboard focus
      await page.locator('.lcx-pill').first().focus()
      await page.waitForTimeout(700)
      await shot('tooltip')
      // inspector from the grid
      await page.evaluate(() => { const r = document.querySelector('.lcx'); const g = document.querySelector('.lcx-gridcard'); if (r && g) r.scrollTop = g.offsetTop - 20 })
      await page.waitForTimeout(400)
      await page.locator('.lc-grid__row').nth(3).click()
      await page.waitForTimeout(700)
      await page.locator('.lc-grid__scroller').focus()
      await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown')
      await page.waitForTimeout(500)
      await shot('inspector')
      await page.keyboard.press('Escape')
      await page.waitForTimeout(400)
      // confirm dialog
      await page.evaluate(() => { const r = document.querySelector('.lcx'); if (r) r.scrollTop = 0 })
      await page.getByRole('button', { name: 'Pause campaign' }).first().click()
      await page.waitForTimeout(600)
      await shot('confirm')
      await page.keyboard.press('Escape')
    }
    clearTimeout(watchdog)
    console.log(JSON.stringify({ tag, ...metrics, blocked: blocked.slice(0, 8), errors: errors.slice(0, 8) }))
    await ctx.close()
  }
}
await browser.close()
