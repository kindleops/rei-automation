import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * HOME 2.0 · PERSONAL COMMAND BOARD capture (READ ONLY).
 *
 * Every non-GET to /api and to Supabase is aborted and reported (so the
 * layout PUT is refused here — the board falls back to local persistence,
 * which is what an un-migrated server does anyway). Layouts are seeded into
 * the board's own local key; real data only.
 *
 *   node scripts/proof/desktop/home-board-capture.mjs --out=/tmp/home2 [--only=default,edit] [--perf]
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/home2'))
const ONLY = arg('only', '') ? arg('only', '').split(',') : null
const PERF = process.argv.includes('--perf')
await fs.mkdir(OUT, { recursive: true })

const browser = await chromium.launch()
const watchdog = setTimeout(() => { console.log('WATCHDOG: capture exceeded 900 s'); process.exit(2) }, 900_000)

let seq = 0
const wid = () => `w${Date.now().toString(36)}${(++seq).toString(36)}cap`
const inst = (type, size, cell, config = {}, extra = {}) => ({ id: wid(), type, ownerApp: 'home', size, geometry: { standard: cell }, config, configVersion: 1, context: { mode: 'global', subject: null }, refreshMs: null, locked: false, stack: null, ...extra })
const layoutDoc = (id, name, widgets, preset = null) => ({ id, name, isDefault: true, profile: 'desktop', schemaVersion: 1, revision: 1, preset, widgets, primaryFamily: 'standard', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })

const SIZES_LAYOUT = () => layoutDoc('l_sizescap', 'Sizes', [
  inst('map.pulse', 'small', { x: 0, y: 0, w: 3, h: 3 }),
  inst('map.pulse', 'medium', { x: 3, y: 0, w: 4, h: 4 }),
  inst('map.pulse', 'large', { x: 7, y: 0, w: 5, h: 5 }, { lens: 'deals' }),
  inst('inbox.replies', 'compact', { x: 0, y: 5, w: 3, h: 2 }),
  inst('inbox.replies', 'small', { x: 3, y: 5, w: 3, h: 3 }),
  inst('inbox.replies', 'medium', { x: 6, y: 5, w: 3, h: 4 }),
  inst('inbox.replies', 'large', { x: 0, y: 9, w: 6, h: 6 }),
  inst('campaign.engine', 'large', { x: 6, y: 9, w: 6, h: 6 }),
])

const DENSE = (n) => {
  const types = [
    ['home.brief', 'wide', 8, 3], ['home.focus', 'tall', 4, 7], ['map.pulse', 'feature', 8, 6], ['inbox.replies', 'medium', 4, 5],
    ['pipeline.flow', 'large', 6, 6], ['campaign.engine', 'medium', 4, 4], ['signals.center', 'small', 4, 3], ['analytics.metric', 'small', 4, 3],
    ['calendar.agenda', 'small', 4, 3], ['machine.feed', 'tall', 4, 7], ['closing.desk', 'medium', 4, 4], ['workflow.runs', 'medium', 4, 4],
    ['email.command', 'medium', 4, 4], ['analytics.metric', 'wide', 8, 3], ['map.pulse', 'medium', 4, 4], ['inbox.replies', 'compact', 3, 2],
  ]
  const ws = []
  let x = 0, y = 0, rowH = 0
  for (const [t, s, w, h] of types.slice(0, n)) {
    if (x + w > 12) { x = 0; y += rowH; rowH = 0 }
    ws.push(inst(t, s, { x, y, w, h }, t === 'analytics.metric' && s === 'wide' ? { metric: 'delivered', period: '30d', display: 'chart' } : t === 'map.pulse' && s === 'medium' ? { lens: 'buyers', range: '30d' } : {}))
    x += w; rowH = Math.max(rowH, h)
  }
  return layoutDoc(`l_dense${n}cap`, `Dense ${n}`, ws)
}

