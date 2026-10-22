// Screenshots of the REAL outcome in BOTH UIs (visual evidence only; nothing here changes state):
//   * Agntei: its own web UI (apps/web/dist, served by the headless Agntei server of the run) on the LIVE E2E state,
//     Connections → LeadCommand Workforce (#/connections/leadcommand): linked + the mission completed, then revoked.
//   * LeadCommand Workforce: the dashboard (vite dev, apps/dashboard) with every /api/cockpit/workforce/* GET answered
//     from the responses RECORDED from the real route handlers during the run ("recorded from local E2E"). Every other
//     request is answered locally (an empty 200 for local /api, the dev server for the app) or aborted (any other host).
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import * as S from './stack.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let browserP = null
async function browser() {
  if (!browserP) browserP = import('playwright').then(({ chromium }) => chromium.launch({ args: ['--disable-gpu'] }))
  return browserP
}
export async function closeBrowser() { if (browserP) { const b = await browserP; browserP = null; await b.close().catch(() => {}) } }

/** A page that may only talk to the given loopback origin(s); anything else is aborted (recorded). */
async function guardedPage(b, { width, height, allow, onRoute = null, theme = 'dark' }) {
  const ctx = await b.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: theme })
  const page = await ctx.newPage()
  const stats = { aborted: [], errors: [] }
  page.on('pageerror', (e) => stats.errors.push(String(e.message).slice(0, 200)))
  await page.route('**/*', async (r) => {
    const u = new URL(r.request().url())
    if (onRoute) { const handled = await onRoute(r, u); if (handled) return }
    if (allow.some((o) => u.origin === o) || u.protocol === 'data:' || u.protocol === 'blob:') return r.continue()
    stats.aborted.push(`${r.request().method()} ${u.host}`)
    return r.abort()
  })
  return { ctx, page, stats }
}

