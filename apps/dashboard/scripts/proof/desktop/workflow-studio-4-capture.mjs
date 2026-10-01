import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
/**
 * WORKFLOW STUDIO 4.0 — desktop capture (READ ONLY).
 *
 *  - every non-GET to /api or Supabase is ABORTED (and listed), except the
 *    studio's PURE simulation, which is answered here from the recorded
 *    response and never reaches a server;
 *  - studio / observatory GETs are REPLAYED from fixtures recorded by
 *    apps/api/scripts/proof/workflow-studio-4-fixtures.mjs (same service
 *    functions, production data, SELECT only) — zero production load;
 *  - every other API read is answered locally as unavailable; direct Supabase
 *    data reads are cut off (only the session check passes).
 *
 *   node scripts/proof/desktop/workflow-studio-4-capture.mjs --fixtures=/path/fixtures.json --out=/path/dir [--only=a,b] [--themes=dark] [--sizes=1440x900]
 */
const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5173')
const OUT = path.resolve(arg('out', '/tmp/ws4'))
const FIX = JSON.parse(await fs.readFile(path.resolve(arg('fixtures', '/Users/ryankindle/.claude/jobs/c39b0175/tmp/workflow-studio/fixtures.json')), 'utf8')).responses
const ONLY = arg('only', '').split(',').filter(Boolean)
await fs.mkdir(OUT, { recursive: true })
const watchdog = setTimeout(() => { console.log('WATCHDOG — capture exceeded 20 minutes'); process.exit(2) }, 20 * 60_000)

const O = '/api/cockpit/workflow-studio/observatory'
const exc = FIX[`${O}/exceptions`]?.items || []
const sellerRuns = FIX[`${O}/workflows/seller_inbound/runs?period=7d&limit=80`]?.runs || []
const recorded = (wf, id) => Boolean(FIX[`${O}/workflows/${wf}/runs/${encodeURIComponent(id)}`])
const held = exc.find((i) => i.workflow_key === 'seller_inbound' && i.category === 'human_review' && i.open && recorded('seller_inbound', i.open.run_id))
const success = sellerRuns.find((r) => r.status === 'completed' && /delivered/i.test(r.result || '') && recorded('seller_inbound', r.run_id)) || sellerRuns.find((r) => r.status === 'completed' && recorded('seller_inbound', r.run_id))
const studioRun = (FIX[`${O}/workflows/seller_review_escalation/runs?period=7d&limit=80`]?.runs || []).find((r) => recorded('seller_review_escalation', r.run_id))

