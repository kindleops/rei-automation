import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * RC 7.1 QA-fix verification (READ ONLY — every non-GET to /api or Supabase is aborted).
 *   --only=deck,mission,map,automation,inbox,analytics,comps  (default: all)
 *   node scripts/proof/desktop/rc71-qa-fix-capture.mjs --out=/tmp/rc71 [--only=deck]
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/rc71-qa-fix'))
const ONLY = new Set(arg('only', 'deck,mission,map,automation,inbox,analytics,comps').split(','))
const THEME = arg('theme', 'dark')
await fs.mkdir(OUT, { recursive: true })
const watchdog = setTimeout(() => { console.log('WATCHDOG'); process.exit(2) }, 600_000)
const browser = await chromium.launch()
const log = {}
const errors = []
const blocked = []
const failed = []
const reqs = []

async function session(viewport) {
  const ctx = await browser.newContext({ viewport })
  await ctx.addInitScript((theme) => {
    try {
      if (!sessionStorage.getItem('__rc71_capture')) {
        sessionStorage.clear(); sessionStorage.setItem('__rc71_capture', '1')
        const s = JSON.parse(localStorage.getItem('nexus-settings') || '{}'); s.nexusTheme = theme; localStorage.setItem('nexus-settings', JSON.stringify(s))
      }
    } catch { /* ignore */ }
  }, THEME)
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 240)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 240)}`) })
  page.on('request', (r) => { if (r.url().includes('deal-intelligence/decision')) reqs.push({ t: Date.now(), ev: 'req', u: decodeURIComponent(new URL(r.url()).search).slice(0, 160) }) })
  page.on('requestfinished', (r) => { if (r.url().includes('deal-intelligence/decision')) reqs.push({ t: Date.now(), ev: 'done', u: decodeURIComponent(new URL(r.url()).search).slice(0, 160) }) })
  page.on('requestfailed', (r) => { if (r.url().includes('deal-intelligence/decision')) reqs.push({ t: Date.now(), ev: `failed ${r.failure()?.errorText}`, u: decodeURIComponent(new URL(r.url()).search).slice(0, 160) }) })
  page.on('response', (r) => { if (r.url().includes('/ops/map')) reqs.push({ t: Date.now(), ev: `ops/map ${r.status()}`, u: new URL(r.url()).search.slice(0, 200) }) })
  page.on('response', async (r) => { if (r.status() >= 500 && r.url().includes('/api/')) { let body = ''; try { body = (await r.text()).slice(0, 300) } catch { /* ignore */ } failed.push(`${r.status()} ${new URL(r.url()).pathname}${new URL(r.url()).search.slice(0, 80)} ${body}`) } })
  await page.route('**/*', (r) => { const req = r.request(); const u = new URL(req.url()); if ((u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method())) { blocked.push(`${req.method()} ${u.pathname}`); return r.abort() } return r.continue() })
  return { ctx, page }
}
const shot = (page, n) => page.screenshot({ path: path.join(OUT, `${n}.png`) })
const go = async (page, p, wait = 6000) => { await page.goto(`${BASE}${p}`, { waitUntil: 'domcontentloaded', timeout: 120000 }); await page.waitForSelector('[data-ws-pane]', { timeout: 120000 }); await page.waitForTimeout(wait) }
const deck = async (page, q) => { await page.keyboard.press('Meta+k'); await page.waitForTimeout(500); await page.keyboard.type(q, { delay: 25 }); await page.waitForTimeout(1400); await page.keyboard.press('Enter'); await page.waitForTimeout(2500) }
const overlap = (page) => page.evaluate(() => {
  const r = (s) => { const e = document.querySelector(s); return e ? e.getBoundingClientRect() : null }
  const field = r('.cd .dsk-cmd__field')
  const items = [...document.querySelectorAll('.cd__ctx *')].filter((e) => e.children.length === 0 && e.getBoundingClientRect().width > 0)
  const over = items.map((e) => ({ t: (e.textContent || e.tagName).trim().slice(0, 30), right: Math.round(e.getBoundingClientRect().right) })).filter((x) => field && x.right > field.left + 1)
  return { fieldLeft: field && Math.round(field.left), over }
})
const railFit = (page) => page.evaluate(() => {
  const nav = document.querySelector('.cr__nav')
  const rows = [...document.querySelectorAll('.cr__nav .cr-row')]
  const nr = nav.getBoundingClientRect()
  return { navH: Math.round(nr.height), scrollH: nav.scrollHeight, hidden: rows.filter((x) => x.getBoundingClientRect().bottom > nr.bottom + 1).map((x) => x.textContent.trim().slice(0, 20)) }
})

if (ONLY.has('deck')) {
  for (const vp of [{ width: 1280, height: 800 }, { width: 1440, height: 900 }, { width: 1600, height: 1000 }]) {
    const { ctx, page } = await session(vp)
    await go(page, '/inbox')
    await deck(page, 'deal intelligence beside')
    await page.waitForTimeout(3000)
    log[`deck-${vp.width}`] = { overlap: await overlap(page), rail: await railFit(page) }
    await shot(page, `deck-${THEME}-${vp.width}x${vp.height}-inbox-di`)
    await ctx.close()
  }
}

if (ONLY.has('mission')) {
  for (const vp of [{ width: 1600, height: 1000 }, { width: 1280, height: 800 }]) {
    const { ctx, page } = await session(vp)
    await go(page, '/inbox', 8000)
    const row = page.locator('[data-ledger-row], .ixl-row, [role="row"]').nth(1)
    await row.click({ timeout: 30000 }).catch(() => { log.rowClick = 'not found' })
    await page.waitForTimeout(3000)
    const t0 = Date.now()
    await deck(page, 'work this seller')
    for (const t of [2000, 6000, 12000]) { await page.waitForTimeout(t === 2000 ? 0 : 4000 + (t === 12000 ? 2000 : 0)); log[`mission-${vp.width}-dr@${Date.now() - t0}`] = await page.evaluate(() => document.querySelector('.dr')?.className ?? (document.querySelector('.dr-route-fallback') ? 'suspense' : 'none')) }
    log[`mission-${vp.width}-reqs`] = reqs.splice(0).map((r) => ({ ...r, t: r.t - t0 }))
    log[`mission-${vp.width}`] = {
      overlap: await overlap(page),
      panes: await page.evaluate(() => [...document.querySelectorAll('[data-ws-pane]')].map((p) => {
        const b = p.getBoundingClientRect()
        return { label: p.getAttribute('aria-label'), w: Math.round(b.width), h: Math.round(b.height), text: (p.innerText || '').replace(/\s+/g, ' ').slice(0, 160), dr: p.querySelector('.dr') ? p.querySelector('.dr').className : null, fallback: Boolean(p.querySelector('.dr-route-fallback')) }
      })),
    }
    await shot(page, `mission-${THEME}-${vp.width}x${vp.height}-work-seller`)
    await ctx.close()
  }
}

if (ONLY.has('map')) {
  const { ctx, page } = await session({ width: 1440, height: 900 })
  await page.addInitScript(() => {
    const w = window; w.__camLog = []
    const iv = setInterval(() => {
      const m = w.__nxMap; if (!m || m.__camHooked) return
      m.__camHooked = true
      for (const ev of ['movestart', 'moveend']) m.on(ev, (e) => { const c = m.getCenter(); w.__camLog.push({ ev, t: Math.round(performance.now()), user: Boolean(e.originalEvent), c: [+c.lng.toFixed(2), +c.lat.toFixed(2)], z: +m.getZoom().toFixed(2), stack: ev === 'movestart' ? String(new Error().stack).split('\n').slice(2, 9).map((l) => l.trim().replace(/https?:\/\/localhost:5173/, '').slice(0, 110)) : undefined }) })
    }, 50)
    setTimeout(() => clearInterval(iv), 60000)
  })
  const t0 = Date.now()
  await go(page, '/map', 14000)
  log.camLog = await page.evaluate(() => window.__camLog.filter((e) => e.ev === 'moveend').map((e) => `${e.t}ms ${e.c.join(',')} z${e.z}`))
  log.mapReqs = reqs.splice(0).filter((r) => r.ev.startsWith('ops/map')).map((r) => ({ ...r, t: r.t - t0 }))
  log.map = await page.evaluate(() => ({ text: (document.querySelector('[data-ws-pane]')?.innerText || '').replace(/\s+/g, ' ').slice(0, 300), url: location.href }))
  await shot(page, `map-${THEME}-1440-initial`)
  await ctx.close()
}

if (ONLY.has('automation')) {
  const { ctx, page } = await session({ width: 1440, height: 900 })
  await go(page, '/analytics', 8000)
  let tab = page.getByRole('tab', { name: /^automation$/i }).first()
  if (!(await tab.count())) tab = page.getByRole('button', { name: /^automation$/i }).first()
  if (await tab.count()) { await tab.click(); await page.waitForTimeout(6000) } else log.automationTab = 'not found'
  await page.waitForFunction(() => document.querySelector('.ix-calendar [data-reveal]'), null, { timeout: 90000 }).catch(() => { log.rhythmTimeout = true })
  log.rhythmBefore = await page.evaluate(() => [...document.querySelectorAll('.ix-calendar [data-reveal]')].map((g) => ({ reveal: g.getAttribute('data-reveal'), top: Math.round(g.getBoundingClientRect().top), vh: innerHeight })))
  const cal = page.getByText(/daily rhythm/i).first()
  if (await cal.count()) { await cal.scrollIntoViewIfNeeded(); await page.waitForTimeout(2500) } else log.dailyRhythm = 'not found'
  log.rhythm = await page.evaluate(() => [...document.querySelectorAll('.ix-calendar [data-reveal]')].map((g) => { const r = g.getBoundingClientRect(); const c = g.querySelector('[role=gridcell]'); return { reveal: g.getAttribute('data-reveal'), cells: g.querySelectorAll('[role=gridcell]').length, w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), cellOpacity: c ? getComputedStyle(c).opacity : null } }))
  await shot(page, `automation-${THEME}-1440-daily-rhythm`)
  await ctx.close()
}

if (ONLY.has('analytics')) {
  const { ctx, page } = await session({ width: 1440, height: 900 })
  await go(page, '/analytics', 10000)
  await shot(page, `analytics-${THEME}-1440-overview`)
  await ctx.close()
}

if (ONLY.has('inbox')) {
  const { ctx, page } = await session({ width: 1280, height: 800 })
  await go(page, '/inbox')
  await deck(page, 'deal intelligence beside')
  await page.waitForTimeout(3000)
  await shot(page, `inbox-${THEME}-1280-narrow-pane`)
  await ctx.close()
}

if (ONLY.has('comps')) {
  const { ctx, page } = await session({ width: 1440, height: 900 })
  await go(page, `/comp-intelligence${arg('comps', '')}`, 14000)
  await shot(page, `comps-${THEME}-1440`)
  await ctx.close()
}

clearTimeout(watchdog)
console.log(JSON.stringify({ log, reqs, errors: [...new Set(errors)].slice(0, 15), failed: [...new Set(failed)], blocked: [...new Set(blocked)] }, null, 1))
await browser.close()