/** Agntei → Connections → LeadCommand Workforce, on the live state. Returns the files written. */
const SCRIPTED_BANNER = 'LIVE LOCAL E2E · Agntei headless on a disposable stack · the agent is a SCRIPTED AGENT (not Claude Code)'
export async function captureAgntei({ url, token, outDir, name, connectionId = null, scrollTo = null, banner = SCRIPTED_BANNER }) {
  const b = await browser()
  const { ctx, page, stats } = await guardedPage(b, { width: 1440, height: 1100, allow: [url] })
  const files = []
  try {
    await page.goto(`${url}/#token=${token}`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await sleep(1500)
    await page.goto(`${url}/#/connections/leadcommand`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.waitForSelector('[data-testid=lcw-conn]', { timeout: 120_000 })
    await sleep(2500)
    const conn = connectionId ? page.locator('[data-testid=lcw-conn]').first() : page.locator('[data-testid=lcw-conn]').first()
    await page.evaluate((text) => {
      const d = document.createElement('div')
      d.textContent = text
      Object.assign(d.style, { position: 'fixed', left: '50%', bottom: '10px', transform: 'translateX(-50%)', zIndex: '2147483647', padding: '5px 12px', borderRadius: '8px', font: '600 11px/1.3 ui-monospace, Menlo, monospace', letterSpacing: '.04em', color: '#111', background: 'rgba(250, 204, 21, .92)', pointerEvents: 'none' })
      document.body.appendChild(d)
    }, banner)
    const top = path.join(outDir, `${name}.png`)
    await page.screenshot({ path: top, fullPage: true })
    files.push(top)
    if (scrollTo) {
      const el = conn.getByTestId(scrollTo)
      if (await el.count()) {
        await el.scrollIntoViewIfNeeded()
        await sleep(500)
        const f = path.join(outDir, `${name}-${scrollTo.replace(/^lcw-/, '')}.png`)
        await el.screenshot({ path: f })
        files.push(f)
      }
    }
    const text = await conn.innerText().catch(() => '')
    return { files, text: text.slice(0, 4000), errors: stats.errors, aborted: stats.aborted }
  } finally { await ctx.close() }
}

/** Any Agntei screen (#/chat/<id>, #/connections/…) on the live state, with a banner; full page. */
export async function captureAgnteiPage({ url, token, outDir, name, hash, waitFor = null, banner, height = 1100 }) {
  const b = await browser()
  const { ctx, page, stats } = await guardedPage(b, { width: 1440, height, allow: [url] })
  try {
    await page.goto(`${url}/#token=${token}`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await sleep(1500)
    await page.goto(`${url}/${hash}`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    if (waitFor) await page.waitForSelector(waitFor, { timeout: 60_000 }).catch(() => {})
    await sleep(3500)
    await page.evaluate((text) => {
      const d = document.createElement('div')
      d.textContent = text
      Object.assign(d.style, { position: 'fixed', left: '50%', bottom: '10px', transform: 'translateX(-50%)', zIndex: '2147483647', padding: '5px 12px', borderRadius: '8px', font: '600 11px/1.3 ui-monospace, Menlo, monospace', letterSpacing: '.04em', color: '#111', background: 'rgba(250, 204, 21, .92)', pointerEvents: 'none' })
      document.body.appendChild(d)
    }, banner)
    const f = path.join(outDir, `${name}.png`)
    await page.screenshot({ path: f, fullPage: true })
    const text = await page.locator('body').innerText().catch(() => '')
    return { files: [f], text: text.slice(0, 6000), errors: stats.errors, aborted: stats.aborted }
  } finally { await ctx.close() }
}

/** The dashboard (vite dev) on a free loopback port, LC_WF fixtures OFF, no backend: answers come from the recording. */
export async function startDashboard({ repo, node, log }) {
  const port = await S.freePort()
  const dir = path.join(repo, 'apps/dashboard')
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR || '/tmp', BROWSER: 'none', NODE_ENV: 'development' }
  const rec = S.startProcess('dashboard-vite', node, [path.join(repo, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: dir, env, log })
  const url = `http://127.0.0.1:${port}`
  await S.waitFor(async () => {
    if (rec.exited) throw new Error(`vite exited: ${fs.readFileSync(log, 'utf8').slice(-600)}`)
    return S.httpOk(`${url}/`)
  }, { timeoutMs: 240_000, intervalMs: 1000, what: 'the dashboard dev server' })
  return { url, rec }
}

/** Answer /api/cockpit/workforce/* from a recording: exact path+query, else the path. */
function recordedRoute(recorded, served) {
  const byPath = new Map()
  for (const [k, v] of Object.entries(recorded)) { const p = k.split('?')[0]; if (!byPath.has(p)) byPath.set(p, v) }
  return async (r, u) => {
    if (!u.pathname.startsWith('/api/')) return false
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return false
    if (r.request().method() !== 'GET') { served.refused.push(`${r.request().method()} ${u.pathname}`); await r.fulfill({ status: 405, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'READ_ONLY_CAPTURE' }) }); return true }
    if (u.pathname.startsWith('/api/cockpit/workforce')) {
      const rel = u.pathname.slice('/api/cockpit/workforce'.length) || '/'
      const hit = recorded[`${rel}${u.search}`] || byPath.get(rel)
      if (hit) { served.hits.push(`${rel}${u.search}`); await r.fulfill({ status: hit.status, contentType: 'application/json', body: JSON.stringify(hit.body) }); return true }
      served.misses.push(`${rel}${u.search}`)
      await r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'NOT_RECORDED' }) })
      return true
    }
    served.other.push(u.pathname)
    await r.fulfill({ status: u.pathname === '/api/cockpit/shell/telemetry' ? 503 : 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: null, items: [], rows: [], results: [] }) })
    return true
  }
}

/**
 * The three LeadCommand Workforce views of the outcome, from a recording.
 * @param {{ base: string, recorded: object, outDir: string, prefix: string, missionTitle: string, employeeName: string }} o
 */
