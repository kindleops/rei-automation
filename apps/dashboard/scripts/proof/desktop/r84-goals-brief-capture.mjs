import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * R8.4 · GOALS + INTELLIGENCE BRIEF capture (READ ONLY).
 *
 * Every non-GET to /api and to Supabase is aborted and reported. Goals are
 * seeded into the goals store's own device key (lc.analytics.goals.v1:<op>) —
 * the same place an operator's goals live until the PROPOSED analytics_goals
 * table exists; their PROGRESS is the live Analytics engine (GET only). The
 * composer is opened but never submitted. "Brief me" runs from the Command Deck.
 *
 *   node scripts/proof/desktop/r84-goals-brief-capture.mjs --out=/tmp/r84 [--themes=dark,light] [--only=goals,composer,home,plane,ultra]
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/r84-goals-brief'))
const THEMES = arg('themes', 'dark,light').split(',')
const ONLY = arg('only', '') ? arg('only', '').split(',') : null
const want = (k) => !ONLY || ONLY.includes(k)
await fs.mkdir(OUT, { recursive: true })

const browser = await chromium.launch()
const watchdog = setTimeout(() => { console.log('WATCHDOG: capture exceeded 1500 s'); process.exit(2) }, 1_500_000)

const stamp = new Date().toISOString()
const g = (id, metric, period, target, over = {}) => ({ goal_id: id, metric_id: metric, label: null, market: null, market_label: null, period_kind: period, comparator: 'at_least', target_value: target, timezone: 'America/Chicago', status: 'active', revision: 1, created_at: stamp, updated_at: stamp, ...over })
const GOALS = [
  g('g_capreach1', 'sellers_reached', 'month', 900),
  g('g_capreply1', 'reached_replied', 'month', 60),
  g('g_capintr01', 'interested_sellers', 'month', 15),
  g('g_capopps01', 'opportunities_created', 'quarter', 30),
  g('g_caprate01', 'reply_rate', 'month', 0.08),
  g('g_capopt001', 'opt_out_rate', 'month', 0.03, { comparator: 'at_most' }),
  g('g_capoffr01', 'offers_issued', 'quarter', 5),
]

let seq = 0
const wid = () => `w${Date.now().toString(36)}${(++seq).toString(36)}cap`
const inst = (type, size, cell) => ({ id: wid(), type, ownerApp: 'home', size, geometry: { standard: cell, wide: cell, ultra: cell, wall: cell }, config: {}, configVersion: 1, context: { mode: 'global', subject: null }, refreshMs: null, locked: false, stack: null })
const LAYOUT = { id: 'l_r84brief', name: 'Brief + Goals', isDefault: true, profile: 'desktop', schemaVersion: 1, revision: 1, preset: null, primaryFamily: 'standard', createdAt: stamp, updatedAt: stamp, widgets: [
  inst('home.brief', 'feature', { x: 0, y: 0, w: 8, h: 7 }),
  inst('analytics.goals', 'tall', { x: 8, y: 0, w: 4, h: 7 }),
  inst('home.brief', 'medium', { x: 0, y: 7, w: 4, h: 4 }),
  inst('analytics.goals', 'small', { x: 4, y: 7, w: 3, h: 3 }),
  inst('analytics.goals', 'wide', { x: 7, y: 7, w: 5, h: 4 }),
] }

async function open({ W, H, theme, route }) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H } })
  await ctx.addInitScript(([t, goals, layout]) => {
    try {
      localStorage.removeItem('nexus.desktop.split')
      localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
      const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
      localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
      const ops = new Set(['local'])
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith('lc.home.board.v1:')) ops.add(k.slice(17))
        if (k.startsWith('lc.analytics.goals.v1:')) ops.add(k.slice(22))
      }
      const known = sessionStorage.getItem('r84-op')
      if (known) ops.add(known)
      for (const op of ops) {
        localStorage.setItem(`lc.analytics.goals.v1:${op}`, JSON.stringify({ v: 1, goals }))
        localStorage.setItem(`lc.home.board.v1:${op}`, JSON.stringify({ v: 1, activeId: layout.id, layouts: [layout], synced: [] }))
      }
    } catch { /* ignore */ }
  }, [theme, GOALS, LAYOUT])
  const page = await ctx.newPage()
  const blocked = []; const errors = []
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
  page.on('console', (m) => { if (m.type() === 'error' && !/ResizeObserver|favicon|ERR_ABORTED|Failed to load resource|net::ERR_FAILED/i.test(m.text())) errors.push(m.text().slice(0, 200)) })
  await page.route('**/*', (r) => {
    const req = r.request(); const u = new URL(req.url()); const m = req.method()
    const guarded = u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)
    if (!guarded || ['GET', 'HEAD', 'OPTIONS'].includes(m)) return r.continue()
    blocked.push(`${m} ${u.hostname}${u.pathname}`)
    return r.abort()
  })
  await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  // learn the operator key the app booted on, then re-seed once under it
  await page.waitForTimeout(2500)
  const op = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('lc.analytics.goals.v1:') || k.startsWith('lc.home.board.v1:')).map((k) => k.split(':').slice(1).join(':')).find((k) => k && k !== 'local') || null)
  if (op && !(await page.evaluate(() => sessionStorage.getItem('r84-op')))) {
    await page.evaluate((o) => sessionStorage.setItem('r84-op', o), op)
    await page.reload({ waitUntil: 'domcontentloaded' })
  }
  return { ctx, page, blocked, errors }
}

