import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * R8.3 QUEUE + CAMPAIGN COMMAND capture (READ ONLY). Every non-GET to /api or
 * Supabase is aborted and reported. Nothing here clicks Send / Launch /
 * Approve / Resume / Ownership Check — the script only navigates, optionally
 * presses navigation keys (j/k) and screenshots.
 *
 *   node scripts/proof/desktop/r83-queue-campaigns-capture.mjs --apps=queue,campaigns \
 *     --sizes=1440x900,1920x1080,5120x1440 --themes=dark,true_black --out=/tmp/r83 [--tag=before] [--keys=jj]
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/r83-queue-campaigns'))
const SIZES = arg('sizes', '1440x900').split(',').map((s) => s.split('x').map(Number))
const THEMES = arg('themes', 'dark').split(',')
const APPS = arg('apps', 'queue,campaigns').split(',')
const TAG = arg('tag', '')
const KEYS = arg('keys', '')
const SETTLE = Number(arg('settle', '9000'))
// --fixture: QA ONLY. Serves a labeled fixture for the queue page read (the
// headless browser has no operator session, so the real read 401s). It never
// reaches production code; the product renders whatever the read returns.
const FIXTURE = process.argv.includes('--fixture')
  ? await fs.readFile(new URL('./fixtures/r83-queue-page.json', import.meta.url), 'utf8')
  : null
const DEMO = process.argv.includes('--demo')
const OPEN = process.argv.includes('--open')
const PHONE = process.argv.includes('--phone')
const ROUTES = {
  queue: { path: '/queue', root: '.qdk, .occ-root, .qx-root' },
  campaigns: { path: '/campaign-command', root: '.cc3, .ccc, .clc' },
}
await fs.mkdir(OUT, { recursive: true })
const browser = await chromium.launch()
const watchdog = setTimeout(() => { console.log('WATCHDOG: capture exceeded 900 s'); process.exit(2) }, 900_000)
for (const theme of THEMES) {
  for (const [W, H] of SIZES) {
    const ctx = await browser.newContext(PHONE ? { viewport: { width: W, height: H }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' } : { viewport: { width: W, height: H }, deviceScaleFactor: W > 3000 ? 0.75 : 1 })
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
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
    page.on('console', (m) => { if (m.type() === 'error' && !/ResizeObserver|favicon|ERR_ABORTED|Failed to load resource/i.test(m.text())) errors.push(m.text().slice(0, 200)) })
    await page.route('**/*', (r) => {
      const req = r.request(); const u = new URL(req.url()); const m = req.method()
      const guarded = u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)
      if (FIXTURE && m === 'GET' && u.pathname === '/api/cockpit/queue/page') return r.fulfill({ status: 200, contentType: 'application/json', body: FIXTURE })
      if (!guarded || ['GET', 'HEAD', 'OPTIONS'].includes(m)) return r.continue()
      blocked.push(`${m} ${u.hostname}${u.pathname}`)
      return r.abort()
    })
    for (const app of APPS) {
      const route = ROUTES[app]
      const tag = `${app}-${theme}-${W}x${H}${TAG ? `-${TAG}` : ''}${FIXTURE && app === 'queue' ? '-fixture' : ''}${DEMO && app === 'campaigns' ? '-demo' : ''}${OPEN && app === 'queue' ? '-open' : ''}${PHONE ? '-phone' : ''}`
      await page.goto(`${BASE}${route.path}${DEMO && app === 'campaigns' ? '?demo=1' : ''}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
      await page.waitForSelector(route.root, { timeout: 120000 }).catch(() => console.log(tag, 'note: root missing'))
      await page.waitForTimeout(SETTLE)
      if (OPEN && app === 'queue') {
        // selecting a row only opens the read-only dossier
        await page.locator('.qdk-grid [role="row"]').nth(2).click({ position: { x: 120, y: 12 } }).catch((e) => console.log(tag, 'open failed', String(e).slice(0, 120)))
        await page.waitForTimeout(1200)
      }
      if (KEYS) {
        await page.locator(route.root).first().click({ position: { x: 4, y: 4 } }).catch(() => {})
        for (const k of KEYS) { await page.keyboard.press(k); await page.waitForTimeout(250) }
        await page.waitForTimeout(800)
      }
      const m = await page.evaluate((sel) => {
        const r = document.querySelector(sel)
        const leaves = [...(r?.querySelectorAll('*') ?? [])].filter((el) => el.children.length === 0 && (el.textContent || '').trim())
        const garbage = leaves.map((el) => (el.textContent || '').trim()).filter((t) => /\bNaN\b|\bundefined\b|\[object Object\]|\bInfinity\b|^null$/.test(t)).slice(0, 6)
        return { root: r?.className?.toString().slice(0, 80) ?? null, overflowX: r ? r.scrollWidth - r.clientWidth : null, garbage }
      }, route.root)
      await page.screenshot({ path: path.join(OUT, `${tag}.png`) })
      console.log(JSON.stringify({ tag, ...m }))
    }
    console.log(JSON.stringify({ theme, size: `${W}x${H}`, blockedWrites: blocked, errors: errors.slice(0, 6) }))
    await ctx.close()
  }
}
clearTimeout(watchdog)
await browser.close()
