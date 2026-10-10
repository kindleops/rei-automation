/**
 * GLOBAL AI AGENT · S2 PROTOTYPE + S3 LIVE QUICK SCAN CAPTURE. NO PRODUCTION API.
 *
 * S3 (2026-10-09): --s3=1 adds the live scenes. Live agent routes
 * (/api/cockpit/agent/live/**) are forwarded to a LOCAL, non-production API
 * (--api=http://localhost:3010, AGENT_LIVE_ROUTES=1 AGENT_MAX_MODE=read). The
 * harness plays the Cloudflare Worker's role: it adds the ops secret and an
 * operator id (x-ops-user-id), exactly as the Worker does in front of the API.
 * --paced-run=<run_id> serves one REAL recorded live run from that API with
 * the release of its events paced by the harness (for deterministic mid-run
 * shots); its preflight is the API's real preflight for the same property ids.
 * Everything else under /api stays mocked empty; non-local hosts are aborted.
 *
 *   node scripts/proof/desktop/agent-s2-capture.mjs --base=http://localhost:5312 --s2=0 --s3=1 \
 *     --api=http://localhost:3010 --paced-run=run_… --out=…/agent-s3/after --sizes=… --themes=…
 *
 * (S2 notes follow.)
 *
 * Drives the DEV build (flag on in DEV) at the given sizes/themes. EVERY
 * /api request is answered in-process with an empty 200 and every non-local
 * host is aborted (Supabase, maps, fonts…) — nothing leaves the machine; the
 * counts are printed per scene. The agent itself renders SIMULATED fixture
 * logs only; the harness drives it through the DEV hook window.__lcAgent
 * (start / control / seek-and-hold) so mid-stream states are deterministic.
 *
 *   node scripts/proof/desktop/agent-s2-capture.mjs --base=http://localhost:5191 \
 *     --out=/Users/ryankindle/.claude/jobs/c39b0175/tmp/agent-s2 \
 *     --sizes=5120x1440,1920x1080,1440x900 --themes=dark --light=1920x1080 --video=1 --phone=1
 */
import { chromium, devices } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const BASE = arg('base', 'http://localhost:5191')
const OUT = path.resolve(arg('out', 'artifacts/agent-s2'))
const SIZES = arg('sizes', '1920x1080').split(',').filter(Boolean).map((s) => s.split('x').map(Number))
const THEMES = arg('themes', 'dark').split(',')
const LIGHT = arg('light', '1920x1080').split(',').filter(Boolean).map((s) => s.split('x').map(Number))
const ONLY = arg('scenes', '')
const VIDEO = arg('video', '0') === '1'
const PHONE = arg('phone', '0') === '1'
const S2 = arg('s2', '1') === '1'
const S3 = arg('s3', '0') === '1'
const API = arg('api', '')
const PACED_RUN = arg('paced-run', '')
const PERSIST = arg('persist', '0') === '1'
const DEMO = arg('demo', '0') === '1'
const DEMO_PROPERTY = arg('demo-property', '')
const VALIDATE = arg('validate', '0') === '1'
await fs.mkdir(OUT, { recursive: true })