const go = (q) => `/workflow-studio${q ? `?${q}` : ''}`
const SHOTS = {
  overview: { url: go(''), ready: '.wss' },
  'overview-system': { url: go(''), ready: '.wss', then: async (p) => { await p.click('[data-node="seller_inbound"] .wss'); await p.waitForSelector('.lc-insp', { timeout: 20000 }) } },
  'overview-edge': { url: go(''), ready: '.wss', then: async (p) => { await p.locator('[data-edge-hit="seller__dispatch"]').dispatchEvent('click'); await p.waitForSelector('.lc-insp', { timeout: 20000 }) } },
  canvas: { url: go('mode=canvas&wf=seller_inbound'), ready: '.wsn' },
  'canvas-regions': { url: go('mode=canvas&wf=seller_inbound'), ready: '.wsn', then: async (p) => { await p.locator('.ws4-stage').first().click({ position: { x: 600, y: 420 } }); for (let i = 0; i < 4; i++) await p.keyboard.press('-'); await p.waitForTimeout(500) } },
  'canvas-node': { url: go('mode=canvas&wf=seller_inbound'), ready: '.wsn', then: async (p) => { await p.click('[data-node="contactable_now"] .wsn'); await p.waitForSelector('.lc-insp', { timeout: 20000 }) } },
  'canvas-capability': { url: go('mode=canvas&wf=seller_inbound&node=dispatch_handoff'), ready: '.lc-insp', then: async (p) => { await p.getByRole('tab', { name: /Handoff|Capability|Decision/ }).first().click().catch(() => {}); await p.waitForTimeout(500) } },
  'canvas-large': { url: go('mode=canvas&wf=seller_inbound'), ready: '.wsn', then: async (p) => { await p.getByRole('button', { name: /Expand every grouped step/ }).click(); await p.waitForTimeout(400); await p.getByRole('button', { name: /Fit the workflow/ }).click(); await p.waitForTimeout(700) } },
  'canvas-tb': { url: go('mode=canvas&wf=queue_dispatch'), ready: '.wsn', then: async (p) => { await p.getByRole('button', { name: /Lay out top to bottom/ }).click(); await p.waitForTimeout(900) } },
  'run-held': held ? { url: go(`mode=canvas&wf=seller_inbound&run=${encodeURIComponent(held.open.run_id)}`), ready: '.ws4-why' } : null,
  'run-success': success ? { url: go(`mode=canvas&wf=seller_inbound&run=${encodeURIComponent(success.run_id)}`), ready: '.ws4-why' } : null,
  replay: held ? { url: go(`mode=canvas&wf=seller_inbound&run=${encodeURIComponent(held.open.run_id)}`), ready: '.ws4-replay', then: async (p) => { await p.locator('.ws4-scrub input').evaluate((el) => { const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, '7'); el.dispatchEvent(new Event('input', { bubbles: true })) }); await p.waitForTimeout(700) } } : null,
  'studio-run': studioRun ? { url: go(`mode=canvas&wf=seller_review_escalation&run=${encodeURIComponent(studioRun.run_id)}`), ready: '.ws4-why' } : null,
  'exception-deeplink': { url: go(''), ready: '.ws4-exc__main', then: async (p) => { await p.locator('.ws4-exc__main').first().click(); await p.waitForSelector('.ws4-why, .lc-insp', { timeout: 30000 }); await p.waitForTimeout(900) } },
  live: { url: go('mode=live&wf=seller_inbound'), ready: '.ws4-runrow, .ws4-running .lc-empty' },
  'live-pulse': { url: go('mode=live&wf=seller_inbound'), ready: '.ws4-runrow, .ws4-running .lc-empty', then: async (p) => { await p.waitForRequest((r) => r.url().includes('/observatory/live?since='), { timeout: 40000 }); await p.waitForTimeout(520) } },
  runs: { url: go('mode=runs&wf=seller_inbound'), ready: '.lc-grid, [role="grid"]', then: async (p) => { await p.waitForTimeout(600) } },
  'runs-run': { url: go('mode=runs&wf=seller_inbound'), ready: '.lc-grid, [role="grid"]', then: async (p) => { await p.locator('[role="row"][data-tone="attn"], [role="row"]').nth(1).click(); await p.waitForSelector('.ws4-why', { timeout: 30000 }); await p.waitForTimeout(900) } },
  activity: { url: go('mode=activity'), ready: '.lc-feed, .lc-empty' },
  analytics: { url: go('mode=analytics&wf=seller_inbound'), ready: '.ws4-strip' },
  'analytics-lower': { url: go('mode=analytics&wf=seller_inbound'), ready: '.ws4-strip', then: async (p) => { await p.locator('.ws4-analytics__doc').evaluate((el) => { el.scrollTop = el.scrollHeight }); await p.waitForTimeout(500) } },
  editor: { url: go('mode=canvas&wf=seller_review_escalation'), ready: '.wsn', then: async (p) => { await p.getByRole('button', { name: /Edit draft/ }).click(); await p.waitForSelector('.ws4-palette', { timeout: 30000 }); await p.waitForTimeout(1600) } },
  create: { url: go(''), ready: '.wss', then: async (p) => { if (!(await p.locator('.ws4-rail__new').count())) await p.getByRole('button', { name: 'Show the automation rail' }).click(); await p.waitForSelector('.ws4-rail__new', { timeout: 30000 }); await p.click('.ws4-rail__new'); await p.waitForSelector('.ws4-create__bp', { timeout: 30000 }); await p.locator('.ws4-create__bp').first().click(); await p.waitForSelector('.ws4-create__preview .ws4-outline', { timeout: 30000 }); await p.waitForTimeout(600) } },
  'editor-diff': { url: go('mode=canvas&wf=seller_review_escalation'), ready: '.wsn', then: async (p) => { await p.getByRole('button', { name: /Edit draft/ }).click(); await p.waitForSelector('.ws4-palette', { timeout: 30000 }); await p.locator('.ws4-pal', { hasText: 'Wait for an event' }).click(); await p.waitForTimeout(1600) } },
}