async function open({ W, H, theme, seed, route = '/home' }) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H } })
  await ctx.addInitScript(([t, s]) => {
    try {
      localStorage.removeItem('nexus.desktop.split')
      localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
      const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
      localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
      if (s && !sessionStorage.getItem('hb-seeded')) {
        // seed every operator key the board could use (local dev has no fixed operator)
        for (const k of ['local', ...Object.keys(localStorage).filter((x) => x.startsWith('lc.home.board.v1:')).map((x) => x.slice(17))]) {
          localStorage.setItem(`lc.home.board.v1:${k}`, JSON.stringify({ v: 1, activeId: s.id, layouts: [s], synced: [] }))
        }
        sessionStorage.setItem('hb-seeded', '1')
      }
    } catch { /* ignore */ }
  }, [theme, seed ?? null])
  const page = await ctx.newPage()
  const blocked = []; const errors = []; const net = []
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
  page.on('console', (m) => { if (m.type() === 'error' && !/ResizeObserver|favicon|ERR_ABORTED|Failed to load resource|net::ERR_FAILED/i.test(m.text())) errors.push(m.text().slice(0, 200)) })
  page.on('request', (q) => { const u = new URL(q.url()); if (u.pathname.startsWith('/api/')) net.push(`${q.method()} ${u.pathname}`) })
  await page.route('**/*', (r) => {
    const req = r.request(); const u = new URL(req.url()); const m = req.method()
    const guarded = u.pathname.startsWith('/api/') || /supabase\.co$/.test(u.hostname)
    if (!guarded || ['GET', 'HEAD', 'OPTIONS'].includes(m)) return r.continue()
    blocked.push(`${m} ${u.hostname}${u.pathname}`)
    return r.abort()
  })
  const t0 = Date.now()
  await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.hb .hb-w', { timeout: 90000 })
  // seeding happened before the app knew its operator key: if the board booted on another key, write and reload once
  if (seed) {
    const ok = await page.evaluate((id) => Object.keys(localStorage).some((k) => k.startsWith('lc.home.board.v1:') && (localStorage.getItem(k) || '').includes(id)), seed.id)
    const active = await page.evaluate(() => document.querySelector('.hb-bar__layout span')?.textContent)
    if (!ok || active !== seed.name) {
      await page.evaluate((s) => { for (const k of Object.keys(localStorage).filter((x) => x.startsWith('lc.home.board.v1:'))) localStorage.setItem(k, JSON.stringify({ v: 1, activeId: s.id, layouts: [s], synced: [] })) }, seed)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector('.hb .hb-w', { timeout: 90000 })
    }
  }
  return { ctx, page, blocked, errors, net, t0 }
}

async function settle(page, ms = 75000) {
  await page.waitForFunction(() => !document.querySelector('.hb .lc-skeleton'), null, { timeout: ms }).catch(() => {})
  await page.waitForTimeout(1500)
}

async function measure(page) {
  return page.evaluate(() => {
    const root = document.querySelector('.hb-scroll')
    const leaves = [...(root?.querySelectorAll('*') ?? [])].filter((el) => el.children.length === 0 && (el.textContent || '').trim())
    const garbage = leaves.map((el) => (el.textContent || '').trim()).filter((t) => /\bNaN\b|\bundefined\b|\[object Object\]|\bInfinity\b|^null$/.test(t)).slice(0, 6)
    const ws = [...document.querySelectorAll('.hb-w')].map((w) => { const r = w.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })
    let overlaps = 0
    for (let i = 0; i < ws.length; i += 1) for (let j = i + 1; j < ws.length; j += 1) { const a = ws[i], b = ws[j]; if (a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1) overlaps += 1 }
    return {
      family: document.querySelector('.hb')?.getAttribute('data-family'),
      widgets: ws.length,
      overlaps,
      overflowX: root ? root.scrollWidth - root.clientWidth : null,
      errors: [...document.querySelectorAll('.hb .lc-error, .hb-err-box, .hb-map__state.is-bad')].map((e) => `${e.textContent.trim().slice(0, 60)} [${e.getAttribute('title') || ''}]`),
      skeletons: document.querySelectorAll('.hb .lc-skeleton').length,
      garbage,
      stats: window.__homeBoard?.stats?.() ?? null,
      firstWidget: (() => { const w = document.querySelector('.hb-w'); return w ? { style: w.getAttribute('style'), rect: Math.round(w.getBoundingClientRect().width), grid: document.querySelector('.hb-grid-wrap')?.clientWidth } : null })(),
      heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    }
  })
}

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('shot', name) }
const want = (k) => !ONLY || ONLY.includes(k)