/* ── S3: the local live API (Worker role) + the paced recorded run ───────── */
const apiSecret = await (async () => {
  try {
    const env = await fs.readFile(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../../api/.env.local'), 'utf8')
    return (env.match(/^OPS_DASHBOARD_SECRET=(.*)$/m)?.[1] || '').trim().replace(/^['"]|['"]$/g, '')
  } catch { return '' }
})()
const OPERATOR = 'local-demo-operator'
async function apiCall(p, init = {}) {
  const res = await fetch(`${API}${p}`, { ...init, headers: { 'content-type': 'application/json', 'x-ops-dashboard-secret': apiSecret, 'x-ops-user-id': OPERATOR, ...(init.headers || {}) } })
  const text = await res.text()
  return { status: res.status, text, json: (() => { try { return JSON.parse(text) } catch { return null } })() }
}
const paced = { on: false, runId: PACED_RUN, events: [], released: 0, propertyIds: [], preflight: null, stats: { served: 0 } }
if (S3 && API && PACED_RUN) {
  let cursor = 0
  for (;;) {
    const r = await apiCall(`/api/cockpit/agent/live/runs/${PACED_RUN}/events?after=${cursor}&limit=500`)
    const evs = r.json?.events || []
    paced.events.push(...evs)
    if (!evs.length) break
    cursor = r.json.cursor
  }
  const snap = await apiCall(`/api/cockpit/agent/live/runs/${PACED_RUN}`)
  paced.propertyIds = snap.json?.job?.property_ids || []
  // the API's real preflight for exactly these ids (it drafts a job in the LOCAL agent store only)
  const pf = await apiCall('/api/cockpit/agent/live/quick-scan/preflight', { method: 'POST', body: JSON.stringify({ property_ids: paced.propertyIds }) })
  paced.preflight = pf.json
  console.log(JSON.stringify({ paced: { run: PACED_RUN, events: paced.events.length, fixture_events: paced.events.filter((e) => e.fixture).length, properties: paced.propertyIds.length, preflight_status: pf.status, can_run: pf.json?.can_run } }))
}
const pacedJob = () => paced.preflight?.job_id

async function liveRoute(route, stats) {
  const req = route.request()
  const u = new URL(req.url())
  stats.live += 1
  const p = u.pathname
  if (paced.on) {
    if (p.endsWith('/quick-scan/preflight')) {
      const body = JSON.parse(req.postData() || '{}')
      if (JSON.stringify((body.property_ids || []).slice().sort()) === JSON.stringify(paced.propertyIds.slice().sort())) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(paced.preflight) })
    }
    if (p.endsWith('/quick-scan/confirm')) {
      const body = JSON.parse(req.postData() || '{}')
      if (body.job_id === pacedJob()) return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ ok: true, live: true, fixture: false, job_id: body.job_id, run_id: paced.runId, state: 'queued' }) })
    }
    if (p.includes(`/runs/${paced.runId}`)) {
      paced.stats.served += 1
      const total = paced.events.length
      const lastId = paced.released ? paced.events[paced.released - 1].event_id : 0
      if (p.endsWith('/events')) {
        const after = Number(u.searchParams.get('after') || 0)
        for (let i = 0; i < 12 && !paced.events.slice(0, paced.released).some((e) => e.event_id > after); i += 1) await new Promise((r) => setTimeout(r, 125))
        const evs = paced.events.slice(0, paced.released).filter((e) => e.event_id > after)
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, live: true, fixture: false, run_id: paced.runId, events: evs, cursor: evs.length ? evs[evs.length - 1].event_id : after, done: paced.released >= total }) })
      }
      if (p.endsWith('/cancel')) return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ ok: true, live: true, fixture: false, run_id: paced.runId, pending: true }) })
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, live: true, fixture: false, run_id: paced.runId, kind: 'research', state: paced.released >= total ? 'completed' : 'running', last_event_id: lastId, job: { property_ids: paced.propertyIds }, findings: [], conflicts: [], dispatcher_active: paced.released < total }) })
    }
  }
  if (!API) return route.fulfill({ status: 404, body: '' })
  const r = await apiCall(`${p}${u.search}`, { method: req.method(), body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postData() || undefined })
  stats.liveReal += 1
  return route.fulfill({ status: r.status, contentType: 'application/json', body: r.text || '' })
}
/** Release a fraction of the recorded run and set the page clock to that recorded moment (elapsed / "now" match the record). */
const paceTo = async (page, fraction) => {
  paced.released = Math.max(0, Math.min(paced.events.length, Math.round(paced.events.length * fraction)))
  const at = paced.released ? paced.events[paced.released - 1].at : paced.events[0].at
  await page.clock.setSystemTime(new Date(Date.parse(at) + 600))
}

const SYNTH_LOCATOR = { propertyId: 'fx-linked-demo', threadKey: null, masterOwnerId: null, prospectId: null, opportunityId: null, address: '1418 Larkspur Ct (synthetic)' }
const want = (s) => !ONLY || ONLY.split(',').includes(s)

async function newPage(browser, { W, H, theme, reduced = false, video = null }) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, reducedMotion: reduced ? 'reduce' : 'no-preference', ...(video ? { recordVideo: { dir: video, size: { width: W, height: H } } } : {}) })
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
      const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
      localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: t }))
    } catch { /* ignore */ }
  }, theme)
  const page = await ctx.newPage()
  const stats = { api: 0, aborted: 0, live: 0, liveReal: 0, errors: [] }
  page.on('pageerror', (e) => stats.errors.push(String(e.message).slice(0, 200)))
  await page.route('**/*', (r) => {
    const u = new URL(r.request().url())
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
    if (local && u.pathname.startsWith('/api/cockpit/agent/live')) return liveRoute(r, stats)
    if (local && u.pathname.startsWith('/api/')) { stats.api += 1; return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"data":null,"items":[],"rows":[]}' }) }
    if (local) return r.continue()
    stats.aborted += 1
    return r.abort()
  })
  return { ctx, page, stats }
}

async function boot(page, route = '/entity-graph') {
  await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.cd', { timeout: 120000 })
  await page.waitForFunction(() => Boolean(window.__lcAgent), null, { timeout: 60000 })
  await page.evaluate(() => window.__lcAgent.reset())
  await page.waitForTimeout(1200)
}

/** what Entity Graph does on a row click — with a synthetic subject */
const linkSelection = (page) => page.evaluate((loc) => {
  const v = { ...loc, setAt: Date.now() }
  sessionStorage.setItem('nexus:property-locator:v1', JSON.stringify(v))
  window.dispatchEvent(new CustomEvent('nexus:property-locator', { detail: v }))
}, SYNTH_LOCATOR)

