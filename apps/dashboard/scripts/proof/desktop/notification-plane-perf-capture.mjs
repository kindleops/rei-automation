import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * NOTIFICATION CENTER 2.0 — open-time + theme capture (READ ONLY): every non-GET
 * to /api or Supabase is aborted, so no read / resolve / arm can be written.
 *   cold   a fresh tab: bell click as soon as the deck renders → plane shell, → content
 *   warm   close + reopen in the same session
 *   cache  reload (session cache) → bell click → content
 * Then per theme: open, keyboard cursor (↓↓), a chain, the Alerts & Signals face.
 *   node scripts/proof/desktop/notification-plane-perf-capture.mjs --out=/tmp/ncp --themes=dark,true_black,red_ops
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/notification-plane-perf'))
const THEMES = arg('themes', 'dark,true_black,red_ops').split(',')
const [W, H] = arg('size', '1440x900').split('x').map(Number)
await fs.mkdir(OUT, { recursive: true })
const watchdog = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 900_000)
const browser = await chromium.launch()
const report = []
const BELL = 'button.cd-btn[aria-label^="Notifications"]'
const contentReady = () => { const p = document.querySelector('.ncp'); return Boolean(p && (p.querySelector('.ncs') || p.querySelector('.lc-empty') || p.querySelector('.lc-error'))) }

for (const theme of THEMES) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H } })
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
  page.on('response', async (r) => {
    const u = new URL(r.url())
    if (!u.pathname.startsWith('/api/cockpit/notifications/stories')) return
    const timing = r.request().timing()
    reads.push({ q: u.search.replace(/since=[^&]+/, 'since=…').replace(/cursor=[^&]+/, 'cursor=…'), status: r.status(), ms: Math.round(timing.responseEnd > 0 ? timing.responseEnd : -1) })
  })
  await page.route('**/*', (r) => {
    const req = r.request()
    const u = new URL(req.url())
    if ((u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method())) { blocked.push(`${req.method()} ${u.pathname}`); return r.abort() }
    return r.continue()
  })
  const shot = (name) => page.screenshot({ path: path.join(OUT, `${theme}-${W}-${name}.png`) })
  const timeOpen = async () => {
    const t0 = Date.now()
    await page.locator(BELL).first().click()
    await page.waitForSelector('.ncp', { timeout: 30000 })
    const shell = Date.now() - t0
    await page.waitForFunction(contentReady, null, { timeout: 120000 }).catch(() => null)
    const content = Date.now() - t0
    const fromCache = await page.locator('.ncp__sync').count()
    return { shell_ms: shell, content_ms: content, reconciling_at_paint: Boolean(fromCache) }
  }
  const close = async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(250); if (await page.locator('.ncp').count()) { await page.locator(BELL).first().click(); await page.waitForTimeout(250) } }

  await page.goto(`${BASE}/pipeline`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.cd-machine', { timeout: 120000 })
  const timings = {}
  if (theme === THEMES[0]) {
    timings.cold = await timeOpen() // a fresh tab, no session cache: whatever the network gives
    await page.waitForFunction(() => !document.querySelector('.ncp__sync'), null, { timeout: 120000 }).catch(() => null)
    await close()
    timings.warm = await timeOpen()
    await close()
    await page.waitForTimeout(800) // let the session cache save
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.cd-machine', { timeout: 120000 })
    timings.cache = await timeOpen()
    await shot('cache-open')
    await page.waitForFunction(() => !document.querySelector('.ncp__sync'), null, { timeout: 120000 }).catch(() => null)
  } else {
    await page.waitForTimeout(1500)
    await page.locator(BELL).first().click()
    await page.waitForFunction(contentReady, null, { timeout: 120000 }).catch(() => null)
    await page.waitForFunction(() => !document.querySelector('.ncp__sync'), null, { timeout: 120000 }).catch(() => null)
  }
  await page.waitForTimeout(600)
  await shot('open')
  // keyboard: the plane has focus; ↓↓ moves the cursor onto the second story
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(250)
  const focused = await page.evaluate(() => { const a = document.activeElement; return a?.classList.contains('ncs__main') ? a.closest('.ncs')?.querySelector('.ncs__title')?.textContent : null })
  await shot('keyboard')
  // a chain (ArrowRight expands the focused story)
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(400)
  await shot('chain')
  await page.keyboard.press('ArrowLeft')
  // signal stories in the lenses
  const signalStories = await page.locator('.ncs__signal').count()
  // Alerts & Signals: inside the plane (not the legacy panel)
  await page.locator('.ncp button[aria-label="Alerts & Signals"]').click()
  await page.waitForSelector('.ncp-set', { timeout: 10000 })
  await page.waitForFunction(() => !document.querySelector('.ncp-set .lc-skeleton'), null, { timeout: 90000 }).catch(() => null)
  await page.waitForTimeout(500)
  await shot('settings-rules')
  const legacyOpened = await page.locator('.lcnc-panel').count()
  await page.locator('.ncp-set .lc-seg button', { hasText: 'Alerts' }).first().click()
  await page.waitForTimeout(400)
  await shot('settings-alerts')
  // Esc steps back: settings → stories → closed
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  const backToStories = await page.locator('.ncp .ncp__lenses').count() > 0 && !(await page.locator('.ncp-set').count())
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  const closed = !(await page.locator('.ncp').count())
  const planeText = await page.locator('body').innerText()
  report.push({ theme, size: `${W}x${H}`, timings, focused, signalStories, legacyOpened: legacyOpened > 0, escBackToStories: backToStories, escClosed: closed, undefinedText: /\bundefined\b|NaN|\[object/.test(planeText), errors: errors.slice(0, 5), blocked: [...new Set(blocked)], reads })
  await ctx.close()
}
clearTimeout(watchdog)
console.log(JSON.stringify(report, null, 1))
await fs.writeFile(path.join(OUT, 'perf-report.json'), JSON.stringify(report, null, 1))
await browser.close()
