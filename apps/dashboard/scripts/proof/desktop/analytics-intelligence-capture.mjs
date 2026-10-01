import { chromium } from 'playwright'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * ANALYTICS 4.0 · INTELLIGENCE LAB — desktop capture (READ ONLY).
 *
 * Every non-GET to /api or Supabase is aborted and counted; the shell's direct
 * PostgREST reads are not issued at all. The local API reads PRODUCTION and is
 * shared by many agents, so the Lab's GETs are recorded ONCE (phase=warm, long
 * timeout, one browser) and every theme / width / state is replayed from the
 * recording (phase=replay). Matching is semantic: path + query with the
 * base64url `ctx` / `cohort` decoded and key-sorted.
 *
 *   node scripts/proof/desktop/analytics-intelligence-capture.mjs --phase=warm   --out=<dir>
 *   node scripts/proof/desktop/analytics-intelligence-capture.mjs --phase=replay --out=<dir> [--only=a,b]
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/analytics-intelligence'))
const STORE = path.join(OUT, 'responses')
const PHASE = arg('phase', 'replay')
const ONLY = arg('only', '')
const TZ = 'America/Chicago'
await fs.mkdir(STORE, { recursive: true })

// watchdog: a capture never hangs an agent
const WATCHDOG_MS = Number(arg('watchdog', PHASE === 'warm' ? 40 * 60_000 : 20 * 60_000))
const watchdog = setTimeout(() => { console.log('WATCHDOG — exiting'); process.exit(2) }, WATCHDOG_MS)