const PLAN = [
  { theme: 'dark', size: [1440, 900], shots: Object.keys(SHOTS) },
  { theme: 'dark', size: [1280, 800], shots: ['overview', 'canvas', 'run-held', 'runs-run', 'analytics', 'editor'] },
  { theme: 'dark', size: [1920, 1080], shots: ['overview', 'overview-system', 'canvas', 'canvas-node', 'run-held', 'live', 'runs-run', 'analytics', 'editor', 'create'] },
  { theme: 'dark', size: [5120, 1440], shots: ['overview', 'canvas', 'run-held'] },
  { theme: 'light', size: [1440, 900], shots: ['overview', 'canvas', 'canvas-node', 'run-held', 'live', 'runs', 'analytics', 'editor'] },
  { theme: 'light', size: [1280, 800], shots: ['overview', 'canvas'] },
  { theme: 'light', size: [1920, 1080], shots: ['overview', 'run-held'] },
  { theme: 'true_black', size: [1440, 900], shots: ['overview', 'canvas', 'run-held', 'live', 'analytics'] },
  { theme: 'true_black', size: [1920, 1080], shots: ['overview', 'canvas'] },
  { theme: 'true_black', size: [1280, 800], shots: ['overview'] },
  { theme: 'red_ops', size: [1440, 900], shots: ['overview', 'canvas', 'run-held', 'analytics'] },
  { theme: 'red_ops', size: [1920, 1080], shots: ['overview'] },
  { theme: 'red_ops', size: [1280, 800], shots: ['canvas'] },
].filter((p) => !arg('themes', '') || arg('themes', '').split(',').includes(p.theme)).filter((p) => !arg('sizes', '') || arg('sizes', '').split(',').includes(p.size.join('x')))