export async function captureDashboard({ base, recorded, outDir, prefix, missionTitle, employeeName = 'Scout' }) {
  const b = await browser()
  const served = { hits: [], misses: [], other: [], refused: [] }
  const files = []
  const open = async (section) => {
    const g = await guardedPage(b, { width: 1440, height: 900, allow: [base], onRoute: recordedRoute(recorded, served) })
    await g.ctx.addInitScript(({ s }) => {
      try {
        localStorage.setItem('nexus.desktop.ultrawide.seeded', '1')
        localStorage.setItem('lc.wf.section.v1', s)
        const c = JSON.parse(localStorage.getItem('nexus-settings') || '{}')
        localStorage.setItem('nexus-settings', JSON.stringify({ ...c, nexusTheme: 'dark' }))
        sessionStorage.removeItem('lc.workspace.session.v1')
      } catch { /* ignore */ }
    }, { s: section })
    await g.page.goto(`${base}/workforce`, { waitUntil: 'domcontentloaded', timeout: 300_000 })
    await g.page.waitForSelector('.wf .wf-head', { timeout: 300_000 })
    await sleep(2500)
    return g
  }
  const shot = async (page, name) => {
    await sleep(800)
    // the label the screenshot carries: these are RECORDED answers of the real route handlers, not a live API
    await page.evaluate(() => {
      if (document.getElementById('e2e-recorded-label')) return
      const d = document.createElement('div')
      d.id = 'e2e-recorded-label'
      d.textContent = 'RECORDED FROM LOCAL E2E · Workforce route-handler responses on a disposable PostgreSQL · no live API'
      Object.assign(d.style, { position: 'fixed', left: '50%', bottom: '10px', transform: 'translateX(-50%)', zIndex: '2147483647', padding: '5px 12px', borderRadius: '8px', font: '600 11px/1.3 ui-monospace, Menlo, monospace', letterSpacing: '.04em', color: '#111', background: 'rgba(250, 204, 21, .92)', pointerEvents: 'none' })
      document.body.appendChild(d)
    })
    const f = path.join(outDir, `${prefix}-${name}.png`); await page.screenshot({ path: f }); files.push(f); return f
  }
  const goSection = async (page, label) => {
    const nav = page.locator(`.wf-nav__i[title="${label}"]`)
    if (await nav.isVisible().catch(() => false)) await nav.click()
    else await page.locator('.wf-tabs [role="tab"]', { hasText: label.split(' ')[0] }).first().click()
    await sleep(1500)
  }
  const errors = []
  try {
    // Executive Command
    { const g = await open('command'); await g.page.waitForFunction(() => document.querySelectorAll('.wf-thread .wf-msg').length > 0, null, { timeout: 60_000 }).catch(() => {}); await shot(g.page, 'executive-command'); errors.push(...g.stats.errors); await g.ctx.close() }
    // Missions → the completed mission
    {
      const g = await open('missions')
      await g.page.waitForSelector('.wf-mrow', { timeout: 60_000 }).catch(() => {})
      await g.page.evaluate((t) => { const rows = [...document.querySelectorAll('.wf-mrow')]; const b = rows.find((x) => x.textContent.includes(t)) || rows[0]; b?.scrollIntoView({ block: 'center' }); b?.click() }, missionTitle)
      await g.page.waitForSelector('.wf-report, .wf-mdetail', { timeout: 60_000 }).catch(() => {})
      await shot(g.page, 'missions-completed')
      const tab = g.page.locator('.wf-mdetail__tabs [role="tab"]', { hasText: 'Assignments' })
      if (await tab.count()) { await tab.first().click(); await g.page.evaluate(() => { const d = document.querySelector('.wf-missions__detail'); const t = document.querySelector('.wf-mdetail__tabs'); if (d && t) d.scrollTo({ top: t.offsetTop - 40 }) }); await shot(g.page, 'missions-assignments') }
      errors.push(...g.stats.errors); await g.ctx.close()
    }
    // Employees → the Agntei employee → History
    {
      const g = await open('employees')
      await g.page.waitForSelector('.wf-emps [role="row"], .wf-emps', { timeout: 60_000 }).catch(() => {})
      await shot(g.page, 'employees')
      const rowEl = g.page.locator('.wf-emps [role="row"]', { hasText: employeeName }).first()
      if (await rowEl.count()) {
        await rowEl.click()
        await g.page.waitForSelector('.lc-insp', { timeout: 60_000 }).catch(() => {})
        await shot(g.page, 'employee-profile')
        const hist = g.page.locator('.lc-insp [role="tab"]', { hasText: 'History' })
        if (await hist.count()) { await hist.first().click(); await sleep(900); await shot(g.page, 'employee-history') }
      }
      errors.push(...g.stats.errors); await g.ctx.close()
    }
  } catch (e) { errors.push(String(e?.message || e).slice(0, 300)) }
  return { files, served: { hits: [...new Set(served.hits)], misses: [...new Set(served.misses)], refused: served.refused, other: [...new Set(served.other)].slice(0, 20) }, errors }
}

export { sleep as uiSleep }