const stable = (v) => (Array.isArray(v) ? `[${v.map(stable).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v ?? null))
function semanticKey(url) {
  const u = new URL(url)
  const parts = [...u.searchParams.entries()].map(([k, v]) => {
    if (k === 'ctx' || k === 'cohort') { try { return [k, stable(JSON.parse(Buffer.from(v, 'base64url').toString('utf8')))] } catch { return [k, v] } }
    return [k, v]
  }).sort((a, b) => a[0].localeCompare(b[0]))
  return crypto.createHash('sha1').update(`${u.pathname}?${JSON.stringify(parts)}`).digest('hex')
}
const stats = { served: 0, recorded: 0, missing: 0, liveFailures: 0, blocked: [] }
const inflight = new Map()
let lastLab = Date.now()
const isLab = (u) => u.pathname.startsWith('/api/cockpit/analytics/')
async function quiet(ms = 4000, max = 420_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < max) {
    if (inflight.size === 0 && Date.now() - lastLab > ms) return true
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}
async function liveFetch(url) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), 360_000)
  try {
    const res = await fetch(url, { signal: ctl.signal })
    return { status: res.status, body: await res.text(), contentType: res.headers.get('content-type') || 'application/json' }
  } finally { clearTimeout(t) }
}
async function serve(route) {
  const url = route.request().url()
  const u = new URL(url)
  if (isLab(u)) lastLab = Date.now()
  const key = semanticKey(url)
  const file = path.join(STORE, `${key}.json`)
  let rec = null
  try { rec = JSON.parse(await fs.readFile(file, 'utf8')) } catch { /* not recorded */ }
  if (!rec) {
    if (PHASE === 'replay' && isLab(u)) { stats.missing += 1; return route.fulfill({ status: 504, body: '{"ok":false,"error":"not_recorded"}', contentType: 'application/json' }) }
    if (!inflight.has(key)) inflight.set(key, liveFetch(`${BASE}${u.pathname}${u.search}`).finally(() => inflight.delete(key)))
    try {
      const r = await inflight.get(key)
      if (r.status > 0 && r.status < 500) { await fs.writeFile(file, JSON.stringify({ url: (u.pathname + u.search).slice(0, 160), recordedAt: new Date().toISOString(), ...r })); stats.recorded += 1 }
      rec = r
    } catch { stats.liveFailures += 1; return route.abort().catch(() => {}) }
  }
  stats.served += 1
  return route.fulfill({ status: rec.status, body: rec.body, contentType: rec.contentType }).catch(() => {})
}

async function context(browser, { width, height, theme, split = null, reduced = false }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, timezoneId: TZ, reducedMotion: reduced ? 'reduce' : 'no-preference' })
  await ctx.addInitScript(({ t, s }) => {
    try {
      localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
      // Shell 6.0 workspace: Analytics in the left pane at the given share, another app beside it
      if (s) {
        const layout = {
          root: { kind: 'split', id: 'sx', dir: 'row', children: [{ kind: 'pane', id: 'pa', tabs: ['ia'], active: 'ia' }, { kind: 'pane', id: 'pb', tabs: ['ib'], active: 'ib' }], sizes: s.sizes },
          instances: { ia: { id: 'ia', app: 'analytics', path: location.pathname + location.search, pinned: false }, ib: { id: 'ib', app: s.other.app, path: s.other.path, pinned: false } },
          focus: 'pa', primary: 'ia', maximized: null,
        }
        sessionStorage.setItem('lc.workspace.session.v1', JSON.stringify({ layout, linked: true, name: null, savedId: null, dirty: false }))
      } else sessionStorage.removeItem('lc.workspace.session.v1')
      localStorage.removeItem('anx:intel:ctx:v1')
      const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
      localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
    } catch { /* ignore */ }
  }, { t: theme, s: split })
  // the request guard: nothing but GET / HEAD / OPTIONS reaches /api or Supabase
  await ctx.route('**/*', async (route) => {
    const req = route.request()
    const u = new URL(req.url())
    const m = req.method()
    const api = u.pathname.startsWith('/api/')
    const supa = /supabase\.co$/.test(u.hostname)
    if ((api || supa) && !['GET', 'HEAD', 'OPTIONS'].includes(m)) { stats.blocked.push(`${m} ${u.pathname}`); return route.abort() }
    if (supa && /\/rest\/v1\//.test(u.pathname)) return route.abort() // the shell's direct PostgREST counters are not part of this proof
    if (api && m === 'GET') return serve(route)
    return route.continue()
  })
  return ctx
}

const labUrl = (over = {}) => {
  const c = { v: 1, tz: TZ, lens: 'overview', metric: 'reply_rate', groupBy: null, view: 'line', filters: [], segment: [], range: { preset: '30d' }, compare: { mode: 'previous' }, grain: 'auto', ...over }
  return `${BASE}/analytics?lab=${Buffer.from(JSON.stringify(c)).toString('base64url')}`
}
async function settle(page, ms = 2500) {
  await page.waitForSelector('.ix', { timeout: 240_000 })
  await page.waitForFunction(() => document.querySelector('.ix-bar') && !document.querySelector('.ix__boot'), null, { timeout: 300_000 }).catch(() => {})
  await quiet(PHASE === 'warm' ? 5000 : 1200, PHASE === 'warm' ? 420_000 : 60_000)
  await page.waitForTimeout(ms)
}
function measure() {
  const root = document.querySelector('.ix')
  const txt = root?.textContent || ''
  const canvas = document.querySelector('.ix__canvas')
  const tiny = new Set()
  if (root) for (const el of root.querySelectorAll('*')) { if (el.children.length || !(el.textContent || '').trim()) continue; const f = parseFloat(getComputedStyle(el).fontSize); if (f && f < 10 && el.getClientRects().length) tiny.add(`${f}px:${el.textContent.trim().slice(0, 18)}`) }
  return {
    garbage: (txt.match(/\bNaN\b|\bundefined\b|\[object Object\]|Infinity/g) || []).slice(0, 5),
    overflowX: canvas ? canvas.scrollWidth - canvas.clientWidth : null,
    rootOverflowX: root ? root.scrollWidth - root.clientWidth : null,
    tiny: [...tiny].slice(0, 8),
    errors: [...document.querySelectorAll('.lc-error, .ix-note.is-bad')].map((e) => (e.textContent || '').slice(0, 90)).slice(0, 5),
  }
}

const browser = await chromium.launch()
const report = { phase: PHASE, captures: [] }

async function interact(page, step) {
  if (!step) return
  if (step === 'scrub') {
    const plot = page.locator('.ix-hero .ixt__plot').first()
    const box = await plot.boundingBox()
    if (box) { await page.mouse.move(box.x + box.width * 0.72, box.y + box.height * 0.6); await page.waitForTimeout(400); await page.mouse.move(box.x + box.width * 0.74, box.y + box.height * 0.6) }
    await quiet(1500, PHASE === 'warm' ? 240_000 : 30_000)
    await page.waitForTimeout(900)
  }
  if (step === 'inspect') {
    await page.locator('.ix-hero__name').first().click()
    await page.waitForSelector('.lc-insp', { timeout: 60_000 })
    await quiet(1500, PHASE === 'warm' ? 240_000 : 30_000)
    await page.waitForTimeout(900)
  }
  if (step === 'records') {
    await page.locator('.ix-funnel__stage').nth(1).locator('.ix-mini').first().click()
    await page.waitForSelector('.ix-rec', { timeout: 60_000 })
    await quiet(1500, PHASE === 'warm' ? 300_000 : 30_000)
    await page.waitForTimeout(1200)
  }
  if (step === 'stage') {
    await page.locator('.ix-stagecol.is-hot, .ix-stagecol').first().click()
    await page.waitForSelector('.lc-insp', { timeout: 60_000 })
    await quiet(1500, PHASE === 'warm' ? 240_000 : 30_000)
    await page.waitForTimeout(900)
  }
  if (step === 'filters') {
    await page.locator('.ix-bar__controls button', { hasText: 'Filter' }).first().click()
    await page.waitForSelector('.lc-insp', { timeout: 60_000 })
    await page.waitForTimeout(900)
  }
  if (step === 'pins') {
    await page.locator('.ix-hero .ixt__pin.is-many, .ix-hero .ixt__pin').first().click()
    await page.waitForSelector('.lc-insp', { timeout: 60_000 })
    await page.waitForTimeout(900)
  }
  if (step === 'explorer') {
    await page.locator('.ix-bar__controls button', { hasText: 'Metrics' }).first().click()
    await page.waitForSelector('.ix-explorer', { timeout: 30_000 })
    await page.waitForTimeout(700)
  }
}

const SHOTS = [
  // themes × widths (rules: Dark / Light / True Black / Red Ops at 1280, 1440, 1920 + one 5120×1440)
  ...['dark', 'light', 'true_black', 'red_ops'].flatMap((theme) => [1280, 1440, 1920].map((w) => ({ id: `overview-${theme}-${w}`, w, h: w === 1920 ? 1080 : w === 1440 ? 900 : 800, theme, ctx: {} }))),
  { id: 'overview-dark-1440-full', w: 1440, h: 900, theme: 'dark', ctx: {}, full: true },
  { id: 'overview-light-1920-full', w: 1920, h: 1080, theme: 'light', ctx: {}, full: true },
  { id: 'overview-light-1440-full', w: 1440, h: 900, theme: 'light', ctx: {}, full: true },
  { id: 'events-group-dark-1440', w: 1440, h: 900, theme: 'dark', ctx: {}, step: 'pins' },
  { id: 'overview-dark-5120x1440', w: 5120, h: 1440, theme: 'dark', ctx: {} },
  { id: 'overview-90d-dark-1440', w: 1440, h: 900, theme: 'dark', ctx: { range: { preset: '90d' } } },
  { id: 'overview-dark-1512', w: 1512, h: 945, theme: 'dark', ctx: {} },
  { id: 'overview-dark-1728', w: 1728, h: 1117, theme: 'dark', ctx: {} },
  // lenses
  ...['acquisition', 'pipeline', 'campaigns', 'communications', 'geography', 'automation', 'financial', 'buyers', 'growth'].map((lens) => ({ id: `lens-${lens}-dark-1440`, w: 1440, h: 900, theme: 'dark', ctx: { lens }, full: true })),
  { id: 'lens-financial-light-1440', w: 1440, h: 900, theme: 'light', ctx: { lens: 'financial' }, full: true },
  { id: 'lens-communications-red_ops-1440', w: 1440, h: 900, theme: 'red_ops', ctx: { lens: 'communications' }, full: true },
  // the slice and the journeys
  { id: 'filtered-miami-dark-1440', w: 1440, h: 900, theme: 'dark', ctx: { segment: [{ dim: 'market', value: 'miami-fl', label: 'Miami, FL' }] }, full: true },
  { id: 'cohort-replied-dark-1440', w: 1440, h: 900, theme: 'dark', ctx: { segment: [{ dim: 'cohort', value: 'replied', label: 'Replied sellers' }] } },
  { id: 'compare-week-dark-1440', w: 1440, h: 900, theme: 'dark', ctx: { compare: { mode: 'week' }, metric: 'delivery_rate' } },
  { id: 'scrub-dark-1440', w: 1440, h: 900, theme: 'dark', ctx: {}, step: 'scrub' },
  { id: 'drilldown-reply-rate-dark-1440', w: 1440, h: 900, theme: 'dark', ctx: {}, step: 'inspect' },
  { id: 'drilldown-reply-rate-light-1440', w: 1440, h: 900, theme: 'light', ctx: {}, step: 'inspect' },
  { id: 'records-grid-dark-1440', w: 1440, h: 900, theme: 'dark', ctx: {}, step: 'records' },
  { id: 'stage-inspector-dark-1920', w: 1920, h: 1080, theme: 'dark', ctx: { lens: 'pipeline' }, step: 'stage' },
  { id: 'filters-inspector-dark-1440', w: 1440, h: 900, theme: 'dark', ctx: {}, step: 'filters' },
  { id: 'explorer-dark-1440', w: 1440, h: 900, theme: 'dark', ctx: {}, step: 'explorer' },
  { id: 'groupby-market-dark-1440', w: 1440, h: 900, theme: 'dark', ctx: { groupBy: 'market' }, full: true },
  { id: 'geo-minnesota-dark-1440', w: 1440, h: 900, theme: 'dark', ctx: { lens: 'geography', segment: [{ dim: 'state', value: 'MN', label: 'Minnesota' }] } },
  // panes (Shell split): a half pane and a ~560 px pane
  { id: 'pane-half-dark-1920', w: 1920, h: 1080, theme: 'dark', ctx: {}, split: { other: { app: 'settings', path: '/settings' }, sizes: [0.5, 0.5] } },
  { id: 'pane-narrow-dark-1920', w: 1920, h: 1080, theme: 'dark', ctx: {}, split: { other: { app: 'settings', path: '/settings' }, sizes: [0.36, 0.64] } },
  { id: 'reduced-motion-dark-1440', w: 1440, h: 900, theme: 'dark', ctx: {}, reduced: true },
].filter((s) => !ONLY || ONLY.split(',').includes(s.id))

if (PHASE === 'warm') {
  // one pass per distinct analytical state; interactions record their reads too
  const seen = new Set()
  for (const s of SHOTS) {
    const k = JSON.stringify([s.ctx, s.step || null])
    if (seen.has(k)) continue
    seen.add(k)
    const ctx = await context(browser, { width: s.w, height: s.h, theme: s.theme, split: s.split || null })
    const page = await ctx.newPage()
    const t0 = Date.now()
    try {
      await page.goto(labUrl(s.ctx), { waitUntil: 'domcontentloaded', timeout: 240_000 })
      await settle(page, 1500)
      if (s.full) { await page.evaluate(() => { const c = document.querySelector('.ix__canvas'); if (c) c.scrollTop = c.scrollHeight }); await quiet(4000, 300_000); await page.evaluate(() => { const c = document.querySelector('.ix__canvas'); if (c) c.scrollTop = 0 }) }
      await interact(page, s.step)
      // overview: scroll through so every lazy section reads
      await page.evaluate(() => { const c = document.querySelector('.ix__canvas'); if (c) c.scrollTop = c.scrollHeight })
      await quiet(4000, 300_000)
      console.log('warm', s.id.padEnd(36), `${Math.round((Date.now() - t0) / 1000)}s`, JSON.stringify({ recorded: stats.recorded, failures: stats.liveFailures }))
    } catch (e) { console.log('warm', s.id, 'FAIL', String(e.message).slice(0, 140)) }
    await ctx.close()
  }
} else {
  for (const s of SHOTS) {
    const ctx = await context(browser, { width: s.w, height: s.h, theme: s.theme, split: s.split || null, reduced: s.reduced })
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
    try {
      await page.goto(labUrl(s.ctx), { waitUntil: 'domcontentloaded', timeout: 180_000 })
      await settle(page)
      await interact(page, s.step)
      if (s.full) {
        const h = await page.evaluate(() => { const c = document.querySelector('.ix__canvas'); return c ? c.scrollHeight + c.getBoundingClientRect().top + 24 : 0 })
        await page.setViewportSize({ width: s.w, height: Math.min(Math.max(s.h, Math.round(h)), 9000) })
        await page.waitForTimeout(1400)
      }
      const file = `${OUT}/${s.id}.png`
      await page.screenshot({ path: file, timeout: s.full ? 180_000 : 60_000 })
      const m = await page.evaluate(measure)
      report.captures.push({ id: s.id, file, ...m, errors })
      const flag = m.garbage.length || (m.overflowX ?? 0) > 1 || (m.rootOverflowX ?? 0) > 1 || errors.length
      console.log(s.id.padEnd(40), flag ? `FLAG ${JSON.stringify({ ...m, errors })}` : 'ok', m.errors.length ? `notes: ${m.errors.join(' | ')}` : '')
    } catch (e) {
      report.captures.push({ id: s.id, fail: String(e.message).slice(0, 200), errors })
      console.log(s.id.padEnd(40), 'FAIL', String(e.message).slice(0, 160))
    }
    await ctx.close()
  }
}
report.stats = { ...stats, blocked: stats.blocked.slice(0, 20), blockedCount: stats.blocked.length }
await fs.writeFile(path.join(OUT, `report-${PHASE}.json`), JSON.stringify(report, null, 2))
console.log('stats', JSON.stringify({ served: stats.served, recorded: stats.recorded, missing: stats.missing, liveFailures: stats.liveFailures, blockedWrites: stats.blocked.length }))
await browser.close()
clearTimeout(watchdog)
