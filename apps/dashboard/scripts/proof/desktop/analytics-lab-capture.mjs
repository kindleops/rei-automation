import { chromium } from 'playwright'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * ANALYTICS LAB — desktop capture (READ ONLY: every non-GET /api request is
 * aborted and counted; nothing can write).
 *
 * The local API is shared by many agents and answers slowly, so the Lab's own
 * GET responses are recorded ONCE from the live API (long timeout, one at a
 * time) and then replayed for every size / theme / pane. Matching is semantic:
 * path + query with the base64url `ctx` decoded and key-sorted, so the same
 * analytical context always hits the same recorded response. Responses with
 * status <= 0 (aborted / failed) are never stored.
 *
 *   node scripts/proof/desktop/analytics-lab-capture.mjs --phase=warm     (visit every mode; record)
 *   node scripts/proof/desktop/analytics-lab-capture.mjs --phase=replay   (captures from the recording)
 *   node scripts/proof/desktop/analytics-lab-capture.mjs --phase=replay --only=overview-dark-1440
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/analytics-lab'))
const STORE = path.join(OUT, 'responses')
const PHASE = arg('phase', 'replay')
const ONLY = arg('only', '')
const TZ = 'America/Chicago'
await fs.mkdir(STORE, { recursive: true })

const stable = (v) => (Array.isArray(v) ? `[${v.map(stable).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v ?? null))
function semanticKey(url) {
  const u = new URL(url)
  const parts = [...u.searchParams.entries()].map(([k, v]) => {
    if (k === 'ctx' || k === 'cohort') { try { return [k, stable(JSON.parse(Buffer.from(v, 'base64url').toString('utf8')))] } catch { return [k, v] } }
    return [k, v]
  }).sort((a, b) => a[0].localeCompare(b[0]))
  return crypto.createHash('sha1').update(`${u.pathname}?${JSON.stringify(parts)}`).digest('hex')
}
const stats = { served: 0, recorded: 0, liveFailures: 0, blocked: [] }
const inflight = new Map()
let lastLabRequest = Date.now()
/** Settled = no Lab request in flight and none started for `quiet` ms (the shell's own polling is ignored). */
async function labSettled(quiet = 4000, max = 360_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < max) {
    if (inflight.size === 0 && Date.now() - lastLabRequest > quiet) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}
async function liveFetch(url) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), 330_000)
  try {
    const res = await fetch(url, { signal: ctl.signal })
    const body = await res.text()
    return { status: res.status, body, contentType: res.headers.get('content-type') || 'application/json' }
  } finally { clearTimeout(t) }
}
async function serveLab(route) {
  lastLabRequest = Date.now()
  const url = route.request().url()
  const key = semanticKey(url)
  const file = path.join(STORE, `${key}.json`)
  let rec = null
  try { rec = JSON.parse(await fs.readFile(file, 'utf8')) } catch { /* not recorded yet */ }
  if (!rec) {
    if (PHASE === 'replay-strict') return route.fulfill({ status: 504, body: '{"ok":false,"error":"not_recorded"}', contentType: 'application/json' })
    if (!inflight.has(key)) inflight.set(key, liveFetch(`${BASE}${new URL(url).pathname}${new URL(url).search}`).finally(() => inflight.delete(key)))
    try {
      const r = await inflight.get(key)
      if (r.status > 0 && r.status < 500) {
        await fs.writeFile(file, JSON.stringify({ url: new URL(url).pathname + new URL(url).search.slice(0, 120), recordedAt: new Date().toISOString(), ...r }))
        stats.recorded += 1
      }
      rec = r
    } catch (e) { stats.liveFailures += 1; return route.abort().catch(() => {}) }
  }
  stats.served += 1
  return route.fulfill({ status: rec.status, body: rec.body, contentType: rec.contentType }).catch(() => {})
}

async function context(browser, { width, height, theme, split = null }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, timezoneId: TZ })
  await ctx.addInitScript(({ t, s }) => {
    try {
      localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
      if (s) localStorage.setItem('nexus.desktop.split', JSON.stringify(s)); else localStorage.removeItem('nexus.desktop.split')
      localStorage.removeItem('anx:lab:ctx:v1')
      const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
      localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
    } catch { /* ignore */ }
  }, { t: theme, s: split })
  await ctx.route('**/api/**', async (route) => {
    const req = route.request()
    const m = req.method()
    if (!['GET', 'OPTIONS', 'HEAD'].includes(m)) { stats.blocked.push(`${m} ${new URL(req.url()).pathname}`); return route.abort() }
    // Every GET is fetched live ONCE and replayed after that: the shell's polling
    // must not keep hitting a production database that is already saturated.
    if (m === 'GET') return serveLab(route)
    return route.fallback()
  })
  // The shell's direct PostgREST reads (inbox counters) are not part of this
  // proof and were measured saturating production; they are not issued at all.
  await ctx.route(/supabase\.co\/rest\/v1\//, (route) => { stats.supabaseAborted = (stats.supabaseAborted || 0) + 1; return route.abort() })
  return ctx
}

const labUrl = (mode, extra = {}) => {
  const c = { v: 1, tz: TZ, mode, metric: 'reply_rate', groupBy: null, filters: [], segment: [], range: { preset: '30d' }, compare: { mode: 'previous' }, grain: 'auto', ...extra }
  return `${BASE}/analytics?lab=${Buffer.from(JSON.stringify(c)).toString('base64url')}`
}
async function settle(page, timeout = 120_000) {
  await page.waitForSelector('.alab', { timeout: 180_000 })
  await page.waitForFunction(() => !document.querySelector('.alab-boot') && !document.querySelector('.alab.is-refreshing') && ![...document.querySelectorAll('.lab-note')].some((n) => /^Reading/.test(n.textContent || '')), null, { timeout }).catch(() => {})
  await page.waitForTimeout(1200)
}
function measure() {
  const root = document.querySelector('.alab')
  const txt = root?.textContent || ''
  const leaves = root ? [...root.querySelectorAll('*')].filter((e) => e.children.length === 0 && (e.textContent || '').trim()) : []
  const tiny = new Set()
  for (const el of leaves) { const f = parseFloat(getComputedStyle(el).fontSize); if (f && f < 10 && el.getClientRects().length) tiny.add(`${f}px:${el.textContent.trim().slice(0, 20)}`) }
  const main = document.querySelector('.alab__main')
  return {
    garbage: (txt.match(/\bNaN\b|\bundefined\b|\[object Object\]|Infinity/g) || []).slice(0, 5),
    overflowX: main ? main.scrollWidth - main.clientWidth : null,
    tiny: [...tiny].slice(0, 6),
    error: /couldn’t load|BACKEND_TIMEOUT/.test(txt),
    crashed: /Something went wrong|crashed/i.test(document.body.textContent || ''),
  }
}

const browser = await chromium.launch()
const report = { phase: PHASE, captures: [] }

if (PHASE === 'warm') {
  const ctx = await context(browser, { width: 1440, height: 900, theme: 'dark' })
  const page = await ctx.newPage()
  for (const mode of ['overview', 'acquisition', 'pipeline', 'campaigns', 'communications', 'geography', 'automation', 'buyers']) {
    const t0 = Date.now()
    await page.goto(labUrl(mode), { waitUntil: 'domcontentloaded', timeout: 180_000 })
    await page.waitForSelector('.alab', { timeout: 180_000 }).catch(() => {})
    await labSettled(5000)
    console.log('warm', mode.padEnd(16), `${Date.now() - t0} ms`, JSON.stringify({ recorded: stats.recorded, failures: stats.liveFailures }))
  }
  // the interactive states: inspector + records (numerator and denominator of the reply rate)
  await page.goto(labUrl('overview'), { waitUntil: 'domcontentloaded' })
  await settle(page)
  if (await page.locator('.lab-kpi').count()) {
    await page.locator('.lab-kpi').nth(1).click()
    await page.waitForSelector('.lab-insp', { timeout: 60_000 }).catch(() => {})
    for (const i of [0, 1]) {
      await page.locator('.lab-insp__ops button').nth(i).click().catch(() => {})
      await labSettled(4000)
      await page.keyboard.press('Escape').catch(() => {})
      await page.waitForTimeout(500)
    }
  }
  await ctx.close()
  console.log('warm done', JSON.stringify(stats))
} else {
  const shots = [
    { id: 'overview-dark-1440', w: 1440, h: 900, theme: 'dark', mode: 'overview', full: true },
    { id: 'overview-light-1440', w: 1440, h: 900, theme: 'light', mode: 'overview', full: true },
    { id: 'overview-dark-1920', w: 1920, h: 1080, theme: 'dark', mode: 'overview', full: true },
    { id: 'overview-dark-1440-fold', w: 1440, h: 900, theme: 'dark', mode: 'overview' },
    { id: 'overview-dark-1440-inspector', w: 1440, h: 900, theme: 'dark', mode: 'overview', inspect: true },
    { id: 'overview-dark-1440-records', w: 1440, h: 900, theme: 'dark', mode: 'overview', records: true },
    { id: 'overview-dark-half-pane', w: 1920, h: 1080, theme: 'dark', mode: 'overview', split: { panes: [{ id: 'p-cal', path: '/calendar' }], sizes: [0.5, 0.5], focused: 'main' } },
    { id: 'overview-true-black-1512', w: 1512, h: 945, theme: 'true_black', mode: 'overview' },
    { id: 'overview-dark-1280', w: 1280, h: 800, theme: 'dark', mode: 'overview' },
    { id: 'overview-light-2560-ultrawide', w: 2560, h: 1080, theme: 'light', mode: 'overview' },
    { id: 'acquisition-dark-1440', w: 1440, h: 900, theme: 'dark', mode: 'acquisition', full: true },
    { id: 'pipeline-dark-1440', w: 1440, h: 900, theme: 'dark', mode: 'pipeline', full: true },
    { id: 'campaigns-dark-1728', w: 1728, h: 1117, theme: 'dark', mode: 'campaigns', full: true },
    { id: 'communications-dark-1440', w: 1440, h: 900, theme: 'dark', mode: 'communications', full: true },
    { id: 'geography-dark-1920', w: 1920, h: 1080, theme: 'dark', mode: 'geography' },
    { id: 'automation-light-1440', w: 1440, h: 900, theme: 'light', mode: 'automation', full: true },
    { id: 'buyers-dark-1440', w: 1440, h: 900, theme: 'dark', mode: 'buyers' },
  ].filter((s) => !ONLY || ONLY.split(',').includes(s.id))
  for (const s of shots) {
    const ctx = await context(browser, { width: s.w, height: s.h, theme: s.theme, split: s.split || null })
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
    try {
      await page.goto(labUrl(s.mode), { waitUntil: 'domcontentloaded', timeout: 180_000 })
      await settle(page)
      if (s.mode === 'geography') await page.waitForTimeout(4000) // basemap tiles
      if (s.inspect || s.records) {
        await page.locator('.lab-kpi').nth(1).click()
        await page.waitForSelector('.lab-insp', { timeout: 60_000 })
        await page.waitForTimeout(600)
      }
      if (s.records) {
        await page.locator('.lab-insp__ops button').first().click()
        await page.waitForSelector('.lab-rec__row:not(.is-head)', { timeout: 120_000 }).catch(() => {})
        await page.waitForTimeout(800)
      }
      if (s.full) {
        const h = await page.evaluate(() => { const m = document.querySelector('.alab__main'); return m ? m.scrollHeight : 0 })
        await page.setViewportSize({ width: s.w, height: Math.min(Math.max(s.h, h + 150), 7000) })
        await page.waitForTimeout(1000)
      }
      const file = `${OUT}/${s.id}.png`
      await page.screenshot({ path: file })
      const m = await page.evaluate(measure)
      report.captures.push({ id: s.id, file, ...m, errors })
      const flag = m.garbage.length || m.crashed || m.error || (m.overflowX ?? 0) > 1
      console.log(s.id.padEnd(32), flag ? `FLAG ${JSON.stringify(m)}` : 'ok', errors.length ? `pageerrors ${errors.length}: ${errors[0]}` : '')
    } catch (e) {
      report.captures.push({ id: s.id, fail: String(e.message).slice(0, 200), errors })
      console.log(s.id.padEnd(32), 'FAIL', String(e.message).slice(0, 140))
    }
    await ctx.close()
  }
}
report.stats = stats
await fs.writeFile(path.join(OUT, `report-${PHASE}.json`), JSON.stringify(report, null, 2))
console.log('stats', JSON.stringify({ served: stats.served, recorded: stats.recorded, liveFailures: stats.liveFailures, blockedWrites: stats.blocked.length }))
await browser.close()