const settle = async (page, sel, ms = 120000) => {
  await page.waitForSelector(sel, { timeout: 90000 }).catch(() => console.log(`note: ${sel} not found`))
  await page.waitForFunction(() => !document.querySelector('.gl .lc-skeleton, .hb .lc-skeleton, .bf-plane .lc-skeleton'), null, { timeout: ms }).catch(() => console.log('note: still loading'))
  await page.waitForTimeout(1800)
}
const report = (name, r) => console.log(`${name}: blocked=${r.blocked.length}${r.blocked.length ? ` ${r.blocked.slice(0, 4).join(', ')}` : ''} errors=${r.errors.length}${r.errors.length ? ` ${r.errors.slice(0, 3).join(' | ')}` : ''}`)

for (const theme of THEMES) {
  if (want('goals')) {
    const r = await open({ W: 1440, H: 900, theme, route: '/analytics?lens=goals' })
    await settle(r.page, '.gl-card')
    await r.page.screenshot({ path: path.join(OUT, `${theme}-1440-goals-lens.png`) })
    report(`${theme} goals`, r)
    await r.ctx.close()
  }
  if (want('composer')) {
    const r = await open({ W: 1440, H: 900, theme, route: '/analytics?lens=goals&goal=new&metric=sellers_reached&period=month' })
    await settle(r.page, '.gl-compose')
    await r.page.locator('.gl-num input').fill('900').catch(() => {})
    await r.page.waitForTimeout(600)
    await r.page.screenshot({ path: path.join(OUT, `${theme}-1440-goal-composer.png`) })
    report(`${theme} composer`, r)
    await r.ctx.close()
  }
  if (want('home')) {
    const r = await open({ W: 1440, H: 900, theme, route: '/home' })
    await settle(r.page, '.hb-ibrief')
    await r.page.screenshot({ path: path.join(OUT, `${theme}-1440-home-brief-goals.png`) })
    await r.page.locator('.hb-scroll').evaluate((el) => el.scrollTo(0, 99999)).catch(() => {})
    await r.page.waitForTimeout(800)
    await r.page.screenshot({ path: path.join(OUT, `${theme}-1440-home-brief-goals-lower.png`) })
    report(`${theme} home`, r)
    await r.ctx.close()
  }
  if (want('plane')) {
    const r = await open({ W: 1440, H: 900, theme, route: '/pipeline' })
    await r.page.waitForSelector('.cd', { timeout: 90000 })
    await r.page.waitForTimeout(1500)
    await r.page.keyboard.press('Meta+k'); await r.page.waitForTimeout(500)
    await r.page.keyboard.type('brief me', { delay: 30 }); await r.page.waitForTimeout(1200)
    await r.page.screenshot({ path: path.join(OUT, `${theme}-1440-deck-brief-me.png`), clip: { x: 0, y: 0, width: 1440, height: 520 } })
    await r.page.keyboard.press('Enter')
    await settle(r.page, '.bf-plane')
    await r.page.screenshot({ path: path.join(OUT, `${theme}-1440-brief-plane.png`) })
    await r.page.locator('.bf-plane [aria-label="Expand the brief"]').click().catch(() => console.log('note: no expand'))
    await r.page.waitForTimeout(900)
    await r.page.screenshot({ path: path.join(OUT, `${theme}-1440-brief-plane-wide.png`) })
    report(`${theme} plane`, r)
    await r.ctx.close()
  }
}
if (want('ultra')) {
  const r = await open({ W: 5120, H: 1440, theme: THEMES[0], route: '/analytics?lens=goals' })
  await settle(r.page, '.gl-card')
  await r.page.screenshot({ path: path.join(OUT, `${THEMES[0]}-5120-goals-lens.png`) })
  report('ultra goals', r)
  await r.ctx.close()
}
clearTimeout(watchdog)
await browser.close()