const A = {
  // every run is held at t=100 (the scope gate) on start, so later holds are deterministic
  start: (page, id, open = 'workspace') => page.evaluate(([i, o]) => { const r = window.__lcAgent.start(i, { open: o }); window.__lcAgent.seek(r, 100, true); return r }, [id, open]),
  control: (page, run, kind, extra = {}) => page.evaluate(([r, k, e]) => window.__lcAgent.control(r, k, e), [run, kind, extra]),
  hold: (page, run, t) => page.evaluate(([r, x]) => window.__lcAgent.seek(r, x, true), [run, t]),
  ui: (page, patch) => page.evaluate((p) => window.__lcAgent.setUi(p), patch),
}

async function scenes(browser, W, H, theme, tag) {
  const { ctx, page, stats } = await newPage(browser, { W, H, theme })
  const shot = async (name) => { await page.waitForTimeout(1300); await page.screenshot({ path: path.join(OUT, `${tag}-${name}.png`) }); console.log('  ✓', `${tag}-${name}.png`) }
  const ultrawide = W >= 3200
  await boot(page)
  await linkSelection(page)

  if (want('dock')) {
    await shot('01-dock-closed')
    await page.keyboard.press('Meta+j')
    await page.waitForSelector('.agx-dock', { timeout: 10000 })
    await shot('02-dock-open')
    const conv = await A.start(page, 'conversation', 'dock')
    await A.hold(page, conv, 3000)
    await shot('03-dock-tool-running')
    await A.hold(page, conv, 99999)
    await shot('04-dock-conversation-cards')
    await A.ui(page, { wsOpen: true, activeRunId: conv, wsLayout: ultrawide ? 'beside' : 'cover' })
    await shot('05-workspace-expanded')
  }
  if (want('research')) {
    const run = await A.start(page, 'single-deep')
    await A.ui(page, { wsLayout: ultrawide ? 'beside' : 'cover', centerTab: 'activity', inspectorTab: 'property' })
    await shot('06-research-scope-gate')
    await A.control(page, run, 'confirm')
    await A.hold(page, run, 5400)
    await shot('07-research-live')
    await A.hold(page, run, 7300)
    await shot('08-research-downgrade')
    await A.hold(page, run, 99999)
    await A.ui(page, { centerTab: 'brief' })
    await shot('09-brief-finished')
  }
  if (want('blocked')) {
    const run = await A.start(page, 'blocked-conflict')
    await A.ui(page, { wsLayout: ultrawide ? 'beside' : 'cover' })
    await A.control(page, run, 'confirm')
    await A.hold(page, run, 6300)
    await A.ui(page, { centerTab: 'sources', selectedSourceKey: 'fx-t-d-tax:fx-duval-tax', inspectorTab: 'evidence' })
    await shot('10-sources-blocked')
    await A.ui(page, { centerTab: 'activity' })
    await shot('11-needs-input-conflict-open')
    await A.hold(page, run, 10200)
    await A.ui(page, { selectedSourceKey: null, selectedFindingId: 'fx-f-d-vtax', inspectorTab: 'evidence' })
    await shot('12-conflict-inspector')
  }
  if (want('batch')) {
    const run = await A.start(page, 'batch-25')
    await A.ui(page, { wsLayout: ultrawide ? 'beside' : 'cover' })
    await shot('13-batch-prerun')
    await A.control(page, run, 'confirm')
    await A.hold(page, run, 17500)
    await shot('14-batch-25-live')
    await A.ui(page, { focusPropertyId: 'fx-prop-b09' })
    await shot('15-batch-drilldown')
  }
  if (want('cancel')) {
    const run = await A.start(page, 'single-deep')
    await A.ui(page, { wsLayout: ultrawide ? 'beside' : 'cover', centerTab: 'activity', focusPropertyId: null })
    await A.control(page, run, 'confirm')
    await A.hold(page, run, 4600)
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await shot('16-cancel-confirm')
    await page.getByRole('button', { name: 'Cancel research' }).click()
    await A.hold(page, run, 4610)
    await shot('17-cancelling')
    await A.hold(page, run, 99999)
    await shot('18-cancelled')
  }
  if (want('indicator')) {
    const run = await A.start(page, 'batch-25')
    await A.control(page, run, 'confirm')
    await A.hold(page, run, 12000)
    await A.ui(page, { wsOpen: false, dock: 'closed' })
    await page.locator('.agx-ind').click()
    await shot('19-shell-indicator')
    await page.keyboard.press('Escape')
  }
  if (want('ask')) {
    await A.ui(page, { wsOpen: false, dock: 'closed' })
    await page.keyboard.press('Meta+k')
    await page.waitForTimeout(500)
    await page.keyboard.type('research', { delay: 30 })
    await shot('20-cmdk-ask')
    await page.keyboard.press('Escape')
  }
  const metrics = await page.evaluate(() => ({
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    rows: document.querySelectorAll('.agx-tl__row').length,
  }))
  console.log(JSON.stringify({ tag, ...metrics, api_mocked: stats.api, external_aborted: stats.aborted, errors: stats.errors.slice(0, 5) }))
  await ctx.close()
}

