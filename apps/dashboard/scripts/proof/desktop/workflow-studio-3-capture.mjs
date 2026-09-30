import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * WORKFLOW STUDIO 3.0 — desktop capture (READ ONLY).
 *
 *  - every non-GET /api request is ABORTED (and listed);
 *  - observatory + studio GETs are REPLAYED from fixtures recorded by
 *    apps/api/scripts/proof/workflow-observatory-fixtures.mjs (the same
 *    service functions, production data, SELECT only);
 *  - every other API read and every direct Supabase call is cut off, so a
 *    capture puts ZERO load on the production database.
 *
 *   node scripts/proof/desktop/workflow-studio-3-capture.mjs [--only=overview,canvas] [--sizes=1440x900] [--themes=dark]
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', 'artifacts/workflow-studio-3'))
const FIX = JSON.parse(await fs.readFile(path.resolve('artifacts/workflow-studio-3/fixtures.json'), 'utf8')).responses
const ONLY = arg('only', '').split(',').filter(Boolean)
await fs.mkdir(OUT, { recursive: true })

const PLAN = [
  { size: [1440, 900], theme: 'dark', shots: ['overview', 'canvas', 'inspector', 'run', 'runs', 'live', 'activity', 'analytics', 'design'] },
  { size: [1440, 900], theme: 'light', shots: ['overview', 'canvas', 'inspector'] },
  { size: [1440, 900], theme: 'true_black', shots: ['overview', 'canvas', 'inspector'] },
  { size: [1920, 1080], theme: 'dark', shots: ['overview', 'canvas', 'inspector'] },
  { size: [5120, 1440], theme: 'dark', shots: ['overview', 'canvas', 'inspector'] },
].filter((p) => !arg('sizes', '') || arg('sizes', '').split(',').includes(p.size.join('x'))).filter((p) => !arg('themes', '') || arg('themes', '').split(',').includes(p.theme))

const needs = FIX['/api/cockpit/workflow-studio/observatory/needs-you']?.items || []
const heldRun = needs.find((n) => n.workflow_key === 'seller_inbound' && !String(n.run_id).startsWith('queue:'))
const ROUTES = {
  overview: { url: '/workflow-studio', ready: '.ws3-mini__stage' },
  canvas: { url: '/workflow-studio?mode=canvas&wf=seller_inbound', ready: '.ws3-node' },
  inspector: { url: '/workflow-studio?mode=canvas&wf=seller_inbound', ready: '.ws3-node', then: async (page) => { await page.click('[data-node="contactable_now"]'); await page.waitForSelector('.ws3-insp', { timeout: 20000 }) } },
  run: { url: heldRun ? `/workflow-studio?mode=canvas&wf=seller_inbound&run=${heldRun.run_id}` : '/workflow-studio?mode=canvas&wf=seller_inbound', ready: '.ws3-why' },
  runs: { url: '/workflow-studio?mode=runs&wf=seller_inbound', ready: '.ws3-tr:not(.is-head)', then: async (page) => { await page.click('.ws3-tr.is-needs_you, .ws3-tr.is-held'); await page.waitForSelector('.ws3-why', { timeout: 20000 }); await page.waitForTimeout(900) } },
  live: { url: '/workflow-studio?mode=live&wf=seller_inbound', ready: '.ws3-liverow, .ws3-liverail .ws3-quiet' },
  activity: { url: '/workflow-studio?mode=activity', ready: '.ws3-actrow' },
  analytics: { url: '/workflow-studio?mode=analytics&wf=seller_inbound', ready: '.ws3-kpi' },
  design: { url: '/workflow-studio?mode=design&wf=seller_review_escalation', ready: '.ws3-palette li button' },
}