const browser = await chromium.launch()
const blocked = []
const pageErrors = []
const consoleErrors = []
const missing = new Set()
let liveReads = 0
for (const plan of PLAN) {
  const [W, H] = plan.size
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
  await ctx.addInitScript((t) => {
    try {
      localStorage.removeItem('nexus.desktop.split')
      localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
      const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
      localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
      for (const k of Object.keys(localStorage)) if (k.startsWith('ws4.') || k.startsWith('lc.inspector.ws4') || k.startsWith('lc.grid.ws4')) localStorage.removeItem(k)
    } catch { /* ignore */ }
  }, plan.theme)
  const page = await ctx.newPage()
  await page.addInitScript(() => { const add = () => { const s = document.createElement('style'); s.textContent = '.nx-dev-runtime-banner,.nx-dev-runtime-chip{display:none!important}'; (document.head || document.documentElement).appendChild(s) }; if (document.documentElement) add(); else document.addEventListener('DOMContentLoaded', add) })
  page.on('pageerror', (e) => pageErrors.push(`${plan.theme}-${W}: ${String(e.message).slice(0, 200)}`))
  page.on('console', (m) => { if (m.type() === 'error' && consoleErrors.length < 20) consoleErrors.push(m.text().slice(0, 200)) })
  await page.route('**/*', async (route) => {
    const req = route.request()
    const u = new URL(req.url())
    const isApi = u.pathname.startsWith('/api/')
    const isSupa = /supabase\.co$/.test(u.hostname)
    if (isSupa) {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method()) && !u.pathname.startsWith('/auth/')) { blocked.push(`${req.method()} ${u.pathname}`); return route.abort() }
      if (/\/(rest|realtime|storage|functions|graphql)\//.test(u.pathname)) return route.abort()
      return route.continue()
    }
    if (!isApi) return route.continue()
    if (req.method() === 'POST' && u.pathname === '/api/cockpit/workflow-studio/simulate') {
      let body = {}
      try { body = JSON.parse(req.postData() || '{}') } catch { /* not json */ }
      const sim = body.blueprint ? FIX[`POST ${u.pathname}#blueprint:${body.blueprint}`] : FIX[`POST ${u.pathname}`]
      // answered here from the recorded PURE simulation — it never reaches a server
      return sim ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sim) }) : route.abort()
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method())) { blocked.push(`${req.method()} ${u.pathname}`); return route.abort() }
    if (u.pathname.startsWith('/api/cockpit/workflow-studio')) {
      let key = `${u.pathname}${u.search}`
      if (u.pathname.endsWith('/observatory/live')) {
        const k = u.searchParams.get('key')
        if (u.searchParams.get('since') && k) { liveReads++; key = FIX[`${u.pathname}?since=REPLAY&key=${k}`] ? `${u.pathname}?since=REPLAY&key=${k}` : `${u.pathname}?key=${k}` }
        else key = k ? `${u.pathname}?key=${k}` : u.pathname
      }
      const hit = FIX[key] ?? FIX[u.pathname]
      if (hit) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(hit) })
      missing.add(key)
      return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'not_recorded' }) })
    }
    return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'capture_offline' }) })
  })
  for (const shot of plan.shots) {
    if (ONLY.length && !ONLY.includes(shot)) continue
    const r = SHOTS[shot]
    const tag = `${plan.theme}-${W}x${H}-${shot}`
    if (!r) { console.log(tag.padEnd(46), 'SKIP (no recorded example)'); continue }
    try {
      await page.goto(`${BASE}${r.url}`, { waitUntil: 'domcontentloaded', timeout: 180000 })
      await page.waitForSelector(r.ready, { timeout: 120000 })
      await page.waitForTimeout(900)
      if (r.then) await r.then(page)
      await page.waitForTimeout(700)
      await page.screenshot({ path: path.join(OUT, `${tag}.png`) })
      const m = await page.evaluate(() => {
        const root = document.querySelector('.ws4')
        const leaves = root ? [...root.querySelectorAll('*')].filter((el) => el.children.length === 0 && (el.textContent || '').trim()) : []
        const garbage = leaves.map((el) => (el.textContent || '').trim()).filter((t) => /\bNaN\b|\bundefined\b|\[object Object\]|\bInfinity\b|^null$/.test(t)).slice(0, 5)
        return { garbage, nodes: document.querySelectorAll('.wsn, .wss').length, overflowX: document.documentElement.scrollWidth - innerWidth }
      })
      console.log(tag.padEnd(46), `nodes=${m.nodes}`, m.garbage.length ? `GARBAGE ${m.garbage.join('|')}` : 'clean', m.overflowX > 0 ? `overflowX=${m.overflowX}` : '')
    } catch (e) {
      console.log(tag.padEnd(46), 'FAIL', String(e.message).split('\n')[0].slice(0, 160))
      await page.screenshot({ path: path.join(OUT, `${tag}-FAIL.png`) }).catch(() => {})
    }
  }
  await ctx.close()
}
await browser.close()
clearTimeout(watchdog)
console.log(`blocked writes: ${blocked.length ? [...new Set(blocked)].join(', ') : 'none'}`)
console.log(`live polls replayed: ${liveReads}`)
if (missing.size) console.log('not recorded (served 404):', [...missing].slice(0, 12).join('\n  '))
if (consoleErrors.length) console.log('console errors (first):', [...new Set(consoleErrors)].slice(0, 6))
if (pageErrors.length) console.log('page errors:', [...new Set(pageErrors)].slice(0, 8))