if (!PERF) {
  // 1 · default (Command preset, fresh device), dark 1440 — then edit mode, library, analytics config
  if (want('default') || want('edit') || want('library') || want('analytics')) {
    const { ctx, page, blocked, errors } = await open({ W: 1440, H: 900, theme: 'dark' })
    await settle(page)
    if (want('default')) { await shot(page, 'default-dark-1440'); console.log(JSON.stringify(await measure(page))) }
    await page.getByRole('button', { name: 'Customize' }).click()
    await page.waitForTimeout(500)
    if (want('edit')) await shot(page, 'edit-mode-dark-1440')
    await page.getByRole('button', { name: 'Add widget' }).first().click()
    await page.waitForSelector('.hb-lib')
    await page.waitForTimeout(500)
    if (want('library')) await shot(page, 'library-dark-1440')
    if (want('analytics')) {
      await page.locator('.hb-lib__card', { hasText: 'Analytics' }).getByRole('button', { name: 'Add' }).click()
      await page.getByRole('button', { name: 'Close the library' }).click()
      await page.waitForTimeout(800)
      const ana = page.locator('.hb-w', { hasText: 'Analytics' }).last()
      await ana.scrollIntoViewIfNeeded()
      await settle(page, 30000)
      await ana.getByRole('button', { name: 'Analytics settings' }).click()
      await page.waitForTimeout(700)
      await shot(page, 'analytics-config-dark-1440')
    }
    console.log(JSON.stringify({ tag: 'default', blocked, errors: errors.slice(0, 6) }))
    await ctx.close()
  }
  // 2 · Map and Inbox sizes + Campaign large
  if (want('sizes')) {
    const { ctx, page, blocked, errors } = await open({ W: 1440, H: 1300, theme: 'dark', seed: SIZES_LAYOUT() })
    await settle(page)
    await shot(page, 'map-inbox-sizes-dark-1440')
    await page.evaluate(() => { const r = document.querySelector('.hb-scroll'); if (r) r.scrollTop = 99999 })
    await page.waitForTimeout(800)
    await shot(page, 'inbox-campaign-sizes-dark-1440')
    console.log(JSON.stringify({ tag: 'sizes', ...(await measure(page)), blocked, errors: errors.slice(0, 6) }))
    await ctx.close()
  }
  // 3 · dense ultrawide command wall
  if (want('ultrawide')) {
    const { ctx, page, blocked, errors } = await open({ W: 5120, H: 1440, theme: 'dark', seed: DENSE(16) })
    await settle(page, 60000)
    await shot(page, 'dense-ultrawide-5120')
    console.log(JSON.stringify({ tag: 'ultrawide', ...(await measure(page)), blocked, errors: errors.slice(0, 6) }))
    await ctx.close()
  }
  // 4 · minimal preset, true black, light, 1280 reflow, 1920
  for (const [k, W, H, theme, route] of [['minimal', 1440, 900, 'dark', '/home?home=preset&preset=minimal'], ['trueblack', 1440, 900, 'true_black', '/home'], ['light', 1440, 900, 'light', '/home'], ['w1280', 1280, 800, 'dark', '/home'], ['w1920', 1920, 1080, 'dark', '/home'], ['redops', 1440, 900, 'red_ops', '/home']]) {
    if (!want(k)) continue
    const { ctx, page, blocked, errors } = await open({ W, H, theme, route })
    await settle(page)
    await shot(page, `${k}-${theme}-${W}`)
    console.log(JSON.stringify({ tag: k, ...(await measure(page)), blocked: blocked.filter((b) => !/home\/layouts/.test(b)), errors: errors.slice(0, 6) }))
    await ctx.close()
  }
} else {
  // PERFORMANCE · 4 / 8 / 12 / 16 widgets at 1920: first settle, API requests, heap, drag frame times
  for (const n of arg('n', '4,8,12,16').split(',').map(Number)) {
    const { ctx, page, net, t0 } = await open({ W: 1920, H: 1080, theme: 'dark', seed: DENSE(n) })
    const tReady = Date.now()
    await settle(page, 60000)
    const settled = Date.now()
    const m = await measure(page)
    const apiFirst20 = net.length
    // drag the first widget across the board: 40 pointer moves, measure frame gaps
    await page.getByRole('button', { name: 'Customize' }).click()
    await page.waitForTimeout(400)
    // idle baseline: the same frame probe with nothing moving
    const idle = await page.evaluate(() => new Promise((res) => { const f = []; let last = performance.now(); const tick = (t) => { f.push(t - last); last = t; if (f.length < 60) requestAnimationFrame(tick); else res(f.slice(2)) }; requestAnimationFrame(tick) }))
    const idleSorted = [...idle].sort((a, b) => a - b)
    const idleP50 = Math.round(idleSorted[Math.floor(idleSorted.length / 2)] * 10) / 10
    // JS cost of one pointer move through the drag system (synthetic events, no paint)
    const bar = page.locator('.hb-w .hb-w__bar').first()
    const box = await bar.boundingBox()
    await page.evaluate(() => { window.__frames = []; let last = performance.now(); const tick = (t) => { window.__frames.push(t - last); last = t; if (window.__frames.length < 400) requestAnimationFrame(tick) }; requestAnimationFrame(tick) })
    const td = Date.now()
    await page.mouse.move(box.x + 40, box.y + 12)
    await page.mouse.down()
    for (let i = 0; i < 40; i += 1) { await page.mouse.move(box.x + 40 + i * 18, box.y + 12 + i * 9); await page.waitForTimeout(16) }
    await page.mouse.up()
    const dragMs = Date.now() - td
    await page.waitForTimeout(400)
    const frames = await page.evaluate(() => window.__frames.slice(2))
    const moves = await page.evaluate(() => window.__homeBoard?.dragMoves?.() ?? [])
    const ms = [...moves].sort((a, b) => a - b)
    const moveP50 = ms.length ? Math.round(ms[Math.floor(ms.length / 2)] * 10) / 10 : null
    const moveP95 = ms.length ? Math.round(ms[Math.floor(ms.length * 0.95)] * 10) / 10 : null
    const sorted = [...frames].sort((a, b) => a - b)
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? null
    const long = frames.filter((f) => f > 50).length
    // network after 40 s idle (cadence check)
    const before = net.length
    await page.waitForTimeout(40000)
    console.log(JSON.stringify({ n, firstWidgetMs: tReady - t0, settledMs: settled - t0, widgets: m.widgets, overlaps: m.overlaps, apiRequestsToSettle: apiFirst20, apiRequestsNext40s: net.length - before, heapMB: m.heapMB, sourceStats: m.stats, idleFrameP50Ms: idleP50, drag: { moves: moves.length, moveToCommitP50Ms: moveP50, moveToCommitP95Ms: moveP95, ms: dragMs, frames: frames.length, p95FrameMs: p95 && Math.round(p95 * 10) / 10, longFrames: long }, errors: m.errors.length }))
    await ctx.close()
  }
}

clearTimeout(watchdog)
await browser.close()