const browser = await chromium.launch()
const blocked = []
const errors = []
const supaBlocked = []
const consoleErrors = []
for (const plan of PLAN) {
  const [W, H] = plan.size
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
  await ctx.addInitScript((t) => {
    try {
      localStorage.removeItem('nexus.desktop.split')
      localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
      const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
      localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
    } catch { /* ignore */ }
  }, plan.theme)
  const page = await ctx.newPage()
  // the dev-only runtime banner is not product UI
  await page.addInitScript(() => { const add = () => { const s = document.createElement('style'); s.textContent = '.nx-dev-runtime-banner{display:none!important}'; (document.head || document.documentElement).appendChild(s) }; if (document.documentElement) add(); else document.addEventListener('DOMContentLoaded', add) })
  page.on('pageerror', (e) => errors.push(`${plan.theme}-${W}: ${String(e.message).slice(0, 200)}`))
  // only real API paths — a Vite module such as /src/lib/api/backendClient.ts must load normally
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const req = route.request()
    const u = new URL(req.url())
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method())) { blocked.push(`${req.method()} ${u.pathname}`); return route.abort() }
    const key = `${u.pathname}${u.search}`
    const hit = FIX[key] ?? FIX[u.pathname]
    if (u.pathname.startsWith('/api/cockpit/workflow-studio')) {
      if (hit) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(hit) })
      // a studio read not recorded: answer 404 (the surface must show a calm error), never hang the capture
      return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'not_recorded' }) })
    }
    // ZERO production load: every other API read (shell chrome, inbox counts…) is answered locally as unavailable
    return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'capture_offline' }) })
  })
  // …and the browser never reads Supabase data directly (REST, realtime, storage, functions)
  // during a capture. Only the session check (/auth/v1) may pass, so the app can mount.
  await page.route(/supabase\.co\/(rest|realtime|storage|functions|graphql)\//, (route) => { supaBlocked.push(new URL(route.request().url()).pathname); return route.abort() })
  if (page.routeWebSocket) await page.routeWebSocket(/supabase\.co/, (ws) => ws.close())
  page.on('console', (m) => { if (m.type() === 'error' && consoleErrors.length < 12) consoleErrors.push(m.text().slice(0, 200)) })
  for (const shot of plan.shots) {
    if (ONLY.length && !ONLY.includes(shot)) continue
    const r = ROUTES[shot]
    const tag = `${plan.theme}-${W}x${H}-${shot}`
    try {
      await page.goto(`${BASE}${r.url}`, { waitUntil: 'domcontentloaded', timeout: 180000 })
      await page.waitForSelector(r.ready, { timeout: 120000 })
      if (r.then) await r.then(page)
      await page.waitForTimeout(1600)
      await page.screenshot({ path: `${OUT}/${tag}.png` })
      const m = await page.evaluate(() => {
        const root = document.querySelector('.ws3')
        const leaves = root ? [...root.querySelectorAll('*')].filter((el) => el.children.length === 0 && (el.textContent || '').trim()) : []
        const garbage = leaves.map((el) => (el.textContent || '').trim()).filter((t) => /\bNaN\b|\bundefined\b|\[object Object\]|\bInfinity\b|^null$/.test(t)).slice(0, 5)
        return { garbage, nodes: document.querySelectorAll('.ws3-node').length, overflowX: document.documentElement.scrollWidth - innerWidth }
      })
      console.log(tag.padEnd(40), `nodes=${m.nodes}`, m.garbage.length ? `GARBAGE ${m.garbage.join('|')}` : 'clean', m.overflowX > 0 ? `overflowX=${m.overflowX}` : '')
    } catch (e) {
      console.log(tag.padEnd(40), 'FAIL', String(e.message).slice(0, 140))
      await page.screenshot({ path: `${OUT}/${tag}-FAIL.png` }).catch(() => {})
    }
  }
  await ctx.close()
}
await browser.close()
console.log(`blocked writes: ${blocked.length ? [...new Set(blocked)].join(', ') : 'none'}`)
console.log(`supabase data reads blocked: ${supaBlocked.length} (${[...new Set(supaBlocked)].slice(0, 6).join(', ')})`)
if (consoleErrors.length) console.log('console errors (first):', [...new Set(consoleErrors)].slice(0, 5))
if (errors.length) console.log('page errors:', [...new Set(errors)].slice(0, 8))