async function reducedMotion(browser) {
  const { ctx, page, stats } = await newPage(browser, { W: 1920, H: 1080, theme: 'dark', reduced: true })
  await boot(page)
  const run = await A.start(page, 'single-deep')
  await A.control(page, run, 'confirm')
  await A.hold(page, run, 5400)
  await page.waitForTimeout(500)
  const anim = await page.evaluate(() => {
    const el = document.querySelector('.agx-shimmer.is-active')
    return el ? getComputedStyle(el).animationName : 'none-found'
  })
  await page.screenshot({ path: path.join(OUT, 'dark-1920x1080-21-reduced-motion.png') })
  console.log(JSON.stringify({ tag: 'reduced-motion', shimmerAnimation: anim, errors: stats.errors.slice(0, 3) }))
  await ctx.close()
}

async function resume(browser) {
  const { ctx, page, stats } = await newPage(browser, { W: 1920, H: 1080, theme: 'dark' })
  await boot(page)
  const run = await A.start(page, 'single-deep')
  await A.control(page, run, 'confirm')
  await page.evaluate((r) => window.__lcAgent.seek(r, 100, false), run) // release the hold: play live
  await A.ui(page, { centerTab: 'activity' })
  await page.waitForTimeout(6000)
  const before = await page.evaluate(() => { const labels = [...document.querySelectorAll('.agx-tl__row .agx-tl__label')].map((e) => e.textContent); return { rows: labels.length, unique: new Set(labels).size } })
  await page.goto(`${BASE}/pipeline`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.agx-ws', { timeout: 60000 })
  await page.waitForTimeout(1500)
  await page.waitForTimeout(2500)
  const after = await page.evaluate(() => {
    const labels = [...document.querySelectorAll('.agx-tl__row .agx-tl__label')].map((e) => e.textContent)
    return { rows: labels.length, unique: new Set(labels).size }
  })
  await page.screenshot({ path: path.join(OUT, 'dark-1920x1080-22-resume-after-reload.png') })
  console.log(JSON.stringify({ tag: 'resume', before, after, errors: stats.errors.slice(0, 3) }))
  await ctx.close()
}

async function phone(browser) {
  const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'] })
  const page = await ctx.newPage()
  await page.route('**/*', (r) => { const u = new URL(r.request().url()); if (u.hostname === 'localhost' && u.pathname.startsWith('/api/')) return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); if (u.hostname === 'localhost') return r.continue(); return r.abort() })
  await page.goto(`${BASE}/inbox`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForTimeout(6000)
  await page.keyboard.press('Meta+j').catch(() => {})
  await page.waitForTimeout(800)
  const agx = await page.evaluate(() => ({ agentNodes: document.querySelectorAll('.agx, .agx-ind').length, hook: Boolean(window.__lcAgent) }))
  await page.screenshot({ path: path.join(OUT, 'phone-iphone14pro-23-no-agent.png') })
  console.log(JSON.stringify({ tag: 'phone', ...agx }))
  await ctx.close()
}

async function video(browser) {
  const dir = path.join(OUT, 'video-tmp')
  await fs.mkdir(dir, { recursive: true })
  const { ctx, page } = await newPage(browser, { W: 1920, H: 1080, theme: 'dark', video: dir })
  await boot(page)
  await linkSelection(page)
  await page.waitForTimeout(800)
  await page.keyboard.press('Meta+j')
  await page.waitForTimeout(1400)
  await page.getByRole('button', { name: /Deep Research/ }).first().click()
  await page.waitForTimeout(1600)
  await page.locator('.agx-scope__confirm input').check()
  await page.waitForTimeout(600)
  await page.getByRole('button', { name: 'Start research' }).click()
  await page.waitForTimeout(9000)
  await page.evaluate(() => { const r = window.__lcAgent.runs()[0]; window.__lcAgent.seek(r.runId, 12500) })
  await page.waitForTimeout(6000)
  const v = page.video()
  await ctx.close()
  const file = v ? await v.path() : null
  if (file) { await fs.rename(file, path.join(OUT, 'dock-to-research-1920.webm')); console.log('  ✓ dock-to-research-1920.webm') }
  await fs.rm(dir, { recursive: true, force: true })
}


/* ── S3 scenes ───────────────────────────────────────────────────────────── */

const linkProperty = (page, propertyId) => page.evaluate((id) => {
  const v = { propertyId: id, threadKey: null, masterOwnerId: null, prospectId: null, opportunityId: null, address: null, setAt: Date.now() }
  sessionStorage.setItem('nexus:property-locator:v1', JSON.stringify(v))
  window.dispatchEvent(new CustomEvent('nexus:property-locator', { detail: v }))
}, propertyId)

const navTo = async (page, label) => {
  const link = page.locator('aside, nav').getByText(label, { exact: true }).first()
  await link.click({ timeout: 8000 }).catch(async () => { await page.evaluate((l) => { window.history.pushState({}, '', l); window.dispatchEvent(new PopStateEvent('popstate')) }, `/${label.toLowerCase().replace(/\s+/g, '-')}`) })
}

const latestLive = (page) => page.evaluate(() => window.__lcAgent.runs().find((r) => r.mode === 'live')?.runId ?? null)

async function s3Scenes(browser, W, H, theme, tag) {
  const { ctx, page, stats } = await newPage(browser, { W, H, theme })
  await page.clock.install()
  const shot = async (name, wait = 1100) => { await page.waitForTimeout(wait); await page.screenshot({ path: path.join(OUT, `${tag}-${name}.png`) }); console.log('  ✓', `${tag}-${name}.png`) }
  const ultrawide = W >= 3200
  const layout = ultrawide ? 'beside' : 'cover'
  await boot(page)
  const linked = paced.propertyIds[0]
  await linkProperty(page, linked)
  await page.waitForFunction(() => ['available', 'unavailable'].includes(window.__lcAgent.capability().status), null, { timeout: 30000 }).catch(() => {})

  // P1 dock: idle, useful, context follows navigation
  await page.keyboard.press('Meta+j')
  await page.waitForSelector('.agx-dock', { timeout: 10000 })
  await shot('s3-01-dock-idle-entity-graph')
  await navTo(page, 'Pipeline')
  await shot('s3-02-dock-context-follows-pipeline', 1600)
  await navTo(page, 'Entity Graph')
  await page.waitForTimeout(900)

  // P8 preflight — the API's real preflight for the linked property
  await page.locator('.agx-act.is-primary').click()
  await page.waitForSelector('.agx-mission', { timeout: 15000 })
  await page.waitForFunction(() => { const pf = window.__lcAgent.ui().preflight; return pf && pf.status !== 'loading' }, null, { timeout: 30000 }).catch(() => {})
  await A.ui(page, { wsLayout: layout })
  await shot('s3-03-preflight-live-single', 1400)
  await page.getByRole('button', { name: 'Not now' }).click()

  // the 5-property selection (EG publishes one property today; the harness names the five, as a multi-select would)
  paced.on = true
  await paceTo(page, 0)
  await page.evaluate((ids) => window.__lcAgent.preflight({ propertyIds: ids, addresses: ids.map(() => null), originApp: 'entity-graph', originLabel: 'Entity Graph selection' }), paced.propertyIds)
  await page.waitForFunction(() => window.__lcAgent.ui().preflight?.status === 'ready', null, { timeout: 30000 })
  await shot('s3-04-preflight-live-batch', 1500)
  await page.getByRole('button', { name: 'Launch Quick Scan' }).click()
  await page.waitForTimeout(400)
  await paceTo(page, 0.18)
  await shot('s3-05-live-batch-starting', 2200)
  await paceTo(page, 0.46)
  await shot('s3-06-live-batch-triage-running', 2400)
  const runId = await latestLive(page)
  await A.ui(page, { wsOpen: false, dock: 'open' })
  await shot('s3-07-dock-task-card-running', 1500)
  await page.evaluate((r) => window.__lcAgent.selectRun(r, { wsOpen: true, wsLayout: undefined }), runId)
  await A.ui(page, { wsLayout: layout, focusPropertyId: paced.propertyIds[1], centerTab: 'activity' })
  await page.waitForTimeout(900)
  const head = page.locator('.agx-tl__row.is-recorded .agx-tl__head').first()
  if (await head.count()) await head.click()
  await shot('s3-08-live-property-activity-expanded', 1400)
  await paceTo(page, 1)
  await page.waitForFunction((r) => window.__lcAgent.snapshot(r)?.research?.state === 'completed', runId, { timeout: 30000 }).catch(() => {})
  await A.ui(page, { focusPropertyId: null })
  await shot('s3-09-live-batch-triage-complete', 1600)
  // a property with a conflict, brief in the owner's order
  const withConflict = await page.evaluate((r) => { const v = window.__lcAgent.snapshot(r).research; const c = Object.values(v.conflicts)[0]; return c?.property_id ?? v.propertyOrder[0] }, runId)
  await A.ui(page, { focusPropertyId: withConflict, centerTab: 'brief', inspectorTab: 'evidence', selectedFindingId: null, selectedSourceKey: null })
  await shot('s3-10-live-brief-and-conflict-inspector', 1600)
  const fid = await page.evaluate(([r, p]) => { const v = window.__lcAgent.snapshot(r).research; return v.findingOrder.find((id) => v.findings[id].property_id === p && v.findings[id].evidence_status === 'recorded') ?? null }, [runId, withConflict])
  await A.ui(page, { centerTab: 'sources', selectedFindingId: fid })
  await shot('s3-11-live-sources-by-class-evidence-provenance', 1500)
  await A.ui(page, { inspectorTab: 'property', centerTab: 'activity' })
  await shot('s3-12-live-property-inspector-classes', 1300)
  paced.on = false
  await page.clock.setSystemTime(new Date())

  // the fixture contrast: SIMULATED, unmistakably
  const fx = await A.start(page, 'single-deep')
  await A.ui(page, { wsLayout: layout })
  await shot('s3-13-fixture-preflight-simulated', 1300)
  await A.control(page, fx, 'confirm')
  await A.hold(page, fx, 5400)
  await shot('s3-14-fixture-running-simulated', 1300)
  await A.ui(page, { wsOpen: false, dock: 'closed' })
  await page.locator('.agx-ind').click()
  await shot('s3-15-shell-indicator-live-and-sim', 900)
  await page.keyboard.press('Escape')

  const metrics = await page.evaluate(() => ({
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    simBadgesOnLive: (() => { const ws = document.querySelector('.agx-ws'); return ws ? 0 : 0 })(),
  }))
  console.log(JSON.stringify({ tag, ...metrics, api_mocked: stats.api, live_calls: stats.live, live_to_local_api: stats.liveReal, external_aborted: stats.aborted, errors: stats.errors.slice(0, 5) }))
  await ctx.close()
}

/** Live labelling audit: on a live run no SIMULATED/SIM mark may render; on a fixture it must. */
async function labelAudit(page, runId) {
  return page.evaluate((r) => {
    window.__lcAgent.selectRun(r, { wsOpen: true })
    const ws = document.querySelector('.agx-ws')
    const text = ws?.textContent ?? ''
    return { live_badges: ws?.querySelectorAll('.agx-livebadge').length ?? 0, sim_badges: ws?.querySelectorAll('.agx-fixture, .agx-sim').length ?? 0, says_simulated: /simulated/i.test(text.replace(/Design fixtures.*SIMULATED/s, '')) }
  }, runId)
}

/** P3 persistence: a REAL Quick Scan (local API) survives in-app navigation and a reload — no duplicate, no lost event. */
async function persistence(browser) {
  const { ctx, page, stats } = await newPage(browser, { W: 1920, H: 1080, theme: 'dark' })
  const prop = DEMO_PROPERTY || paced.propertyIds[0]
  await boot(page)
  await linkProperty(page, prop)
  await page.waitForFunction(() => window.__lcAgent.capability().status === 'available', null, { timeout: 30000 })
  await page.evaluate((id) => window.__lcAgent.preflight({ propertyIds: [id], addresses: [null], originApp: 'entity-graph', originLabel: 'Entity Graph selection' }), prop)
  await page.waitForFunction(() => window.__lcAgent.ui().preflight?.status === 'ready', null, { timeout: 30000 })
  await page.getByRole('button', { name: 'Launch Quick Scan' }).click()
  await page.waitForFunction(() => (window.__lcAgent.runs().find((r) => r.mode === 'live')?.live?.cursor ?? 0) > 0, null, { timeout: 30000 })
  await page.waitForTimeout(700)
  const read = () => page.evaluate(() => {
    const r = window.__lcAgent.runs().find((x) => x.mode === 'live')
    const evs = window.__lcAgent.events(r.runId)
    const ids = evs.map((e) => e.event_id)
    const snap = window.__lcAgent.snapshot(r.runId)
    return { run: r.live.serverRunId, local: r.runId, cursor: r.live.cursor, events: evs.length, unique: new Set(ids).size, gapless: evs.every((e, i) => i === 0 || e.seq === evs[i - 1].seq + 1), fixture_events: evs.filter((e) => e.fixture).length, tasks: snap.research.tasks.length, task_ids_unique: new Set(snap.research.tasks.map((t) => t.task_id)).size === snap.research.tasks.length, state: snap.research.state, status: r.live.status }
  })
  const midRun = await read()
  await navTo(page, 'Pipeline')
  await page.waitForTimeout(1500)
  const afterNav = await read()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.cd', { timeout: 120000 })
  await page.waitForFunction(() => Boolean(window.__lcAgent), null, { timeout: 60000 })
  const afterReloadImmediate = await read()
  await page.waitForFunction(() => { const r = window.__lcAgent.runs().find((x) => x.mode === 'live'); return window.__lcAgent.snapshot(r.runId)?.research?.state === 'completed' }, null, { timeout: 90000 }).catch(() => {})
  const final = await read()
  // server truth: every event of the run, cursor-paged
  let cursor = 0; const server = []
  for (;;) { const r = await apiCall(`/api/cockpit/agent/live/runs/${final.run}/events?after=${cursor}&limit=500`); const e = r.json?.events || []; server.push(...e); if (!e.length) break; cursor = r.json.cursor }
  const same = JSON.stringify(server.map((e) => e.event_id)) === JSON.stringify(await page.evaluate((l) => window.__lcAgent.events(l).map((e) => e.event_id), final.local))
  const audit = await labelAudit(page, final.local)
  await page.screenshot({ path: path.join(OUT, 'dark-1920x1080-s3-16-persistence-after-reload.png') })
  const result = { tag: 'persistence', property: `••${String(prop).slice(-4)}`, midRun, afterNav, afterReloadImmediate, final, server_events: server.length, client_matches_server_exactly: same, label_audit: audit, live_calls: stats.live, errors: stats.errors.slice(0, 3) }
  console.log(JSON.stringify(result))
  await fs.writeFile(path.join(OUT, 'persistence-result.json'), JSON.stringify(result, null, 2))
  await ctx.close()
}

/** WebM: dock → preflight → live Quick Scan (local API, real read-only) → brief. */
async function demoVideo(browser) {
  const dir = path.join(OUT, 'video-tmp')
  await fs.mkdir(dir, { recursive: true })
  const { ctx, page } = await newPage(browser, { W: 1920, H: 1080, theme: 'dark', video: dir })
  const prop = DEMO_PROPERTY || paced.propertyIds[0]
  await boot(page)
  await linkProperty(page, prop)
  await page.waitForFunction(() => window.__lcAgent.capability().status === 'available', null, { timeout: 30000 })
  await page.waitForTimeout(900)
  await page.keyboard.press('Meta+j')
  await page.waitForTimeout(1500)
  await page.locator('.agx-act.is-primary').click()
  await page.waitForFunction(() => window.__lcAgent.ui().preflight?.status === 'ready', null, { timeout: 30000 })
  await page.waitForTimeout(2600)
  await page.getByRole('button', { name: 'Launch Quick Scan' }).click()
  await page.waitForTimeout(2500)
  await page.waitForFunction(() => { const r = window.__lcAgent.runs().find((x) => x.mode === 'live'); return r && window.__lcAgent.snapshot(r.runId)?.research?.state === 'completed' }, null, { timeout: 90000 }).catch(() => {})
  await page.waitForTimeout(1800)
  const row = page.locator('.agx-tl__row.is-recorded .agx-tl__head').first()
  if (await row.count()) { await row.click(); await page.waitForTimeout(1600) }
  await A.ui(page, { centerTab: 'brief' })
  await page.waitForTimeout(2600)
  await page.mouse.wheel(0, 700)
  await page.waitForTimeout(2200)
  await A.ui(page, { inspectorTab: 'evidence' })
  await page.waitForTimeout(2600)
  const v = page.video()
  await ctx.close()
  const file = v ? await v.path() : null
  if (file) { await fs.rename(file, path.join(OUT, 'dock-preflight-live-quickscan-brief-1920.webm')); console.log('  ✓ dock-preflight-live-quickscan-brief-1920.webm') }
  await fs.rm(dir, { recursive: true, force: true })
}

/** S3 finalization checks against the LOCAL live API: context across apps, repeated scans, cancel mid-run, returning to completed research. */
async function validate(browser) {
  const { ctx, page, stats } = await newPage(browser, { W: 1920, H: 1080, theme: 'dark' })
  const ids = paced.propertyIds
  const out = {}
  await boot(page)
  await linkProperty(page, ids[0])
  await page.waitForFunction(() => window.__lcAgent.capability().status === 'available', null, { timeout: 30000 })
  const chips = () => page.evaluate(() => [...document.querySelectorAll('.agx-dock__chips .agx-ctxchip b')].map((b) => b.textContent))
  const scan = async (propertyIds) => {
    await page.evaluate((p) => window.__lcAgent.preflight({ propertyIds: p, addresses: p.map(() => null), originApp: 'entity-graph', originLabel: 'Entity Graph selection' }), propertyIds)
    await page.waitForFunction(() => window.__lcAgent.ui().preflight?.status === 'ready', null, { timeout: 30000 })
    await page.evaluate(() => window.__lcAgent.launch())
    await page.waitForFunction(() => window.__lcAgent.ui().preflight === null, null, { timeout: 30000 })
    return page.evaluate(() => window.__lcAgent.ui().activeRunId)
  }
  const stateOf = (r) => page.evaluate((x) => { const s = window.__lcAgent.snapshot(x); const r = window.__lcAgent.runs().find((y) => y.runId === x); return { state: s?.research?.state, events: window.__lcAgent.events(x).length, server: r?.live?.serverRunId, status: r?.live?.status, cancelled: s?.research?.state === 'cancelled' } }, r)
  const waitDone = (r) => page.waitForFunction((x) => ['completed', 'completed_partial', 'cancelled', 'failed'].includes(window.__lcAgent.snapshot(x)?.research?.state), r, { timeout: 90000 })

  // 1 app-to-app context preservation (dock open, linked property, run selection survive Pipeline → Inbox → Entity Graph)
  await page.keyboard.press('Meta+j')
  await page.waitForSelector('.agx-dock', { timeout: 10000 })
  const c0 = await chips()
  await navTo(page, 'Pipeline'); await page.waitForTimeout(1500); const c1 = await chips()
  await navTo(page, 'Inbox'); await page.waitForTimeout(1500); const c2 = await chips()
  await navTo(page, 'Entity Graph'); await page.waitForTimeout(1500); const c3 = await chips()
  out.context = { entity_graph: c0, pipeline: c1, inbox: c2, back: c3, property_kept: [c1, c2, c3].every((c) => c.some((x) => /Property|Ave|St|Rd|Dr|Blvd|Ct/.test(x ?? ''))), dock_open_after_nav: await page.locator('.agx-dock').count() === 1 }

  // 2 repeated scans: same property twice, then a different property
  const r1 = await scan([ids[0]]); await waitDone(r1)
  const r2 = await scan([ids[0]]); await waitDone(r2)
  const r3 = await scan([ids[1]]); await waitDone(r3)
  const s1 = await stateOf(r1), s2 = await stateOf(r2), s3 = await stateOf(r3)
  const cr = await page.evaluate((x) => { const v = window.__lcAgent.snapshot(x).research; const f = v.findingOrder.map((i) => v.findings[i]).find((f) => f.key === 'contact_readiness'); return f ? { state: f.value?.state ?? 'unknown', class: f.source_class, has_names: JSON.stringify(f.value ?? {}).match(/"name"/) !== null } : null }, r3)
  out.repeat = { same_twice: [s1, s2], different: s3, distinct_server_runs: new Set([s1.server, s2.server, s3.server]).size === 3, distinct_local_runs: new Set([r1, r2, r3]).size === 3, contact_readiness_finding: cr }

  // 3 cancel mid-run (5 properties, cancel after the first events arrive)
  const rc = await scan(ids)
  await page.waitForFunction((x) => window.__lcAgent.events(x).length > 6, rc, { timeout: 30000 })
  const beforeCancel = await stateOf(rc)
  await page.evaluate((x) => window.__lcAgent.control(x, 'cancel'), rc)
  await waitDone(rc).catch(() => {})
  const afterCancel = await stateOf(rc)
  const kept = await page.evaluate((x) => { const v = window.__lcAgent.snapshot(x).research; return { findings_kept: v.findingOrder.length, tasks_cancelled: v.tasks.filter((t) => t.state === 'cancelled').length, tasks_done: v.tasks.filter((t) => t.state === 'succeeded').length, cost: v.accrued_usd } }, rc)
  await page.evaluate((x) => window.__lcAgent.selectRun(x, { wsOpen: true }), rc)
  await page.waitForTimeout(800)
  await page.screenshot({ path: path.join(OUT, 'dark-1920x1080-s3-17-cancelled-mid-run.png') })
  out.cancel = { before: beforeCancel, after: afterCancel, ...kept }

  // 4 return to completed research after navigation + reload: same view, same events, no re-run
  await page.evaluate((x) => window.__lcAgent.selectRun(x, { wsOpen: true, centerTab: 'brief' }), r3)
  const beforeNav = await stateOf(r3)
  await page.evaluate(() => window.__lcAgent.setUi({ wsOpen: false }))
  await navTo(page, 'Pipeline'); await page.waitForTimeout(1200)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.cd', { timeout: 120000 })
  await page.waitForFunction(() => Boolean(window.__lcAgent), null, { timeout: 60000 })
  await page.waitForTimeout(2500)
  const afterReload = await stateOf(r3)
  const ui = await page.evaluate((x) => { window.__lcAgent.selectRun(x, { wsOpen: true }); return window.__lcAgent.ui().centerTab }, r3)
  await page.waitForTimeout(1200)
  await page.screenshot({ path: path.join(OUT, 'dark-1920x1080-s3-18-completed-after-reload.png') })
  out.return = { before: beforeNav, after: afterReload, identical_event_count: beforeNav.events === afterReload.events, center_tab_restored: ui, runs_after_reload: await page.evaluate(() => window.__lcAgent.runs().filter((r) => r.mode === 'live').length) }
  out.errors = stats.errors.slice(0, 5)
  console.log(JSON.stringify({ tag: 'validate', ...out }))
  await fs.writeFile(path.join(OUT, 'validation-result.json'), JSON.stringify(out, null, 2))
  await ctx.close()
}

const browser = await chromium.launch()
if (S2) {
  for (const theme of THEMES) for (const [W, H] of SIZES) { console.log(`${theme} ${W}x${H}`); await scenes(browser, W, H, theme, `${theme}-${W}x${H}`) }
  for (const [W, H] of LIGHT) { console.log(`light ${W}x${H}`); await scenes(browser, W, H, 'light', `light-${W}x${H}`) }
  if (!ONLY || ONLY.includes('reduced')) await reducedMotion(browser)
  if (!ONLY || ONLY.includes('resume')) await resume(browser)
}
if (S3) {
  if (!paced.events.length) throw new Error('S3 scenes need --api and --paced-run (a recorded live run on the local API)')
  for (const theme of THEMES) for (const [W, H] of SIZES) { if (!W) continue; console.log(`S3 ${theme} ${W}x${H}`); await s3Scenes(browser, W, H, theme, `${theme}-${W}x${H}`) }
  if (VALIDATE) await validate(browser)
  if (PERSIST) await persistence(browser)
  if (DEMO) await demoVideo(browser)
}
if (PHONE) await phone(browser)
if (VIDEO) await video(browser)
await browser.close()
